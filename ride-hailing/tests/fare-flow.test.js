'use strict';

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

const fare = require('../server');
const { app, io, models, FARE_VEHICLE_CATEGORIES } = fare;

const JWT_SECRET = 'ride-hailing-secret-fallback';
const originalSettings = {
  findOne: models.Settings.findOne,
  findOneAndUpdate: models.Settings.findOneAndUpdate
};
const originalRide = {
  create: models.Ride.create,
  find: models.Ride.find
};
const originalIoTo = io.to;

afterEach(() => {
  models.Settings.findOne = originalSettings.findOne;
  models.Settings.findOneAndUpdate = originalSettings.findOneAndUpdate;
  models.Ride.create = originalRide.create;
  models.Ride.find = originalRide.find;
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

test('ride creation uses the server-calculated fare, not a client amount', async () => {
  const settings = settingsFor(300, 125);
  models.Settings.findOne = () => ({ lean: async () => ({ value: settings }) });
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
    assert.equal(created.fare, 425);
    assert.equal(created.fareQuote.totalFare, 425);
    assert.equal(result.body.fare, 425);
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
  const emissions = [];
  io.to = room => ({ emit: (event, payload) => emissions.push({ room, event, payload }) });

  await fare.refreshPendingRideFares(settingsFor(300, 125));

  assert.equal(ride.fare, 425);
  assert.deepEqual(emissions.map(item => item.room), ['drivers:Riksha', 'ride:ride-2']);
  assert.ok(emissions.every(item => item.event === 'ride:fare-updated'));
  assert.ok(emissions.every(item => item.payload.fare === 425));
});