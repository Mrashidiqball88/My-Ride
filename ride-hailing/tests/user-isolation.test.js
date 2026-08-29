'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const service = require('../server');

const { models, migrateLegacyUserData } = service;
let mongo;

before(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

after(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

test('legacy Customer and Driver records migrate idempotently with their IDs preserved', async () => {
  const customerId = new mongoose.Types.ObjectId();
  const driverId = new mongoose.Types.ObjectId();
  await models.LegacyUser.create([
    {
      _id: customerId,
      name: 'Legacy Customer',
      email: 'legacy-customer@isolation.test',
      password: 'legacy-password',
      role: 'customer',
      isAdmin: true
    },
    {
      _id: driverId,
      name: 'Legacy Driver',
      email: 'legacy-driver@isolation.test',
      password: 'legacy-password',
      role: 'driver',
      vehicleType: 'Car Mini'
    }
  ]);

  assert.equal(await migrateLegacyUserData(), 2);
  assert.equal(await migrateLegacyUserData(), 2);

  const customer = await models.Customer.findById(customerId).lean();
  const driver = await models.Driver.findById(driverId).lean();
  assert.equal(String(customer._id), String(customerId));
  assert.equal(String(driver._id), String(driverId));
  assert.equal(customer.role, 'customer');
  assert.equal(driver.role, 'driver');
  assert.equal(customer.isAdmin, undefined);
  assert.equal(await models.Admin.findById('super-admin').lean(), null);
});
