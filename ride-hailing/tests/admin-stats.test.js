'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryServer } = require('mongodb-memory-server');
const service = require('../server');

const { app, models, ADMIN_ACTIVE_RIDE_STATUSES } = service;
const JWT_SECRET = process.env.JWT_SECRET || 'ride-hailing-secret-fallback';
let mongo;
let httpServer;

before(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  httpServer = app.listen(0);
});

after(async () => {
  await new Promise(resolve => httpServer.close(resolve));
  await mongoose.disconnect();
  await mongo.stop();
});

function adminToken() {
  return jwt.sign({ isAdmin: true, adminSessionVersion: 0 }, JWT_SECRET);
}

async function getStats() {
  const response = await fetch(`http://127.0.0.1:${httpServer.address().port}/api/admin/stats`, {
    headers: { authorization: `Bearer ${adminToken()}` }
  });
  return { response, body: await response.json() };
}

test('Admin active ride stats count only assigned ongoing rides and return zero when none are active', async () => {
  assert.deepEqual(ADMIN_ACTIVE_RIDE_STATUSES, ['accepted', 'arrived', 'in-progress']);

  await Promise.all([
    models.Ride.deleteMany({}),
    models.Customer.deleteMany({}),
    models.Driver.deleteMany({}),
    models.Admin.deleteMany({})
  ]);

  const passenger = new mongoose.Types.ObjectId();
  const rideDefaults = {
    passenger,
    pickupLocation: { lat: 33.6844, lng: 73.0479, address: 'Pickup' },
    dropoffLocation: { lat: 33.6938, lng: 73.0652, address: 'Dropoff' },
    fare: 500,
    vehicleType: 'Car Mini Non-AC'
  };
  await models.Ride.create([
    { ...rideDefaults, status: 'requested' },
    { ...rideDefaults, status: 'accepted' },
    { ...rideDefaults, status: 'arrived' },
    { ...rideDefaults, status: 'in-progress' },
    { ...rideDefaults, status: 'completed' },
    { ...rideDefaults, status: 'cancelled' }
  ]);

  let result = await getStats();
  assert.equal(result.response.status, 200);
  assert.equal(result.body.activeRides, 3);

  await models.Ride.deleteMany({ status: { $in: ADMIN_ACTIVE_RIDE_STATUSES } });
  result = await getStats();
  assert.equal(result.response.status, 200);
  assert.equal(result.body.activeRides, 0);
});