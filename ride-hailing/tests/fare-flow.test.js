'use strict';

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

const fare = require('../server');
const {
  app, io, models, FARE_VEHICLE_CATEGORIES, DEFAULT_PER_KM_RATES,
  DEFAULT_RIDE_BROADCAST_RADIUS_KM, normalizeRideBroadcastSettings,
  validateRideBroadcastSettings, findRideBroadcastDrivers, emitRideRequestToDrivers, chargeLongRangeCommission,
  normalizeLongRangeSettings, validateLongRangeSettings, calculateRideFare
} = fare;

const JWT_SECRET = 'ride-hailing-secret-fallback';
const originalSettings = {
  findOne: models.Settings.findOne,
  findOneAndUpdate: models.Settings.findOneAndUpdate
};
const originalRide = {
  create: models.Ride.create,
  find: models.Ride.find,
  updateOne: models.Ride.updateOne
};
const originalIoTo = io.to;
const originalUserFind = models.User.find;
const originalUserFindById = models.User.findById;
const originalWalletFind = models.Wallet.find;
const originalWalletUpdate = models.Wallet.findOneAndUpdate;
const originalWalletExists = models.Wallet.exists;

afterEach(() => {
  models.Settings.findOne = originalSettings.findOne;
  models.Settings.findOneAndUpdate = originalSettings.findOneAndUpdate;
  models.Ride.create = originalRide.create;
  models.Ride.find = originalRide.find;
  models.Ride.updateOne = originalRide.updateOne;
  models.User.find = originalUserFind;
  models.User.findById = originalUserFindById;
  models.Wallet.find = originalWalletFind;
  models.Wallet.findOneAndUpdate = originalWalletUpdate;
  models.Wallet.exists = originalWalletExists;
  io.to = originalIoTo;
});

function settingsFor(baseFare, rate = 100) {
  return Object.fromEntries(FARE_VEHICLE_CATEGORIES.map(category => [category, {
    baseFare,
    distanceSlabs: [{ minKm: 0, maxKm: null, rate }],
    peakRules: []
  }]));
}

function adminToken() {
  return jwt.sign({ id: 'admin-1', isAdmin: true, email: 'admin@example.test' }, JWT_SECRET);
}

function customerToken() {
  return jwt.sign({ id: 'customer-1', role: 'customer', name: 'Customer' }, JWT_SECRET);
}

function driverToken() {
  return jwt.sign({ id: 'driver-1', role: 'driver', name: 'Driver' }, JWT_SECRET);
}

async function request(server, path, options = {}) {
  const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) }
  });
  return { response, body: await response.json() };
}

test('Admin fare settings persist every vehicle category and reject gaps or overlaps', async () => {
  let stored;
  models.Settings.findOneAndUpdate = async (_query, update) => {
    stored = update.value;
    return { value: stored };
  };
  models.Settings.findOne = () => ({ lean: async () => null });
  models.Ride.find = async () => [];

  const server = app.listen(0);
  try {
    const valid = settingsFor(250);
    const saved = await request(server, '/api/admin/fare-settings', {
      method: 'PATCH',
      headers: { authorization: `Bearer ${adminToken()}` },
      body: JSON.stringify({ dailyFareSettings: valid })
    });
    assert.equal(saved.response.status, 200);
    assert.deepEqual(Object.keys(stored), FARE_VEHICLE_CATEGORIES);

    const invalid = settingsFor(250);
    invalid['Car Sedan'].distanceSlabs = [
      { minKm: 0, maxKm: 5, rate: 100 },
      { minKm: 4, maxKm: null, rate: 200 }
    ];
    const rejected = await request(server, '/api/admin/fare-settings', {
      method: 'PATCH',
      headers: { authorization: `Bearer ${adminToken()}` },
      body: JSON.stringify({ dailyFareSettings: invalid })
    });
    assert.equal(rejected.response.status, 422);
    assert.match(rejected.body.errors.join(' '), /overlap/);

    invalid['Car Sedan'].distanceSlabs = [
      { minKm: 0, maxKm: 5, rate: 100 },
      { minKm: 6, maxKm: null, rate: 200 }
    ];
    const gap = await request(server, '/api/admin/fare-settings', {
      method: 'PATCH',
      headers: { authorization: `Bearer ${adminToken()}` },
      body: JSON.stringify({ dailyFareSettings: invalid })
    });
    assert.equal(gap.response.status, 422);
    assert.match(gap.body.errors.join(' '), /gaps/);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('Long Range fares begin at the configured cutoff and use vehicle-specific rates', () => {
  const longRange = normalizeLongRangeSettings({
    enabled: true, distanceCutoffKm: 50, minimumWalletBalance: 750, broadcastRadiusKm: 35,
    commissionPercent: 12.5, commissionTiming: 'started',
    perKmRates: Object.fromEntries(FARE_VEHICLE_CATEGORIES.map(category => [category, 210]))
  });
  assert.equal(validateLongRangeSettings(longRange).errors.length, 0);
  const local = calculateRideFare(settingsFor(300, 100), longRange, 'Car Mini', 49.99, new Date(), DEFAULT_PER_KM_RATES);
  const long = calculateRideFare(settingsFor(300, 100), longRange, 'Car Mini', 50, new Date(), DEFAULT_PER_KM_RATES);
  assert.equal(local.isLongRange, undefined);
  assert.equal(long.isLongRange, true);
  assert.equal(long.longRangeRatePerKm, 210);
  assert.equal(long.totalFare, 10500);
  const invalid = validateLongRangeSettings({ enabled: true, perKmRates: {} });
  assert.equal(invalid.errors.length, FARE_VEHICLE_CATEGORIES.length);
});

test('Long Range commission uses one wallet debit when the charge is retried', async () => {
  const updates = [];
  let debitAttempt = 0;
  models.Wallet.findOneAndUpdate = async () => {
    debitAttempt++;
    return debitAttempt === 1 ? { balance: 900 } : null;
  };
  models.Wallet.exists = async () => debitAttempt > 1;
  models.Ride.updateOne = async (_query, update) => { updates.push(update); };
  const ride = { _id: 'long-range-ride', isLongRange: true, fare: 1000, longRangeCommissionChargedAt: null };
  const settings = { commissionTiming: 'accepted', commissionPercent: 10 };
  assert.equal((await chargeLongRangeCommission(ride, 'driver-1', 'accepted', settings)).ok, true);
  assert.equal((await chargeLongRangeCommission(ride, 'driver-1', 'accepted', settings)).ok, true);
  assert.equal(debitAttempt, 2);
  assert.equal(updates.length, 2);
  assert.equal(updates[0].$set.longRangeCommissionAmount, 100);
});

test('ride creation uses the server-calculated fare, not a client amount', async () => {
  const settings = settingsFor(300, 125);
  models.Settings.findOne = ({ key }) => ({
    lean: async () => ({ value: key === 'per_km_rates' ? DEFAULT_PER_KM_RATES : settings })
  });
  let created;
  models.Ride.create = async input => {
    created = {
      ...input,
      _id: 'ride-1',
      createdAt: new Date(),
      save: async function save() { return this; }
    };
    return created;
  };
  io.to = () => ({ emit() {} });

  const server = app.listen(0);
  try {
    const result = await request(server, '/api/rides', {
      method: 'POST',
      headers: { authorization: `Bearer ${customerToken()}` },
      body: JSON.stringify({
        pickupLocation: { lat: 1, lng: 2 },
        dropoffLocation: { lat: 3, lng: 4 },
        distance: 7,
        vehicleType: 'Car Mini',
        fare: 1
      })
    });
    assert.equal(result.response.status, 201);
    assert.equal(created.fare, 650);
    assert.equal(created.fareQuote.totalFare, 650);
    assert.equal(result.body.fare, 650);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('refreshing a pending ride emits the new fare to its customer and normalized driver room', async () => {
  const ride = {
    _id: 'ride-2',
    status: 'requested',
    passenger: 'customer-1',
    vehicleType: 'Rickshaw',
    distance: 7,
    fare: 100,
    fareQuote: null,
    save: async function save() { return this; }
  };
  models.Ride.find = async () => [ride];
  models.Settings.findOne = ({ key }) => ({
    lean: async () => ({ value: key === 'per_km_rates' ? DEFAULT_PER_KM_RATES : null })
  });
  const emissions = [];
  io.to = room => ({ emit: (event, payload) => emissions.push({ room, event, payload }) });

  await fare.refreshPendingRideFares(settingsFor(300, 125));

  assert.equal(ride.fare, 580);
  assert.deepEqual(emissions.map(item => item.room), ['drivers:Riksha', 'ride:ride-2']);
  assert.ok(emissions.every(item => item.event === 'ride:fare-updated'));
  assert.ok(emissions.every(item => item.payload.fare === 580));
});

test('ride broadcast settings default to 5 km and reject an invalid Admin radius', () => {
  assert.deepEqual(normalizeRideBroadcastSettings(), { maximumRideBroadcastRadiusKm: DEFAULT_RIDE_BROADCAST_RADIUS_KM });
  assert.deepEqual(normalizeRideBroadcastSettings({ maximumRideBroadcastRadiusKm: 8 }), { maximumRideBroadcastRadiusKm: 8 });
  assert.match(validateRideBroadcastSettings({ maximumRideBroadcastRadiusKm: 0 }).errors.join(' '), /between/);
  assert.match(validateRideBroadcastSettings({ maximumRideBroadcastRadiusKm: 100.001 }).errors.join(' '), /between/);
  assert.equal(validateRideBroadcastSettings({ maximumRideBroadcastRadiusKm: 10 }).errors.length, 0);
});

test('Admin can persist a dynamic ride broadcast radius', async () => {
  let stored;
  models.Settings.findOne = () => ({ lean: async () => null });
  models.Settings.findOneAndUpdate = async (_query, update) => {
    stored = update.value;
    return { value: stored };
  };
  const server = app.listen(0);
  try {
    const saved = await request(server, '/api/admin/ride-settings', {
      method: 'PATCH',
      headers: { authorization: `Bearer ${adminToken()}` },
      body: JSON.stringify({ rideBroadcastSettings: { maximumRideBroadcastRadiusKm: 8.5 } })
    });
    assert.equal(saved.response.status, 200);
    assert.deepEqual(stored, { maximumRideBroadcastRadiusKm: 8.5 });
    assert.deepEqual(saved.body.settings, stored);

    const rejected = await request(server, '/api/admin/ride-settings', {
      method: 'PATCH',
      headers: { authorization: `Bearer ${adminToken()}` },
      body: JSON.stringify({ rideBroadcastSettings: { maximumRideBroadcastRadiusKm: -1 } })
    });
    assert.equal(rejected.response.status, 422);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('shared broadcast matcher only selects fresh, wallet-eligible drivers inside the configured radius', async () => {
  models.User.find = () => ({
    select: () => ({
      lean: async () => [
        { _id: 'near-driver', currentLocation: { lat: 31.5204, lng: 74.3587 }, expoPushToken: 'ExponentPushToken[near]' },
        { _id: 'far-driver', currentLocation: { lat: 32.5204, lng: 74.3587 }, expoPushToken: 'ExponentPushToken[far]' },
        { _id: 'invalid-location', currentLocation: { lat: 0, lng: 0 }, expoPushToken: 'ExponentPushToken[invalid]' },
      ]
    })
  });
  models.Wallet.find = () => ({
    select: () => ({
      lean: async () => [{ user: 'near-driver' }, { user: 'far-driver' }, { user: 'invalid-location' }]
    })
  });

  const result = await findRideBroadcastDrivers(
    { lat: 31.5204, lng: 74.3587 },
    'Car Mini',
    { maximumRideBroadcastRadiusKm: 5 }
  );
  assert.equal(result.radiusKm, 5);
  assert.deepEqual(result.drivers.map(driver => driver._id), ['near-driver']);

  const emissions = [];
  io.to = room => ({ emit: (event, payload) => emissions.push({ room, event, payload }) });
  emitRideRequestToDrivers(result.drivers, { id: 'ride-nearby-only' });
  assert.deepEqual(emissions, [{
    room: 'user:near-driver',
    event: 'ride:new',
    payload: { id: 'ride-nearby-only' }
  }]);
});

test('customer nearby-driver map uses the persisted Admin broadcast radius instead of a hardcoded distance', async () => {
  models.Settings.findOne = ({ key }) => ({
    lean: async () => key === 'ride_broadcast_settings'
      ? { value: { maximumRideBroadcastRadiusKm: 8 } }
      : null
  });
  models.User.find = () => ({
    select: () => ({
      lean: async () => [
        { vehicleType: 'Car Mini', currentLocation: { lat: 31.5204, lng: 74.3587 } },
        { vehicleType: 'Car Mini', currentLocation: { lat: 31.6100, lng: 74.3587 } },
      ]
    })
  });
  const server = app.listen(0);
  try {
    const result = await request(server, '/api/drivers/nearby?lat=31.5204&lng=74.3587', {
      headers: { authorization: `Bearer ${customerToken()}` }
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.body.length, 1);
    assert.deepEqual(result.body[0], { vehicleType: 'Car Mini', lat: 31.5204, lng: 74.3587 });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('available-rides recovery uses the same radius so reconnecting drivers cannot receive distant requests', async () => {
  models.Settings.findOne = ({ key }) => ({
    lean: async () => key === 'ride_broadcast_settings'
      ? { value: { maximumRideBroadcastRadiusKm: 5 } }
      : null
  });
  models.User.findById = () => ({
    select: () => ({
      lean: async () => ({
        vehicleType: 'Car Mini',
        accountStatus: 'active',
        isOnline: true,
        lastOnlineHeartbeat: new Date(),
        currentLocation: { lat: 31.5204, lng: 74.3587 }
      })
    })
  });
  models.Ride.find = () => ({
    populate: () => ({
      sort: async () => [
        { _id: 'near-ride', pickupLocation: { lat: 31.5304, lng: 74.3587 } },
        { _id: 'far-ride', pickupLocation: { lat: 32.5204, lng: 74.3587 } }
      ]
    })
  });
  const server = app.listen(0);
  try {
    const result = await request(server, '/api/rides/available', {
      headers: { authorization: `Bearer ${driverToken()}` }
    });
    assert.equal(result.response.status, 200);
    assert.deepEqual(result.body.map(ride => ride._id), ['near-ride']);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});