'use strict';

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

// Never load deployment .env files or use a configured database/credential.
// Importing the service does not start its server, workers or DB connection.
const TEST_SECRET = 'isolated-scheduled-endpoint-test-secret';
const dotenv = require('dotenv');
const originalDotenvConfig = dotenv.config;
dotenv.config = () => ({ parsed: {} });
process.env.JWT_SECRET = TEST_SECRET;
process.env.REDIS_URL = '';
process.env.MAPBOX_ACCESS_TOKEN = '';
process.env.MAPBOX_PUBLIC_TOKEN = '';
process.env.MAPBOX_TOKEN = '';
process.env.RESEND_API_KEY = '';
process.env.PAYMENT_CONFIG_ENCRYPTION_KEY = 'isolated-scheduled-test-encryption-key';
let service;
try {
  service = require('../server');
} finally {
  dotenv.config = originalDotenvConfig;
}
const { app, models, io, FARE_VEHICLE_CATEGORIES } = service;
const CATEGORY = 'Car Mini Non-AC';
const SESSION = 'scheduled-test-session';
const pickup = { lat: 31.5204, lng: 74.3587, address: 'Test pickup street, Lahore' };
const dropoff = { lat: 31.5404, lng: 74.3787, address: 'Test dropoff street, Lahore' };
const nativeFetch = global.fetch;
const originalTo = io.to;
let mongo, httpServer, emissions, customer, outsider;

before(async () => {
  // Cold mongod startup on shared CI hosts can exceed the library's 10-second
  // default. Keep this bounded without replacing real Mongo endpoint tests.
  mongo = await MongoMemoryReplSet.create({
    replSet: { count: 1 },
    instanceOpts: [{ launchTimeout: 120_000 }]
  });
  await mongoose.connect(mongo.getUri('scheduled_endpoint_tests'));
  httpServer = app.listen(0, '127.0.0.1');
  await new Promise(resolve => httpServer.once('listening', resolve));
  // Endpoint requests are real HTTP. Fail any accidental external provider
  // request rather than allowing geocoding/push to touch production services.
  global.fetch = (url, options) => {
    assert.equal(new URL(String(url)).hostname, '127.0.0.1', 'external HTTP is forbidden in this isolated suite');
    return nativeFetch(url, options);
  };
  io.to = room => ({
    emit(event, payload) {
      emissions.push({ room, event, payload: JSON.parse(JSON.stringify(payload)) });
    }
  });
}, { timeout: 180_000 });

beforeEach(async () => {
  emissions = [];
  await Promise.all([
    models.AdvanceBooking, models.Ride, models.Driver, models.Customer,
    models.LegacyUser, models.Settings, models.Wallet, models.PushSub,
    models.Admin, models.SubAdmin, models.ScheduledDriverAssignmentLock
  ].map(model => model.deleteMany({})));
  await models.Settings.create([
    {
      key: 'daily_fare_settings',
      value: Object.fromEntries(FARE_VEHICLE_CATEGORIES.map(category => [category, {
        baseFare: 100, distanceSlabs: [{ minKm: 0, maxKm: null, rate: 50 }], peakRules: []
      }]))
    },
    { key: 'daily_fee_settings', value: Object.fromEntries(FARE_VEHICLE_CATEGORIES.map(category => [category, 100])) }
  ]);
  customer = await createParticipant('customer');
  outsider = await createParticipant('customer');
});

after(async () => {
  io.to = originalTo;
  global.fetch = nativeFetch;
  if (httpServer) await new Promise(resolve => httpServer.close(resolve));
  await mongoose.disconnect();
  if (mongo) await mongo.stop();
});

async function createParticipant(role, overrides = {}, partition) {
  const value = {
    _id: new mongoose.Types.ObjectId(),
    name: role === 'driver' ? 'Scheduled Test Driver' : 'Scheduled Test Customer',
    role, accountStatus: 'active', activeSessionToken: SESSION,
    phone: role === 'driver' ? '+92 301 1234567' : '0300-1234567',
    ...(role === 'driver' ? {
      vehicleType: CATEGORY, vehicleModel: 'Test vehicle model', vehiclePlate: 'TEST-101',
      profilePhoto: '/uploads/test-profile.jpg', rating: 4.8, ridePreference: 'Both',
      isOnline: true, lastOnlineHeartbeat: new Date(),
      paidUntilDate: new Date(Date.now() + 86_400_000)
    } : {}),
    ...overrides
  };
  await (partition || (role === 'driver' ? models.Driver : models.Customer)).collection.insertOne(value);
  return value;
}

async function request(actor, path, method = 'GET', body) {
  const claims = actor === 'admin'
    ? { isAdmin: true, adminSessionVersion: 0 }
    : actor.claims || { id: String(actor._id), role: actor.role };
  const response = await fetch(`http://127.0.0.1:${httpServer.address().port}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${jwt.sign(claims, TEST_SECRET)}`,
      'x-session-token': SESSION,
      'content-type': 'application/json'
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return { status: response.status, body: await response.json() };
}

function bookingBody(overrides = {}) {
  return {
    pickupLocation: pickup, dropoffLocation: dropoff,
    dropoffLocations: [dropoff, { ...dropoff, address: 'Second test stop street, Lahore' }],
    scheduledFor: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
    distance: 5, durationMinutes: 20, vehicleType: CATEGORY,
    passengerCount: 3, notes: 'Test scheduled pickup', paymentMethod: 'cash',
    ...overrides
  };
}

async function createBooking(overrides = {}) {
  const result = await request(customer, '/api/advance-bookings', 'POST', bookingBody(overrides));
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return result.body;
}

function assignmentEventsFor(id) {
  return emissions.filter(item => item.event === 'advance-booking:assigned' && item.room === `user:${id}`);
}

test('create immediately persists and broadcasts to every compatible online Driver regardless of proximity, GPS, wallet or preference', async () => {
  const near = await createParticipant('driver', { currentLocation: pickup });
  const far = await createParticipant('driver', {
    currentLocation: { lat: 24.8607, lng: 67.0011 }, ridePreference: 'Long Range Only', longRangeEnabled: false
  });
  const noGps = await createParticipant('driver', { vehicleType: 'Car Mini' });
  const legacyPartition = await createParticipant('driver', {}, models.Customer);
  const excluded = await Promise.all([
    createParticipant('driver', { isOnline: false }),
    createParticipant('driver', { vehicleType: 'Bike' }),
    createParticipant('driver', { accountStatus: 'suspended' }),
    createParticipant('driver', { lastOnlineHeartbeat: new Date(0) })
  ]);
  const booking = await createBooking();
  const recipients = [near, far, noGps, legacyPartition].map(driver => String(driver._id)).sort();
  const stored = await models.AdvanceBooking.findById(booking.id).lean();
  assert.equal(stored.status, 'pending');
  assert.equal(stored.driver, null);
  assert.deepEqual(stored.notifiedDriverIds.map(String).sort(), recipients);
  assert.equal(await models.Wallet.countDocuments(), 0, 'broadcast must not require Wallet records');
  const alerts = emissions.filter(item => item.event === 'advance-booking:new' && item.room.startsWith('user:'));
  assert.deepEqual(alerts.map(item => item.room).sort(), recipients.map(id => `user:${id}`).sort());
  for (const event of alerts) {
    assert.equal(event.payload.id, booking.id);
    assert.equal(event.payload.advanceBookingId, booking.id);
    assert.equal(event.payload.scheduledFor, booking.scheduledFor);
    assert.equal(event.payload.pickupLocation.address, pickup.address);
    assert.equal(event.payload.dropoffLocations.length, 2);
    assert.equal(event.payload.passengerCount, 3);
    assert.equal(event.payload.fare, booking.fare);
    assert.equal(event.payload.passenger.phone, undefined, 'unassigned audience must not receive Customer contact');
  }
  const adminNew = emissions.filter(item => item.event === 'advance-booking:new' && item.room === 'admin-room');
  assert.equal(adminNew.length, 1, 'Admin gets an immediate freshness event after persistence');
  assert.equal(adminNew[0].payload.id, booking.id);
  assert.deepEqual(adminNew[0].payload.notifiedDriverIds.map(String).sort(), recipients);
  for (const driver of [near, far, noGps, legacyPartition]) {
    const feed = await request(driver, '/api/advance-bookings/available');
    assert.equal(feed.status, 200);
    assert.ok(feed.body.some(item => item.id === booking.id));
    assert.equal(feed.body.find(item => item.id === booking.id).passenger.phone, undefined);
  }
  for (const driver of excluded) {
    assert.ok(!alerts.some(item => item.room === `user:${driver._id}`));
  }
});

for (const assignment of ['direct', 'admin']) {
  for (const contactSource of ['primary', 'legacy-phone', 'legacy-partition']) {
    test(`${assignment} assignment immediately confirms full Driver details, contact and pickup time (${contactSource})`, async () => {
      const driver = await createParticipant('driver',
        { phone: contactSource === 'primary' ? '0092 301 1234567' : 'invalid' },
        contactSource === 'legacy-partition' ? models.Customer : undefined);
      const losingDriver = await createParticipant('driver');
      if (contactSource !== 'primary') {
        await models.LegacyUser.collection.insertOne({
          _id: driver._id, role: 'driver', phone: '+92 301 1234567',
          name: 'Stale legacy profile name', vehicleType: CATEGORY, vehicleModel: driver.vehicleModel,
          vehiclePlate: driver.vehiclePlate, rating: driver.rating, profilePhoto: driver.profilePhoto
        });
      }
      const booking = await createBooking();
      emissions = [];
      const response = assignment === 'direct'
        ? await request(driver, `/api/advance-bookings/${booking.id}/accept`, 'PATCH', {})
        : await request('admin', `/api/admin/advance-bookings/${booking.id}/assign`, 'PATCH', { driverId: String(driver._id) });
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.equal(response.body.status, 'assigned');
      assert.equal(response.body.driver.id, String(driver._id));
      assert.equal(response.body.driver.name, driver.name);
      assert.equal(response.body.driver.phone, '+923011234567');
      assert.equal(response.body.driver.vehicleType, CATEGORY);
      assert.equal(response.body.driver.vehicleModel, driver.vehicleModel);
      assert.equal(response.body.driver.vehiclePlate, driver.vehiclePlate);
      assert.equal(response.body.driver.rating, driver.rating);
      assert.equal(response.body.driver.profilePhoto, driver.profilePhoto);
      assert.equal(response.body.passenger.phone, '+923001234567');
      assert.equal(response.body.scheduledFor, booking.scheduledFor);
      assert.deepEqual(response.body.pickupLocation, booking.pickupLocation);
      assert.equal(response.body.fare, booking.fare);
      assert.ok(response.body.assignedAt);
      const stored = await models.AdvanceBooking.findById(booking.id).lean();
      assert.equal(String(stored.driver), String(driver._id));
      assert.equal(stored.status, 'assigned');
      assert.equal(await models.Ride.countDocuments(), 0, 'assignment is a reservation, not early ride activation');
      assert.equal(assignmentEventsFor(customer._id).length, 1, 'Customer must be immediately updated without choosing again');
      assert.equal(assignmentEventsFor(customer._id)[0].payload.driver.phone, '+923011234567');
      assert.equal(assignmentEventsFor(driver._id)[0].payload.driver.id, String(driver._id));
      assert.equal(assignmentEventsFor(driver._id)[0].payload.passenger.phone, '+923001234567');
      const lost = assignmentEventsFor(losingDriver._id);
      assert.equal(lost.length, 1);
      assert.equal(lost[0].payload.passenger, undefined);
      assert.equal(lost[0].payload.driver, undefined);
      assert.equal(lost[0].payload.counterOffers, undefined);
      const history = await request(customer, '/api/advance-bookings/my');
      const mine = history.body.find(item => item.id === booking.id);
      assert.equal(mine.driver.phone, '+923011234567');
      assert.equal(mine.driver.profilePhoto, driver.profilePhoto);
      assert.equal(mine.scheduledFor, booking.scheduledFor);
      assert.deepEqual((await request(outsider, '/api/advance-bookings/my')).body, []);
      assert.deepEqual((await request(losingDriver, '/api/advance-bookings/my')).body, []);
      const driverFeed = await request(driver, '/api/advance-bookings/available');
      assert.equal(driverFeed.body.find(item => item.id === booking.id).passenger.phone, '+923001234567');
      const secondCustomerSelection = await request(customer, `/api/advance-bookings/${booking.id}/accept-driver`, 'PATCH', { driverId: String(driver._id) });
      assert.equal(secondCustomerSelection.status, 409, 'direct/Admin assignment must not depend on Customer selection');
    });
  }
}

test('Admin options and assign consistently exclude active rides, assigned/dispatching overlap, offline/stale, mismatched, preference and fee-ineligible Drivers', async () => {
  const free = await createParticipant('driver');
  const busy = await createParticipant('driver');
  const overlapping = await createParticipant('driver');
  const dispatching = await createParticipant('driver');
  const offline = await createParticipant('driver', { isOnline: false });
  const stale = await createParticipant('driver', { lastOnlineHeartbeat: new Date(0) });
  const wrongVehicle = await createParticipant('driver', { vehicleType: 'Bike' });
  const wrongPreference = await createParticipant('driver', { ridePreference: 'Long Range Only' });
  const unpaid = await createParticipant('driver', { paidUntilDate: new Date(0) });
  const booking = await createBooking();
  await models.Ride.collection.insertOne({ driver: busy._id, passenger: customer._id, status: 'accepted' });
  await models.AdvanceBooking.collection.insertMany([
    { passenger: customer._id, driver: overlapping._id, status: 'assigned', scheduledFor: new Date(booking.scheduledFor) },
    { passenger: customer._id, driver: dispatching._id, status: 'dispatching', scheduledFor: new Date(booking.scheduledFor) }
  ]);
  const options = await request('admin', `/api/admin/advance-bookings/${booking.id}/assignment-options`);
  assert.equal(options.status, 200, JSON.stringify(options.body));
  assert.deepEqual(options.body.map(driver => driver.id), [String(free._id)]);
  for (const driver of [busy, overlapping, dispatching, offline, stale, wrongVehicle, wrongPreference, unpaid]) {
    const result = await request('admin', `/api/admin/advance-bookings/${booking.id}/assign`, 'PATCH', { driverId: String(driver._id) });
    assert.equal(result.status, driver === unpaid ? 403 : 409, JSON.stringify(result.body));
  }
  for (const driver of [busy, overlapping, dispatching]) {
    const result = await request(driver, `/api/advance-bookings/${booking.id}/accept`, 'PATCH', {});
    assert.equal(result.status, 409, 'direct acceptance must enforce the same conflict check');
  }
  assert.equal((await models.AdvanceBooking.findById(booking.id).lean()).status, 'pending');
  // Eligibility is revalidated at assignment time, not trusted from the menu.
  await models.Driver.collection.updateOne({ _id: free._id }, { $set: { isOnline: false } });
  assert.equal((await request('admin', `/api/admin/advance-bookings/${booking.id}/assign`, 'PATCH', { driverId: String(free._id) })).status, 409);
  await models.AdvanceBooking.collection.updateOne({ _id: new mongoose.Types.ObjectId(booking.id) }, { $set: { scheduledFor: new Date(0) } });
  assert.equal((await request('admin', `/api/admin/advance-bookings/${booking.id}/assignment-options`)).status, 409);
});

test('competing direct accepts and Admin assign produce exactly one atomic winner and one Customer confirmation', async () => {
  const directA = await createParticipant('driver');
  const directB = await createParticipant('driver');
  const adminDriver = await createParticipant('driver');
  const booking = await createBooking();
  emissions = [];
  const results = await Promise.all([
    request(directA, `/api/advance-bookings/${booking.id}/accept`, 'PATCH', {}),
    request(directB, `/api/advance-bookings/${booking.id}/accept`, 'PATCH', {}),
    request('admin', `/api/admin/advance-bookings/${booking.id}/assign`, 'PATCH', { driverId: String(adminDriver._id) })
  ]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409, 409]);
  const winner = results.find(result => result.status === 200).body;
  const stored = await models.AdvanceBooking.findById(booking.id).lean();
  assert.equal(stored.status, 'assigned');
  assert.equal(String(stored.driver), winner.driver.id);
  const customerEvents = assignmentEventsFor(customer._id);
  assert.equal(customerEvents.length, 1);
  assert.equal(customerEvents[0].payload.driver.id, winner.driver.id);
  assert.equal(customerEvents[0].payload.scheduledFor, booking.scheduledFor);
  assert.equal(emissions.filter(item => item.event === 'advance-booking:assigned' && item.room === 'admin-room').length, 1);
});

test('direct accept uses the Customer fare even after a counteroffer; counters alone remain pending until chosen', async () => {
  const driver = await createParticipant('driver');
  let booking = await createBooking();
  const counter = await request(driver, `/api/advance-bookings/${booking.id}/counter`, 'PATCH', { price: booking.fare + 200 });
  assert.equal(counter.status, 200);
  assert.equal(counter.body.status, 'pending');
  assert.equal(counter.body.driver, null);
  assert.equal(assignmentEventsFor(customer._id).length, 0);
  const accepted = await request(driver, `/api/advance-bookings/${booking.id}/accept`, 'PATCH', {});
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.equal(accepted.body.fare, booking.fare);
  assert.equal(accepted.body.counterOffers.find(item => item.driver === String(driver._id)).type, 'accept');
  // Use a non-overlapping future reservation to exercise separate negotiation.
  booking = await createBooking({ scheduledFor: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString() });
  await request(driver, `/api/advance-bookings/${booking.id}/counter`, 'PATCH', { price: booking.fare + 300 });
  emissions = [];
  const selected = await request(customer, `/api/advance-bookings/${booking.id}/accept-driver`, 'PATCH', { driverId: String(driver._id) });
  assert.equal(selected.status, 200, JSON.stringify(selected.body));
  assert.equal(selected.body.fare, booking.fare + 300);
  assert.equal(assignmentEventsFor(customer._id).length, 1);
});

test('wrong roles, other Customers, unauthorized Admins, offline/stale and fee-ineligible Drivers cannot assign', async () => {
  const driver = await createParticipant('driver');
  const wrongVehicle = await createParticipant('driver', { vehicleType: 'Bike' });
  const booking = await createBooking();
  const unauthorizedSub = await models.SubAdmin.create({ username: 'test-no-permissions', password: 'unused', permissions: {} });
  const subActor = { claims: { isSubAdmin: true, subAdminId: String(unauthorizedSub._id) } };
  const patch = { driverId: String(driver._id) };
  for (const actor of [customer, driver, subActor]) {
    assert.equal((await request(actor, `/api/admin/advance-bookings/${booking.id}/assignment-options`)).status, 403);
    assert.equal((await request(actor, `/api/admin/advance-bookings/${booking.id}/assign`, 'PATCH', patch)).status, 403);
  }
  assert.equal((await request('admin', '/api/advance-bookings/my')).status, 403);
  const unauthenticated = await fetch(`http://127.0.0.1:${httpServer.address().port}/api/admin/advance-bookings/${booking.id}/assignment-options`);
  assert.equal(unauthenticated.status, 401);
  assert.equal((await request(customer, `/api/advance-bookings/${booking.id}/accept`, 'PATCH', {})).status, 403);
  assert.equal((await request(outsider, `/api/advance-bookings/${booking.id}/accept-driver`, 'PATCH', patch)).status, 409);
  assert.equal((await request(wrongVehicle, `/api/advance-bookings/${booking.id}/accept`, 'PATCH', {})).status, 409);
  await models.Driver.collection.updateOne({ _id: driver._id }, { $set: { isOnline: false } });
  assert.equal((await request(driver, `/api/advance-bookings/${booking.id}/accept`, 'PATCH', {})).status, 403);
  await models.Driver.collection.updateOne({ _id: driver._id }, { $set: { isOnline: true, lastOnlineHeartbeat: new Date(0) } });
  assert.equal((await request(driver, `/api/advance-bookings/${booking.id}/accept`, 'PATCH', {})).status, 403);
  await models.Driver.collection.updateOne({ _id: driver._id }, { $set: { lastOnlineHeartbeat: new Date(), paidUntilDate: new Date(0) } });
  const unpaid = await request(driver, `/api/advance-bookings/${booking.id}/accept`, 'PATCH', {});
  assert.equal(unpaid.status, 403);
  assert.equal(unpaid.body.code, 'DAILY_FEE_REQUIRED');
  assert.equal((await models.AdvanceBooking.findById(booking.id).lean()).status, 'pending');
  assert.equal(assignmentEventsFor(customer._id).length, 0);
});

test('scheduled participant responses never promote invalid or wrong-role legacy phone values', async () => {
  const driver = await createParticipant('driver', { phone: 'invalid' });
  await models.LegacyUser.collection.insertOne({ _id: driver._id, role: 'customer', phone: '03011234567' });
  const booking = await createBooking();
  const assigned = await request(driver, `/api/advance-bookings/${booking.id}/accept`, 'PATCH', {});
  assert.equal(assigned.status, 200, JSON.stringify(assigned.body));
  assert.equal(assigned.body.driver.phone, '');
  assert.equal(assigned.body.driver.vehiclePlate, driver.vehiclePlate);
  assert.equal(assignmentEventsFor(customer._id)[0].payload.driver.phone, '');
  const history = await request(customer, '/api/advance-bookings/my');
  assert.equal(history.body[0].driver.phone, '');
});

test('Admin all-status bounded list keeps upcoming pending/assigned bookings visible ahead of a long history', async () => {
  const driver = await createParticipant('driver');
  const pending = await createBooking();
  const assigned = await createBooking({ scheduledFor: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString() });
  assert.equal((await request('admin', `/api/admin/advance-bookings/${assigned.id}/assign`, 'PATCH', { driverId: String(driver._id) })).status, 200);
  const historical = Array.from({ length: 505 }, (_, index) => ({
    passenger: customer._id, driver: null, vehicleType: CATEGORY, status: 'cancelled',
    scheduledFor: new Date(Date.now() - (index + 1) * 86_400_000),
    pickupLocation: pickup, dropoffLocation: dropoff, fare: 350, createdAt: new Date()
  }));
  await models.AdvanceBooking.collection.insertMany(historical);
  const result = await request('admin', '/api/admin/advance-bookings?status=all');
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.length, 500);
  assert.deepEqual(result.body.slice(0, 2).map(booking => booking.id), [pending.id, assigned.id]);
  assert.equal(result.body[0].status, 'pending');
  assert.equal(result.body[1].status, 'assigned');
  assert.ok(new Date(result.body[2].scheduledFor) > new Date(result.body[3].scheduledFor), 'remaining history is newest first');
  const pendingOnly = await request('admin', '/api/admin/advance-bookings?status=pending');
  assert.deepEqual(pendingOnly.body.map(booking => booking.id), [pending.id]);
  const futureDate = new Date(Date.now() + 30 * 86_400_000).toISOString();
  assert.deepEqual((await request('admin', `/api/admin/advance-bookings?status=all&from=${encodeURIComponent(futureDate)}`)).body, []);
});

for (const [firstPath, secondPath] of [
  ['direct', 'direct'], ['direct', 'admin'], ['admin', 'admin'],
  ['customer', 'direct'], ['customer', 'admin'], ['customer', 'customer']
]) {
  test(`persisted Driver lock allows only one overlapping booking across concurrent ${firstPath}/${secondPath} assignments`, async () => {
    const driver = await createParticipant('driver');
    const first = await createBooking();
    const second = await createBooking({
      scheduledFor: new Date(new Date(first.scheduledFor).getTime() + 30 * 60_000).toISOString()
    });
    async function assign(path, booking) {
      if (path === 'direct') return request(driver, `/api/advance-bookings/${booking.id}/accept`, 'PATCH', {});
      if (path === 'admin') return request('admin', `/api/admin/advance-bookings/${booking.id}/assign`, 'PATCH', { driverId: String(driver._id) });
      return request(customer, `/api/advance-bookings/${booking.id}/accept-driver`, 'PATCH', { driverId: String(driver._id) });
    }
    for (const [path, booking] of [[firstPath, first], [secondPath, second]]) {
      if (path === 'customer') {
        assert.equal((await request(driver, `/api/advance-bookings/${booking.id}/counter`, 'PATCH', { price: booking.fare + 50 })).status, 200);
      }
    }
    // Coordinate arrival at the real DB lock write, after both endpoints have
    // passed their initial availability read. No persistence operation is
    // mocked: MongoDB must serialize/retry the competing transactions.
    const originalUpdate = models.ScheduledDriverAssignmentLock.updateOne;
    let arrived = 0, release;
    const gate = new Promise(resolve => { release = resolve; });
    models.ScheduledDriverAssignmentLock.updateOne = function(filter, update, options) {
      if (options?.session && ++arrived <= 2) {
        if (arrived === 2) release();
        return gate.then(() => originalUpdate.call(this, filter, update, options));
      }
      return originalUpdate.call(this, filter, update, options);
    };
    emissions = [];
    try {
      const results = await Promise.all([assign(firstPath, first), assign(secondPath, second)]);
      assert.deepEqual(results.map(result => result.status).sort(), [200, 409], JSON.stringify(results));
      assert.ok(arrived >= 2, 'both assignments must reach the persisted serialization point');
      const stored = await models.AdvanceBooking.find({ _id: { $in: [first.id, second.id] } }).lean();
      assert.equal(stored.filter(booking => booking.status === 'assigned').length, 1);
      assert.equal(stored.filter(booking => booking.status === 'pending' && !booking.driver).length, 1);
      assert.equal(await models.AdvanceBooking.countDocuments({ driver: driver._id, status: 'assigned' }), 1);
      assert.equal(assignmentEventsFor(customer._id).length, 1);
      assert.equal(await models.ScheduledDriverAssignmentLock.countDocuments({ _id: driver._id }), 1);
    } finally {
      release();
      models.ScheduledDriverAssignmentLock.updateOne = originalUpdate;
    }
  });
}

test('persisted Driver serialization permits non-overlapping reservations and releases cancelled time windows', async () => {
  const driver = await createParticipant('driver');
  const first = await createBooking();
  const second = await createBooking({ scheduledFor: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString() });
  const results = await Promise.all([
    request(driver, `/api/advance-bookings/${first.id}/accept`, 'PATCH', {}),
    request('admin', `/api/admin/advance-bookings/${second.id}/assign`, 'PATCH', { driverId: String(driver._id) })
  ]);
  assert.deepEqual(results.map(result => result.status), [200, 200], JSON.stringify(results));
  assert.equal((await request(customer, `/api/advance-bookings/${first.id}/cancel`, 'PATCH', {})).status, 200);
  const replacement = await createBooking({ scheduledFor: first.scheduledFor });
  assert.equal((await request(driver, `/api/advance-bookings/${replacement.id}/accept`, 'PATCH', {})).status, 200);
});

test('counteroffer conditional write cannot mutate or emit pending state after Admin assignment wins', async () => {
  const counterDriver = await createParticipant('driver');
  const selectedDriver = await createParticipant('driver');
  const booking = await createBooking();
  const originalUpdate = models.AdvanceBooking.findOneAndUpdate;
  let reachedWrite, release;
  const reached = new Promise(resolve => { reachedWrite = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  models.AdvanceBooking.findOneAndUpdate = function(filter, update, options) {
    if (update.$push?.counterOffers) {
      reachedWrite();
      return gate.then(() => originalUpdate.call(this, filter, update, options));
    }
    return originalUpdate.call(this, filter, update, options);
  };
  const counterRequest = request(counterDriver, `/api/advance-bookings/${booking.id}/counter`, 'PATCH', { price: booking.fare + 50 });
  try {
    await reached;
    const assigned = await request('admin', `/api/admin/advance-bookings/${booking.id}/assign`, 'PATCH', { driverId: String(selectedDriver._id) });
    assert.equal(assigned.status, 200, JSON.stringify(assigned.body));
    release();
    const counter = await counterRequest;
    assert.equal(counter.status, 409, JSON.stringify(counter.body));
    const stored = await models.AdvanceBooking.findById(booking.id).lean();
    assert.equal(stored.status, 'assigned');
    assert.deepEqual(stored.counterOffers, []);
    assert.equal(emissions.filter(item => ['advance-booking:offer', 'advance-booking:offer-submitted'].includes(item.event)).length, 0);
  } finally {
    release();
    await counterRequest;
    models.AdvanceBooking.findOneAndUpdate = originalUpdate;
  }
});

test('counteroffer authoritative reread suppresses stale pending event when assignment follows its successful write', async () => {
  const counterDriver = await createParticipant('driver');
  const selectedDriver = await createParticipant('driver');
  const booking = await createBooking();
  const originalFind = models.AdvanceBooking.findById;
  let reachedRead, release, block = true;
  const reached = new Promise(resolve => { reachedRead = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  models.AdvanceBooking.findById = function(id, ...args) {
    if (block && String(id) === booking.id) {
      block = false;
      reachedRead();
      return gate.then(() => originalFind.call(this, id, ...args));
    }
    return originalFind.call(this, id, ...args);
  };
  const counterRequest = request(counterDriver, `/api/advance-bookings/${booking.id}/counter`, 'PATCH', { price: booking.fare + 50 });
  try {
    await reached;
    assert.equal(await models.AdvanceBooking.countDocuments({ _id: booking.id, 'counterOffers.driver': counterDriver._id }), 1);
    const assigned = await request('admin', `/api/admin/advance-bookings/${booking.id}/assign`, 'PATCH', { driverId: String(selectedDriver._id) });
    assert.equal(assigned.status, 200, JSON.stringify(assigned.body));
    release();
    assert.equal((await counterRequest).status, 409);
    assert.equal(emissions.filter(item => ['advance-booking:offer', 'advance-booking:offer-submitted'].includes(item.event)).length, 0);
  } finally {
    release();
    await counterRequest;
    models.AdvanceBooking.findById = originalFind;
  }
});

test('Customer /my retains upcoming pending and assigned bookings after more than 50 historic reservations', async () => {
  const driver = await createParticipant('driver');
  const pending = await createBooking();
  const assigned = await createBooking({ scheduledFor: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString() });
  assert.equal((await request('admin', `/api/admin/advance-bookings/${assigned.id}/assign`, 'PATCH', { driverId: String(driver._id) })).status, 200);
  await models.AdvanceBooking.collection.insertMany(Array.from({ length: 55 }, (_, index) => ({
    passenger: customer._id, driver: null, vehicleType: CATEGORY, status: 'cancelled',
    scheduledFor: new Date(Date.now() - (index + 1) * 86_400_000),
    pickupLocation: pickup, dropoffLocation: dropoff, fare: 350, createdAt: new Date()
  })));
  const result = await request(customer, '/api/advance-bookings/my');
  assert.equal(result.status, 200);
  assert.equal(result.body.length, 50);
  assert.deepEqual(result.body.slice(0, 2).map(booking => booking.id), [pending.id, assigned.id]);
  assert.equal(result.body[1].driver.phone, '+923011234567');
  assert.equal(result.body[1].driver.profilePhoto, driver.profilePhoto);
  assert.ok(new Date(result.body[2].scheduledFor) > new Date(result.body[3].scheduledFor));
  assert.deepEqual((await request(outsider, '/api/advance-bookings/my')).body, []);
});