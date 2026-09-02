'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const service = require('../server');

const {
  models,
  completeRideFinancialSettlement,
  approveDriverPayment,
} = service;

let mongo;

async function createParticipant(role, suffix) {
  return models.User.create({
    name: `${role}-${suffix}`,
    email: `${role}-${suffix}@financial.test`,
    password: 'not-used',
    role,
    accountStatus: 'active',
    vehicleType: role === 'driver' ? 'Car Sedan' : undefined,
  });
}

async function createRide(driver, passenger, suffix) {
  return models.Ride.create({
    passenger: passenger._id,
    driver: driver._id,
    status: 'in-progress',
    vehicleType: 'Car Sedan',
    fare: 1000,
    distanceKm: 10,
    pickupLocation: { lat: 31.52, lng: 74.35 },
    dropoffLocation: { lat: 31.53, lng: 74.36 },
    driverLocation: { lat: 31.52, lng: 74.35 },
    requestId: `financial-${suffix}`,
  });
}

before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
});

beforeEach(async () => {
  await Promise.all([
    models.LegacyUser.deleteMany({}),
    models.Customer.deleteMany({}),
    models.Driver.deleteMany({}),
    models.Admin.deleteMany({}),
    models.Ride.deleteMany({}),
    models.Wallet.deleteMany({}),
    models.Payment.deleteMany({}),
    models.Settings.deleteMany({}),
    models.SubAdmin.deleteMany({}),
  ]);
});

after(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

test('concurrent ride completion settles once and returns an idempotent replay', async () => {
  const driver = await createParticipant('driver', 'ride');
  const passenger = await createParticipant('customer', 'ride');
  await models.Wallet.create([
    { user: driver._id, balance: 0, realCashWallet: 0 },
    { user: passenger._id, balance: 5000 },
  ]);
  const ride = await createRide(driver, passenger, 'concurrent');

  const results = await Promise.all([
    completeRideFinancialSettlement(ride._id, driver._id),
    completeRideFinancialSettlement(ride._id, driver._id),
  ]);

  assert.equal(results.filter(result => result.alreadySettled).length, 1);
  const storedRide = await models.Ride.findById(ride._id).lean();
  assert.equal(storedRide.status, 'completed');
  assert.equal(storedRide.settlementStatus, 'settled');
  assert.equal(storedRide.settledFare, 1000);
  const [driverWallet, passengerWallet] = await Promise.all([
    models.Wallet.findOne({ user: driver._id }).lean(),
    models.Wallet.findOne({ user: passenger._id }).lean(),
  ]);
  assert.equal(driverWallet.transactions.filter(tx => tx.operationId === `ride:${ride._id}:settlement`).length, 1);
  assert.equal(passengerWallet.transactions.filter(tx => tx.operationId === `ride:${ride._id}:settlement`).length, 1);
  assert.equal((await models.User.findById(driver._id).lean()).totalRides, 1);
  assert.equal((await models.User.findById(passenger._id).lean()).totalRides, 1);
});

test('ride completion rolls every financial write back when a participant update fails', async () => {
  const driver = await createParticipant('driver', 'rollback-ride');
  const passenger = await createParticipant('customer', 'rollback-ride');
  await models.Wallet.create({ user: passenger._id, balance: 5000 });
  const ride = await createRide(driver, passenger, 'rollback');
  const originalUpdateOne = models.User.updateOne;
  let updateCount = 0;
  models.User.updateOne = (...args) => {
    updateCount += 1;
    if (updateCount === 2) throw new Error('forced participant update failure');
    return originalUpdateOne(...args);
  };

  try {
    await assert.rejects(
      completeRideFinancialSettlement(ride._id, driver._id),
      /forced participant update failure/
    );
  } finally {
    models.User.updateOne = originalUpdateOne;
  }

  const [storedRide, passengerWallet, driverWallet] = await Promise.all([
    models.Ride.findById(ride._id).lean(),
    models.Wallet.findOne({ user: passenger._id }).lean(),
    models.Wallet.findOne({ user: driver._id }).lean(),
  ]);
  assert.equal(storedRide.status, 'in-progress');
  assert.equal(storedRide.settlementStatus, 'pending');
  assert.equal(passengerWallet.transactions.length, 0);
  assert.equal(driverWallet, null);
});

test('concurrent Driver payment approval credits the wallet once', async () => {
  const driver = await createParticipant('driver', 'payment');
  await models.Wallet.create({ user: driver._id, balance: 100 });
  const payment = await models.Payment.create({
    driver: driver._id,
    trxId: 'FINANCIAL-APPROVAL-1',
    amount: 2500,
    vehicleCategory: 'Car Sedan',
    paymentType: 'jazzcash',
    proofScreenshot: 'data:image/png;base64,AA==',
    submittedDate: '2026-09-02',
  });

  const results = await Promise.all([
    approveDriverPayment(payment._id, { id: 'admin-a', role: 'admin' }, 'approved'),
    approveDriverPayment(payment._id, { id: 'admin-b', role: 'admin' }, 'approved'),
  ]);

  assert.ok(results.every(Boolean));
  const [storedPayment, wallet] = await Promise.all([
    models.Payment.findById(payment._id).lean(),
    models.Wallet.findOne({ user: driver._id }).lean(),
  ]);
  assert.equal(storedPayment.status, 'approved');
  assert.equal(storedPayment.walletCreditedOperationId || storedPayment.walletCreditOperationId, `payment:${payment._id}:wallet-credit`);
  assert.equal(wallet.transactions.filter(tx => tx.operationId === `payment:${payment._id}:wallet-credit`).length, 1);
  assert.equal(wallet.balance, 2600);
});

test('Driver payment approval rolls back the wallet when the Driver update fails', async () => {
  const driver = await createParticipant('driver', 'rollback-payment');
  await models.Wallet.create({ user: driver._id, balance: 100 });
  const payment = await models.Payment.create({
    driver: driver._id,
    trxId: 'FINANCIAL-ROLLBACK-1',
    amount: 2500,
    vehicleCategory: 'Car Sedan',
    paymentType: 'bank',
    proofScreenshot: 'data:image/png;base64,AA==',
    submittedDate: '2026-09-03',
  });
  const originalUpdateOne = models.User.updateOne;
  models.User.updateOne = () => {
    throw new Error('forced Driver update failure');
  };

  try {
    await assert.rejects(
      approveDriverPayment(payment._id, { id: 'admin', role: 'admin' }),
      /forced Driver update failure/
    );
  } finally {
    models.User.updateOne = originalUpdateOne;
  }

  const [storedPayment, wallet] = await Promise.all([
    models.Payment.findById(payment._id).lean(),
    models.Wallet.findOne({ user: driver._id }).lean(),
  ]);
  assert.equal(storedPayment.status, 'pending');
  assert.equal(storedPayment.walletCreditedAt, null);
  assert.equal(wallet.balance, 100);
  assert.equal(wallet.transactions.length, 0);
});