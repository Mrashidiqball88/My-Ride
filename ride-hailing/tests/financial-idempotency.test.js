'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const service = require('../server');

const {
  app,
  models,
  chargeDailyFeeForOnlineDriver,
  chargeLongRangeCommission,
  allocateWalletDebit,
  getWalletSourceBalances,
  walletAdvanceDepositTotal,
  getDriverTodayIncome,
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
  const driverSettlement = driverWallet.transactions.find(tx => tx.operationId === `ride:${ride._id}:settlement`);
  assert.equal(driverSettlement.amount, 1000, 'ordinary rides pay the Driver the full fare');
  assert.equal(driverSettlement.fundingSource, 'earnings');
  assert.equal(driverSettlement.realAmount, 0);
  assert.equal(driverSettlement.bonusAmount, 0);
  assert.equal(driverWallet.balance, 0);
  assert.equal(driverWallet.realCashAvailable, 0);
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

test('wallet debits consume real cash first, then bonus, and record mixed funding precisely', async () => {
  const bonusOnly = allocateWalletDebit({ balance: 270, realCashAvailable: 0, bonusAvailable: 270 }, 270);
  assert.equal(bonusOnly.fundingSource, 'bonus');
  assert.equal(bonusOnly.realAmount, 0);
  assert.equal(bonusOnly.bonusAmount, 270);

  const mixed = allocateWalletDebit({ balance: 300, realCashAvailable: 100, bonusAvailable: 200 }, 270);
  assert.equal(mixed.fundingSource, 'mixed');
  assert.equal(mixed.realAmount, 100);
  assert.equal(mixed.bonusAmount, 170);
  assert.equal(mixed.remainingReal, 0);
  assert.equal(mixed.remainingBonus, 30);

  const realOnly = allocateWalletDebit({ balance: 400, realCashAvailable: 400, bonusAvailable: 200 }, 270);
  assert.equal(realOnly.fundingSource, 'real');
  assert.equal(realOnly.realAmount, 270);
  assert.equal(realOnly.bonusAmount, 0);
  assert.equal(realOnly.remainingReal, 130);
  assert.equal(realOnly.remainingBonus, 200);
});

test('ride earnings ledger entries stay outside spendable cash and advance deposits', () => {
  const balances = getWalletSourceBalances({
    balance: 2000,
    realCashAvailable: 2000,
    bonusAvailable: 0,
    transactions: [
      {
        amount: 1000,
        type: 'credit',
        description: 'Approved driver recharge (TRX EARNINGS-1)',
        fundingSource: 'real',
        realAmount: 1000,
        bonusAmount: 0
      },
      {
        amount: 850,
        type: 'credit',
        description: 'Ride earnings',
        fundingSource: 'real',
        realAmount: 850,
        bonusAmount: 0
      }
    ]
  });

  assert.equal(balances.realCashAvailable, 1000);
  assert.equal(balances.bonusAvailable, 0);
  assert.equal(walletAdvanceDepositTotal({
    transactions: [
      { amount: 1000, type: 'credit', description: 'Approved driver recharge (TRX EARNINGS-1)', realAmount: 1000 },
      { amount: 850, type: 'credit', description: 'Ride earnings', realAmount: 850 }
    ]
  }), 1000);
});

test('daily fees use bonus only for the amount not covered by real cash and block insufficient combined funds', async () => {
  const driver = await createParticipant('driver', 'fee-priority');
  await models.Wallet.create({
    user: driver._id,
    balance: 300,
    realCashAvailable: 100,
    bonusAvailable: 200
  });

  const charged = await chargeDailyFeeForOnlineDriver(
    driver._id,
    driver,
    { 'Car Sedan': 270 }
  );

  assert.equal(charged.allowed, true);
  assert.equal(charged.charged, true);
  assert.equal(charged.fundingSource, 'mixed');
  assert.equal(charged.realAmount, 100);
  assert.equal(charged.bonusAmount, 170);
  const chargedWallet = await models.Wallet.findOne({ user: driver._id }).lean();
  assert.equal(chargedWallet.balance, 30);
  assert.equal(chargedWallet.realCashAvailable, 0);
  assert.equal(chargedWallet.bonusAvailable, 30);

  const blockedDriver = await createParticipant('driver', 'fee-insufficient');
  await models.Wallet.create({
    user: blockedDriver._id,
    balance: 200,
    realCashAvailable: 0,
    bonusAvailable: 200
  });
  const blocked = await chargeDailyFeeForOnlineDriver(
    blockedDriver._id,
    blockedDriver,
    { 'Car Sedan': 270 }
  );
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.charged, false);
  const blockedWallet = await models.Wallet.findOne({ user: blockedDriver._id }).lean();
  assert.equal(blockedWallet.balance, 200);
  assert.equal(blockedWallet.transactions.length, 0);
});

test('regular recharged wallet pays the daily fee first and becomes real platform revenue', async () => {
  const driver = await createParticipant('driver', 'fee-real-priority');
  await models.Wallet.create({
    user: driver._id,
    balance: 770,
    realCashAvailable: 270,
    bonusAvailable: 500
  });

  const charged = await chargeDailyFeeForOnlineDriver(
    driver._id,
    driver,
    { 'Car Sedan': 270 }
  );

  assert.equal(charged.allowed, true);
  assert.equal(charged.charged, true);
  assert.equal(charged.fundingSource, 'real');
  assert.equal(charged.realAmount, 270);
  assert.equal(charged.bonusAmount, 0);

  const wallet = await models.Wallet.findOne({ user: driver._id }).lean();
  assert.equal(wallet.balance, 500);
  assert.equal(wallet.realCashAvailable, 0);
  assert.equal(wallet.bonusAvailable, 500);

  await models.Admin.create({ _id: 'super-admin', email: 'fee-real-admin@example.test', sessionVersion: 0 });
  const adminServer = app.listen(0);
  try {
    const token = jwt.sign({ isAdmin: true, username: 'fee-real-admin' }, 'ride-hailing-secret-fallback');
    const response = await fetch(`http://127.0.0.1:${adminServer.address().port}/api/admin/revenue?days=7`, {
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.period.dailyFeeCollections, 270);
    assert.equal(body.period.bonusFundedDailyFees, 0);
    assert.equal(body.period.netRevenue, 270);
  } finally {
    await new Promise(resolve => adminServer.close(resolve));
  }
});

test('bonus-funded daily fees are excluded from real Admin revenue', async () => {
  const adminId = new mongoose.Types.ObjectId();
  await models.Admin.create({ _id: 'super-admin', email: 'finance-admin@example.test', sessionVersion: 0 });
  const driverId = new mongoose.Types.ObjectId();
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  await models.Wallet.create({
    user: driverId,
    balance: 540,
    realCashAvailable: 270,
    bonusAvailable: 270,
    transactions: [
      {
        amount: 270, type: 'debit', description: 'Automatic daily fee for going online (Car Sedan)',
        fundingSource: 'real', realAmount: 270, bonusAmount: 0, createdAt: yesterday
      },
      {
        amount: 270, type: 'debit', description: 'Automatic daily fee for going online (Car Sedan)',
        fundingSource: 'bonus', realAmount: 0, bonusAmount: 270, createdAt: now
      },
      {
        amount: 50, type: 'debit', description: 'Automatic daily fee for going online (Car Sedan)',
        createdAt: now
      }
    ]
  });

  const server = app.listen(0);
  try {
    const token = jwt.sign({ isAdmin: true, username: 'finance-admin' }, 'ride-hailing-secret-fallback');
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/revenue?days=7`, {
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.period.dailyFeeCollections, 270);
    assert.equal(body.period.bonusFundedDailyFees, 270);
    assert.equal(body.period.bonusNonRevenueEarnings, 270);
    assert.equal(body.period.unclassifiedFeeDeductions, 50);
    assert.equal(body.period.netRevenue, 270);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('legacy daily-income endpoint matches revenue trend and excludes approved recharge amounts', async () => {
  const driverId = new mongoose.Types.ObjectId();
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  await models.Wallet.create({
    user: driverId,
    balance: 270,
    realCashAvailable: 270,
    transactions: [{
      amount: 270,
      type: 'debit',
      description: 'Automatic daily fee for going online (Car Sedan)',
      fundingSource: 'real',
      realAmount: 270,
      bonusAmount: 0,
      createdAt: now
    }]
  });
  await models.Payment.create({
    driver: driverId,
    trxId: 'DAILY-INCOME-DEPOSIT-1',
    amount: 500,
    vehicleCategory: 'Car Sedan',
    paymentType: 'jazzcash',
    proofScreenshot: 'data:image/png;base64,AA==',
    submittedDate: today,
    status: 'approved',
    approvedAt: now,
    walletCreditedAt: now
  });

  const adminServer = app.listen(0);
  try {
    const token = jwt.sign({ isAdmin: true, username: 'finance-admin' }, 'ride-hailing-secret-fallback');
    const headers = { authorization: `Bearer ${token}` };
    const [revenueResponse, dailyIncomeResponse] = await Promise.all([
      fetch(`http://127.0.0.1:${adminServer.address().port}/api/admin/revenue?days=7`, { headers }),
      fetch(`http://127.0.0.1:${adminServer.address().port}/api/admin/daily-income`, { headers })
    ]);
    assert.equal(revenueResponse.status, 200);
    assert.equal(dailyIncomeResponse.status, 200);
    const revenue = await revenueResponse.json();
    const dailyIncome = await dailyIncomeResponse.json();
    const trendDay = revenue.trend.find(day => day.date === today);
    const legacyDay = dailyIncome.find(day => day.date === today);
    assert.equal(trendDay.netRevenue, 270);
    assert.equal(trendDay.advanceDeposits, 500);
    assert.deepEqual(legacyDay, { date: today, total: trendDay.netRevenue });
    assert.notEqual(legacyDay.total, 500);
  } finally {
    await new Promise(resolve => adminServer.close(resolve));
  }
});

test('Driver financial summary uses settled payouts and separates real cash from bonus', async () => {
  const driver = await createParticipant('driver', 'summary');
  const passenger = await createParticipant('customer', 'summary');
  const { start } = (() => {
    const value = new Date();
    value.setUTCHours(0, 0, 0, 0);
    return { start: value };
  })();
  await models.Ride.create([
    {
      passenger: passenger._id, driver: driver._id, status: 'completed',
      settlementStatus: 'settled', fare: 2000, settledFare: 2000,
      settledDriverEarnings: 1700, settledAt: new Date(start.getTime() + 60 * 60 * 1000),
      pickupLocation: { lat: 31.52, lng: 74.35 }, dropoffLocation: { lat: 31.53, lng: 74.36 }
    },
    {
      passenger: passenger._id, driver: driver._id, status: 'completed',
      settlementStatus: 'pending', fare: 900,
      pickupLocation: { lat: 31.52, lng: 74.35 }, dropoffLocation: { lat: 31.53, lng: 74.36 }
    }
  ]);
  const wallet = await models.Wallet.create({
    user: driver._id,
    balance: 1400,
    realCashAvailable: 900,
    bonusAvailable: 500,
    transactions: [
      {
        amount: 1200, type: 'credit', description: 'Approved driver recharge (TRX SUMMARY-1)',
        fundingSource: 'real', realAmount: 1200, bonusAmount: 0
      },
      {
        amount: 500, type: 'credit', description: 'Admin Wallet Bonus Credit',
        fundingSource: 'bonus', realAmount: 0, bonusAmount: 500
      }
    ]
  });

  const income = await getDriverTodayIncome(driver._id, new Date());
  assert.deepEqual(income, { todayIncome: 1700, todayCompletedRides: 1 });
  const sourceBalances = getWalletSourceBalances(wallet);
  assert.equal(sourceBalances.realCashAvailable, 900);
  assert.equal(sourceBalances.bonusAvailable, 500);
  assert.equal(walletAdvanceDepositTotal(wallet), 1200);
});

test('wallet summary exposes recharge cash separately from ride income', async () => {
  const driver = await createParticipant('driver', 'summary-isolation');
  const passenger = await createParticipant('customer', 'summary-isolation');
  driver.activeSessionToken = 'summary-isolation-session';
  await driver.save();
  await models.Ride.create({
    passenger: passenger._id,
    driver: driver._id,
    status: 'completed',
    settlementStatus: 'settled',
    settledFare: 2000,
    settledDriverEarnings: 1700,
    settledAt: new Date(),
    fare: 2000,
    pickupLocation: { lat: 31.52, lng: 74.35 },
    dropoffLocation: { lat: 31.53, lng: 74.36 }
  });
  await models.Wallet.create({
    user: driver._id,
    balance: 2950,
    realCashAvailable: 2750,
    bonusAvailable: 200,
    transactions: [
      {
        amount: 1500,
        type: 'credit',
        description: 'Approved driver recharge (TRX SUMMARY-ISOLATION)',
        fundingSource: 'real',
        realAmount: 1500,
        bonusAmount: 0
      },
      {
        amount: 1700,
        type: 'credit',
        description: 'Ride earnings',
        fundingSource: 'real',
        realAmount: 1700,
        bonusAmount: 0
      },
      {
        amount: 500,
        type: 'debit',
        description: 'Automatic daily fee for going online (Car Sedan)',
        fundingSource: 'real',
        realAmount: 500,
        bonusAmount: 0
      },
      {
        amount: 200,
        type: 'credit',
        description: 'Admin Wallet Bonus Credit',
        fundingSource: 'bonus',
        realAmount: 0,
        bonusAmount: 200
      }
    ]
  });

  const token = jwt.sign({ id: String(driver._id), role: 'driver' }, 'ride-hailing-secret-fallback');
  const financialServer = app.listen(0);
  try {
    const headers = {
      authorization: `Bearer ${token}`,
      'x-session-token': 'summary-isolation-session'
    };
    const summaryResponse = await fetch(`http://127.0.0.1:${financialServer.address().port}/api/wallet/summary`, { headers });
    assert.equal(summaryResponse.status, 200);
    const summary = await summaryResponse.json();
    assert.equal(summary.currentWalletBalance, 1000);
    assert.equal(summary.realCashAvailable, 1000);
    assert.equal(summary.advanceDeposits, 1500);
    assert.equal(summary.todayIncome, 1700);
    assert.equal(summary.balance, 1200);

    const statusResponse = await fetch(`http://127.0.0.1:${financialServer.address().port}/api/wallet/status`, { headers });
    assert.equal(statusResponse.status, 200);
    const status = await statusResponse.json();
    assert.equal(status.todayRideEarnings, 1700);
  } finally {
    await new Promise(resolve => financialServer.close(resolve));
  }
});

test('approved Driver recharges are shown as advance deposits and excluded from revenue', async () => {
  const driver = await createParticipant('driver', 'advance');
  await models.Payment.create({
    driver: driver._id,
    trxId: 'ADVANCE-DEPOSIT-1',
    amount: 3000,
    vehicleCategory: 'Car Sedan',
    paymentType: 'jazzcash',
    proofScreenshot: 'data:image/png;base64,AA==',
    submittedDate: '2026-09-04',
    status: 'approved',
    approvedAt: new Date(),
    walletCreditedAt: new Date()
  });
  const adminServer = app.listen(0);
  try {
    const token = jwt.sign({ isAdmin: true, username: 'finance-admin' }, 'ride-hailing-secret-fallback');
    const response = await fetch(`http://127.0.0.1:${adminServer.address().port}/api/admin/revenue?days=7`, {
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.period.advanceDeposits, 3000);
    assert.equal(body.period.approvedWalletFunding, 3000);
    assert.equal(body.period.netRevenue, 0);
    assert.equal(body.period.rideCommissions, undefined);
  } finally {
    await new Promise(resolve => adminServer.close(resolve));
  }
});

test('Long Range commission records bonus funding without treating it as real revenue', async () => {
  const driver = await createParticipant('driver', 'long-range-bonus');
  const passenger = await createParticipant('customer', 'long-range-bonus');
  const ride = await createRide(driver, passenger, 'long-range-bonus');
  ride.isLongRange = true;
  await ride.save();
  await models.Wallet.create({
    user: driver._id,
    balance: 100,
    bonusWallet: 100,
    bonusAvailable: 100,
    transactions: [{
      amount: 100,
      type: 'credit',
      description: 'Admin Wallet Bonus Credit',
      fundingSource: 'bonus',
      realAmount: 0,
      bonusAmount: 100
    }]
  });

  const result = await chargeLongRangeCommission(
    ride,
    driver._id,
    { manualCommissionAmounts: { 'Car Sedan': 100 } }
  );

  assert.equal(result.fundingSource, 'bonus');
  assert.equal(result.realAmount, 0);
  assert.equal(result.bonusAmount, 100);
  const wallet = await models.Wallet.findOne({ user: driver._id }).lean();
  const commission = wallet.transactions.find(tx => tx.description === 'Long Range commission');
  assert.equal(commission.fundingSource, 'bonus');
   assert.equal(commission.revenueCategory, 'manual-long-range');
  assert.equal(commission.realAmount, 0);
  assert.equal(commission.bonusAmount, 100);
});

test('Long Range commission spends real cash before falling back to bonus', async () => {
  const driver = await createParticipant('driver', 'long-range-mixed');
  const passenger = await createParticipant('customer', 'long-range-mixed');
  const ride = await createRide(driver, passenger, 'long-range-mixed');
  ride.isLongRange = true;
  await ride.save();
  await models.Wallet.create({
    user: driver._id,
    balance: 150,
    realCashAvailable: 40,
    bonusAvailable: 110
  });

  const result = await chargeLongRangeCommission(
    ride,
    driver._id,
    { manualCommissionAmounts: { 'Car Sedan': 100 } }
  );

  assert.equal(result.fundingSource, 'mixed');
  assert.equal(result.realAmount, 40);
  assert.equal(result.bonusAmount, 60);
  const wallet = await models.Wallet.findOne({ user: driver._id }).lean();
  assert.equal(wallet.balance, 50);
  assert.equal(wallet.realCashAvailable, 0);
  assert.equal(wallet.bonusAvailable, 50);
});

test('legacy Long Range commission debits stay outside real revenue analytics', async () => {
  const driverId = new mongoose.Types.ObjectId();
  const now = new Date();
  await models.Wallet.create({
    user: driverId,
    balance: 0,
    transactions: [{
      amount: 150,
      type: 'debit',
      description: 'Long Range commission',
      fundingSource: 'real',
      realAmount: 150,
      createdAt: now
    }]
  });

  const adminServer = app.listen(0);
  try {
    const token = jwt.sign({ isAdmin: true, username: 'finance-admin' }, 'ride-hailing-secret-fallback');
    const response = await fetch(`http://127.0.0.1:${adminServer.address().port}/api/admin/revenue?days=7`, {
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.period.longRangeCommissions, 0);
    assert.equal(body.period.netRevenue, 0);
    assert.equal(body.period.unclassifiedFeeDeductions, 150);
  } finally {
    await new Promise(resolve => adminServer.close(resolve));
  }
});

test('legacy wallet transactions remain conservative and unclassified', () => {
  const balances = service.getWalletSourceBalances({
    balance: 450,
    transactions: [
      { amount: 500, type: 'credit', description: 'Admin Wallet Bonus Credit' },
      { amount: 50, type: 'debit', description: 'Automatic daily fee for going online (Car Sedan)' }
    ]
  });
  assert.equal(balances.realCashAvailable, 0);
  assert.equal(balances.bonusAvailable, 450);
});