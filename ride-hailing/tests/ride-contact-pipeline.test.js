'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { app, models, io, driverRidePayload } = require('../server');
let mongo, server, customer, driver, ride;
before(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  customer = new mongoose.Types.ObjectId();
  driver = new mongoose.Types.ObjectId();
  ride = new mongoose.Types.ObjectId();
  await models.Customer.collection.insertOne({ _id: customer, phone: '0300-1234567', activeSessionToken: 'contact-test' });
  await models.Driver.collection.insertOne({ _id: driver, phone: '+92 301 1234567', activeSessionToken: 'contact-test' });
  await models.Ride.collection.insertOne({ _id: ride, passenger: customer, driver, status: 'accepted' });
  server = app.listen(0);
});
after(async () => {
  await new Promise(resolve => server.close(resolve));
  await mongoose.disconnect();
  await mongo.stop();
});
async function request(id, role) {
  const token = jwt.sign({ id: String(id), role }, process.env.JWT_SECRET || 'ride-hailing-secret-fallback');
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/rides/${ride}/contact`, {
    headers: { authorization: `Bearer ${token}`, 'x-session-token': 'contact-test' }
  });
  return { status: response.status, body: await response.json() };
}
test('authenticated participants receive the opposite primary phone; blanks recover from legacy or fail explicitly', async () => {
  assert.equal((await request(customer, 'customer')).body.contact.phone, '+923011234567');
  assert.equal((await request(driver, 'driver')).body.contact.phone, '+923001234567');
  await models.LegacyUser.collection.insertOne({ _id: driver, role: 'driver', phone: '0092 302 1234567' });
  for (const phone of ['', '   ', null, 'invalid']) {
    await models.Driver.collection.updateOne({ _id: driver }, { $set: { phone } });
    const result = await request(customer, 'customer');
    assert.equal(result.status, 200);
    assert.equal(result.body.contact.phone, '+923021234567');
  }
  await models.Driver.collection.updateOne({ _id: driver }, { $unset: { phone: '' } });
  assert.equal((await request(customer, 'customer')).body.contact.phone, '+923021234567');
  await models.LegacyUser.collection.deleteOne({ _id: driver });
  const missing = await request(customer, 'customer');
  assert.equal(missing.status, 422);
  assert.equal(missing.body.code, 'CONTACT_PHONE_UNAVAILABLE');
  const outsider = new mongoose.Types.ObjectId();
  await models.Customer.collection.insertOne({ _id: outsider, activeSessionToken: 'contact-test' });
  assert.equal((await request(outsider, 'customer')).status, 403);
});

async function participantRequest(id, role, path, method = 'GET', body) {
  const token = jwt.sign({ id: String(id), role }, process.env.JWT_SECRET || 'ride-hailing-secret-fallback');
  const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'x-session-token': 'contact-test',
      'content-type': 'application/json'
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  return { status: response.status, body: await response.json() };
}

for (const selection of [false, true]) {
  for (const source of ['primary', 'legacy-phone', 'legacy-partition']) {
    test(`${selection ? 'offer selection' : 'direct acceptance'}: ${source} phones reach both participants through realtime and active REST`, async () => {
      const passengerId = new mongoose.Types.ObjectId();
      const driverId = new mongoose.Types.ObjectId();
      const rideId = new mongoose.Types.ObjectId();
      const ids = [passengerId, driverId];
      const customerPhone = '+923001234567';
      const driverPhone = '+923011234567';
      const useLegacy = source !== 'primary';
      const driverProfile = {
        _id: driverId, name: 'Contact Driver', role: 'driver',
        phone: useLegacy ? 'invalid' : '0092 301 1234567',
        accountStatus: 'active', isOnline: true,
        lastOnlineHeartbeat: new Date(),
        paidUntilDate: new Date(Date.now() + 86_400_000),
        vehicleType: 'Car Mini Non-AC', activeSessionToken: 'contact-test'
      };
      const emissions = [];
      const originalTo = io.to;
      try {
        await models.Customer.collection.insertOne({
          _id: passengerId, name: 'Contact Customer', role: 'customer',
          phone: useLegacy ? '   ' : '0300-1234567',
          activeSessionToken: 'contact-test'
        });
        // A partially migrated Driver can authenticate through the facade but
        // cannot be populated from the dedicated Driver collection.
        await (source === 'legacy-partition' ? models.Customer : models.Driver)
          .collection.insertOne(driverProfile);
        if (useLegacy) {
          await models.LegacyUser.collection.insertMany([
            { _id: passengerId, role: 'customer', phone: '(0300) 123-4567' },
            { _id: driverId, role: 'driver', phone: '+92 301 1234567' }
          ]);
        }
        await models.Ride.collection.insertOne({
          _id: rideId, passenger: passengerId, driver: null, status: 'requested',
          pickupLocation: { lat: 31.52, lng: 74.35, address: 'Pickup' },
          dropoffLocation: { lat: 31.53, lng: 74.36, address: 'Dropoff' },
          vehicleType: 'Car Mini Non-AC', fare: 500,
          broadcastExpiresAt: new Date(Date.now() + 60_000),
          notifiedDriverIds: [driverId],
          counterOffers: [{ driver: driverId, price: 500 }]
        });
        io.to = rooms => ({
          emit(event, payload) { emissions.push({ rooms, event, payload }); }
        });
        const acceptance = selection
          ? await participantRequest(passengerId, 'customer', `/api/rides/${rideId}/accept-driver`, 'PATCH', { driverId: String(driverId) })
          : await participantRequest(driverId, 'driver', `/api/rides/${rideId}/accept`, 'PATCH', {});
        assert.equal(acceptance.status, 200, JSON.stringify(acceptance.body));
        assert.equal(acceptance.body.contactPhone, selection ? driverPhone : customerPhone);
        assert.equal(acceptance.body.contact.phone, selection ? driverPhone : customerPhone);
        assert.equal(acceptance.body.verificationPin, undefined);
        const storedRide = await models.Ride.findById(rideId).select('passenger driver').lean();
        assert.equal(String(storedRide.passenger), String(passengerId));
        assert.equal(String(storedRide.driver), String(driverId));
        const outsider = await participantRequest(customer, 'customer', `/api/rides/${rideId}`);
        assert.equal(outsider.status, 403, 'raw-reference recovery must not authorize unrelated users');
        const accepted = emissions.filter(item => item.event === 'ride:accepted');
        assert.equal(accepted.length, 1);
        assert.ok(accepted[0].rooms.includes(`user:${passengerId}`));
        assert.ok(accepted[0].rooms.includes(`user:${driverId}`));
        assert.equal(accepted[0].payload.driver.id, String(driverId));
        assert.equal(accepted[0].payload.driver.phone, driverPhone);
        assert.equal(accepted[0].payload.passenger.phone, customerPhone);
        assert.equal(accepted[0].payload.ride.driver.phone, driverPhone);
        assert.equal(accepted[0].payload.ride.passenger.phone, customerPhone);
        assert.equal(accepted[0].payload.ride.verificationPin, undefined);
        assert.equal(accepted[0].payload.ride.contactPhone, undefined);
        assert.equal(accepted[0].payload.ride.contact, undefined);
        assert.equal(driverRidePayload(accepted[0].payload.ride).passenger.phone, customerPhone);
        const taken = emissions.find(item => item.event === 'ride:taken');
        assert.ok(taken.rooms.includes('drivers:Car Mini Non-AC'));
        assert.equal(taken.payload.driver, undefined, 'vehicle broadcast must not contain contacts');
        assert.equal(taken.payload.passenger, undefined);
        for (const status of ['accepted', 'arrived', 'in-progress']) {
          await models.Ride.collection.updateOne({ _id: rideId }, { $set: { status } });
          const customerActive = await participantRequest(passengerId, 'customer', '/api/rides/active');
          const driverActive = await participantRequest(driverId, 'driver', '/api/driver/active-ride');
          assert.equal(customerActive.status, 200);
          assert.equal(driverActive.status, 200);
          assert.equal(customerActive.body.driver.phone, driverPhone);
          assert.equal(customerActive.body.contactPhone, driverPhone);
          assert.equal(driverActive.body.ride.passenger.phone, customerPhone);
          assert.equal(driverActive.body.ride.contactPhone, customerPhone);
          for (const [id, role, phone] of [[passengerId, 'customer', driverPhone], [driverId, 'driver', customerPhone]]) {
            const snapshot = await participantRequest(id, role, `/api/rides/${rideId}`);
            assert.equal(snapshot.status, 200, JSON.stringify(snapshot.body));
            assert.equal(snapshot.body.contactPhone, phone);
            const contact = await participantRequest(id, role, `/api/rides/${rideId}/contact`);
            assert.equal(contact.status, 200);
            assert.equal(contact.body.contact.phone, phone);
          }
        }
      } finally {
        io.to = originalTo;
        await models.Ride.collection.deleteOne({ _id: rideId });
        for (const model of [models.Customer, models.Driver, models.LegacyUser]) {
          await model.collection.deleteMany({ _id: { $in: ids } });
        }
      }
    });
  }
}

test('active REST never promotes invalid populated phones when no valid contact exists', async () => {
  const passengerId = new mongoose.Types.ObjectId();
  const driverId = new mongoose.Types.ObjectId();
  const rideId = new mongoose.Types.ObjectId();
  try {
    await models.Customer.collection.insertOne({
      _id: passengerId, phone: 'invalid', activeSessionToken: 'contact-test'
    });
    await models.Driver.collection.insertOne({
      _id: driverId, phone: 'invalid', activeSessionToken: 'contact-test'
    });
    await models.Ride.collection.insertOne({
      _id: rideId, passenger: passengerId, driver: driverId, status: 'accepted'
    });
    // Wrong-role legacy entries must not satisfy the opposing contact lookup.
    await models.LegacyUser.collection.insertMany([
      { _id: passengerId, role: 'driver', phone: '03001234567' },
      { _id: driverId, role: 'customer', phone: '03011234567' }
    ]);
    for (const [id, role] of [[passengerId, 'customer'], [driverId, 'driver']]) {
      const snapshot = await participantRequest(id, role, `/api/rides/${rideId}`);
      assert.equal(snapshot.status, 200);
      assert.equal(snapshot.body.contactPhone, '');
      assert.equal(snapshot.body.contact.phone, '');
      const contact = await participantRequest(id, role, `/api/rides/${rideId}/contact`);
      assert.equal(contact.status, 422);
      assert.equal(contact.body.code, 'CONTACT_PHONE_UNAVAILABLE');
    }
  } finally {
    await models.Ride.collection.deleteOne({ _id: rideId });
    for (const model of [models.Customer, models.Driver, models.LegacyUser]) {
      await model.collection.deleteMany({ _id: { $in: [passengerId, driverId] } });
    }
  }
});

for (const role of ['customer', 'driver']) {
  const isCustomer = role === 'customer';
  const handler = isCustomer ? 'openCustomerRideContact' : 'openDriverRideContact';
  const extractor = isCustomer ? 'extractCustomerDriverPhone' : 'extractDriverPassengerPhone';
  const participant = isCustomer ? 'driver' : 'passenger';
  const end = isCustomer ? 'function showMatchedPanel' : 'function showActivePanel';
  const html = fs.readFileSync(`${__dirname}/../public/${role}.html`, 'utf8');
  const code = html.slice(html.indexOf(`function ${handler}`), html.indexOf(end));
  test(`${role}: real handler preserves valid state, normalizes links and ignores stale responses`, async () => {
    let resolve, response = {}, requests = 0;
    const context = vm.createContext({
      console: { warn() {} }, window: { location: { href: '' } },
      activeRide: { _id: 'ride-1', [participant]: { phone: '0300-1234567' } },
      activeDriverInfo: null, showToast() {},
      apiCall: async () => { requests++; return response; }
    });
    vm.runInContext(code, context);
    for (const value of ['03001234567', '+923001234567', '00923001234567', '92 300 1234567', '(0300) 123-4567']) {
      assert.equal(context[extractor](value).whatsapp, '923001234567');
    }
    for (const value of ['', null, undefined, 'abc03001234567', '030012345678', '+12345678901', {}]) {
      assert.equal(context[extractor](value), null);
    }
    for (const phone of ['', '   ', null, undefined, 'invalid', '+92 300 1234567']) {
      response = { contact: { phone } };
      context[handler]({ preventDefault() {} }, { dataset: { contactAction: 'whatsapp' } });
      await new Promise(setImmediate);
      assert.equal(context.activeRide[participant].phone, '+923001234567');
      assert.equal(context.window.location.href, 'https://wa.me/923001234567');
    }
    context[handler](null, { dataset: { contactAction: 'call' } });
    await new Promise(setImmediate);
    assert.equal(context.window.location.href, 'tel:+923001234567');
    assert.equal(requests, 0, 'known contact numbers launch without waiting for an API call');
    context.activeRide = { _id: 'ride-1', [participant]: { id: 'participant-1', phone: '' } };
    context.apiCall = () => new Promise(r => { resolve = r; });
    context[handler](null, { dataset: { contactAction: 'call' } });
    context.activeRide = { _id: 'ride-2' };
    context.window.location.href = '';
    resolve({ contact: { phone: '03031234567' } });
    await new Promise(setImmediate);
    assert.equal(context.window.location.href, '');
    assert.equal(context.activeRide._id, 'ride-2');
  });
}