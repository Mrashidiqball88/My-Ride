'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const service = require('../server');

const { app, models, migrateLegacyUserData, seedTestAccounts } = service;
const JWT_SECRET = 'ride-hailing-secret-fallback';
let mongo;

async function request(server, path, options = {}) {
  const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) }
  });
  return {
    response,
    body: await response.json()
  };
}

function adminToken() {
  return jwt.sign({ isAdmin: true, adminSessionVersion: 0 }, JWT_SECRET);
}

function accountRecord({ _id, role, name, email, phone, password }) {
  return {
    _id,
    role,
    name,
    email,
    phone,
    password,
    accountStatus: 'active'
  };
}

before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
});

after(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

test('Admin permanent deletion purges split and legacy accounts and blocks resurrection', async () => {
  const customerId = new mongoose.Types.ObjectId();
  const driverId = new mongoose.Types.ObjectId();
  const customer = accountRecord({
    _id: customerId,
    role: 'customer',
    name: 'Purge Customer',
    email: 'purge-customer@example.test',
    phone: '+923001111111',
    password: 'customer-password'
  });
  const driver = accountRecord({
    _id: driverId,
    role: 'driver',
    name: 'Purge Driver',
    email: 'purge-driver@example.test',
    phone: '+923002222222',
    password: 'driver-password'
  });

  await models.Customer.create(customer);
  await models.Driver.create(driver);
  const duplicateLegacyId = new mongoose.Types.ObjectId();
  await models.LegacyUser.create([
    { ...customer, role: 'customer' },
    { ...driver, role: 'driver' },
    {
      ...customer,
      _id: duplicateLegacyId,
      name: 'Legacy Duplicate Customer',
      role: 'customer'
    }
  ]);
  const ride = await models.Ride.create({
    passenger: customerId,
    driver: driverId,
    pickupLocation: { lat: 24.86, lng: 67.01, address: 'Pickup' },
    dropoffLocation: { lat: 24.87, lng: 67.02, address: 'Dropoff' },
    fare: 450,
    status: 'accepted'
  });
  await models.Wallet.create({ user: driverId, balance: 500 });
  await models.Payment.create({
    driver: driverId,
    trxId: 'PURGE-DRIVER-1',
    amount: 500,
    vehicleCategory: 'Car Mini Non-AC',
    proofScreenshot: 'data:image/png;base64,AAAA',
    submittedDate: '2026-09-07'
  });
  await models.PushSub.create({
    user: driverId,
    endpoint: 'https://push.example.test/purge-driver',
    keys: { p256dh: 'p256dh', auth: 'auth' }
  });
  await models.Ticket.create({
    user: customerId,
    role: 'customer',
    userModel: 'Customer',
    subject: 'Purge ticket',
    message: 'Purge me'
  });
  await models.SOS.create({ user: driverId, userModel: 'Driver', ride: ride._id });
  await models.StudentRideResponseLog.create({
    ride: ride._id,
    driver: driverId,
    responseType: 'rejected'
  });

  const server = app.listen(0);
  try {
    const customerDelete = await request(server, `/api/admin/users/${customerId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${adminToken()}` }
    });
    assert.equal(customerDelete.response.status, 200);
    assert.equal(customerDelete.body.success, true);

    assert.equal(await models.Customer.exists({ _id: customerId }), null);
    assert.equal(await models.LegacyUser.exists({ _id: customerId }), null);
    assert.equal(await models.LegacyUser.exists({ _id: duplicateLegacyId }), null);
    assert.equal(await models.Ticket.exists({ user: customerId }), null);
    assert.equal(await models.Ride.exists({ _id: ride._id }), null);

    const driverDelete = await request(server, `/api/admin/users/${driverId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${adminToken()}` }
    });
    assert.equal(driverDelete.response.status, 200);
    assert.equal(driverDelete.body.success, true);

    assert.equal(await models.Driver.exists({ _id: driverId }), null);
    assert.equal(await models.LegacyUser.exists({ _id: driverId }), null);
    assert.equal(await models.Wallet.exists({ user: driverId }), null);
    assert.equal(await models.Payment.exists({ driver: driverId }), null);
    assert.equal(await models.PushSub.exists({ user: driverId }), null);
    assert.equal(await models.SOS.exists({ user: driverId }), null);
    assert.equal(await models.StudentRideResponseLog.exists({ driver: driverId }), null);

    // Simulate a stale legacy source record surviving outside the purge call.
    // The tombstone must still prevent migration from recreating the account.
    await models.LegacyUser.create({
      ...driver,
      role: 'driver'
    });
    assert.equal(await migrateLegacyUserData(), 0);
    assert.equal(await models.LegacyUser.exists({ _id: driverId }), null);
    assert.equal(await models.Driver.exists({ _id: driverId }), null);

    const customerLogin = await request(server, '/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ identifier: customer.email, password: customer.password })
    });
    assert.equal(customerLogin.response.status, 404);

    const driverLogin = await request(server, '/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ identifier: driver.email, password: driver.password })
    });
    assert.equal(driverLogin.response.status, 404);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('test-account seeding respects a deleted-account tombstone', async () => {
  const customerId = new mongoose.Types.ObjectId();
  await models.Customer.create(accountRecord({
    _id: customerId,
    role: 'customer',
    name: 'Customer Test Account',
    email: 'customer@test.com',
    phone: '+923000000011',
    password: 'test-password'
  }));
  await models.LegacyUser.create({
    ...accountRecord({
      _id: customerId,
      role: 'customer',
      name: 'Customer Test Account',
      email: 'customer@test.com',
      phone: '+923000000011',
      password: 'test-password'
    }),
    role: 'customer'
  });

  const server = app.listen(0);
  try {
    const deleted = await request(server, `/api/admin/users/${customerId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${adminToken()}` }
    });
    assert.equal(deleted.response.status, 200);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }

  await seedTestAccounts();
  assert.equal(await models.Customer.exists({ email: 'customer@test.com' }), null);
  assert.equal(await models.LegacyUser.exists({ email: 'customer@test.com' }), null);
});