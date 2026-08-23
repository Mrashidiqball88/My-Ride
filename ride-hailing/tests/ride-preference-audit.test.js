'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const service = require('../server');

const { server, models, FARE_VEHICLE_CATEGORIES, findLongRangeBroadcastDrivers, runDailyDeduction } = service;
const JWT_SECRET = 'ride-hailing-secret-fallback';
const IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9J3z8AAAAASUVORK5CYII=';

let mongo;
let baseURL;
let adminToken;
const activeSessions = new Map();

function dailyFees(amount = 100) {
  return Object.fromEntries(FARE_VEHICLE_CATEGORIES.map(category => [category, amount]));
}

function longRangeSettings() {
  const minimumWalletBalances = Object.fromEntries(FARE_VEHICLE_CATEGORIES.map(category => [category, 500]));
  minimumWalletBalances['Toyota Highroof'] = 3000;
  minimumWalletBalances['Car Sedan'] = 2000;
  return {
    enabled: true,
    distanceCutoffKm: 50,
    broadcastRadiusKm: 30,
    commissionPercent: 12.5,
    commissionTiming: 'completed',
    minimumWalletBalances,
    perKmRates: Object.fromEntries(FARE_VEHICLE_CATEGORIES.map(category => [category, 100]))
  };
}

function driverToken(driver) {
  return jwt.sign({ id: String(driver._id), role: 'driver', name: driver.name, accountStatus: 'active' }, JWT_SECRET);
}

async function json(path, { token, method = 'GET', body } = {}) {
  const userId = token ? jwt.decode(token)?.id : null;
  const response = await fetch(`${baseURL}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(userId && activeSessions.get(String(userId)) ? { 'x-session-token': activeSessions.get(String(userId)) } : {}),
      ...(body ? { 'content-type': 'application/json' } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  return { response, body: await response.json() };
}

async function registerDriver({ name, phone, vehicleType, ridePreference }) {
  const result = await json('/api/auth/register', {
    method: 'POST',
    body: {
      name, phone, email: `${phone.replace(/\D/g, '')}@audit.myride.test`, password: 'audit-driver-password', role: 'driver',
      vehicleType, vehicleModel: `${vehicleType} Audit`, vehiclePlate: `AUD-${phone.slice(-4)}`,
      ridePreference,
      profilePhoto: IMAGE, licensePhoto: IMAGE, cnicFront: IMAGE, cnicBack: IMAGE, vehicleRegPhoto: IMAGE
    }
  });
  assert.equal(result.response.status, 201, `${name} should register: ${result.body.error || 'unexpected response'}`);
  assert.equal(result.body.user.ridePreference, ridePreference);
  const driver = await models.User.findById(result.body.user.id).lean();
  activeSessions.set(String(driver._id), result.body.sessionToken);
  const approved = await json(`/api/admin/users/${driver._id}/status`, {
    token: adminToken, method: 'PATCH', body: { action: 'approve' }
  });
  assert.equal(approved.response.status, 200, `${name} should be approved`);
  return await models.User.findById(driver._id).lean();
}

before(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await new Promise(resolve => server.listen(0, resolve));
  baseURL = `http://127.0.0.1:${server.address().port}`;
  adminToken = jwt.sign({ isAdmin: true, username: 'audit-admin' }, JWT_SECRET);
  await models.Settings.create([
    { key: 'daily_fee_settings', value: dailyFees(100) },
    { key: 'long_range_ride_settings', value: longRangeSettings() }
  ]);
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
  await mongoose.disconnect();
  await mongo.stop();
});

test('audits registration, scheduled fees, wallet gates, completion commission, and Admin preference override', async () => {
  const driverA = await registerDriver({
    name: 'Audit Driver A', phone: '+923000001001', vehicleType: 'Car Mini', ridePreference: 'Short Range Only'
  });
  const driverB = await registerDriver({
    name: 'Audit Driver B', phone: '+923000001002', vehicleType: 'Toyota Highroof', ridePreference: 'Long Range Only'
  });
  const driverC = await registerDriver({
    name: 'Audit Driver C', phone: '+923000001003', vehicleType: 'Car Sedan', ridePreference: 'Both'
  });

  await Promise.all([driverA, driverB, driverC].map(driver =>
    models.Wallet.updateOne({ user: driver._id }, { $set: { balance: 5000 } })
  ));
  await runDailyDeduction({ force: true });

  const walletsAfterSweep = await Promise.all([driverA, driverB, driverC].map(driver => models.Wallet.findOne({ user: driver._id }).lean()));
  assert.equal(walletsAfterSweep[0].balance, 4900, 'Short Range Only pays the Daily Fee');
  assert.equal(walletsAfterSweep[1].balance, 5000, 'Long Range Only never pays the Daily Fee');
  assert.equal(walletsAfterSweep[2].balance, 4900, 'Both pays the Daily Fee');
  assert.equal(walletsAfterSweep[1].transactions.filter(tx => /Automatic daily fee/.test(tx.description)).length, 0);

  await models.Wallet.updateOne({ user: driverB._id }, { $set: { balance: 2999 } });
  await models.Wallet.updateOne({ user: driverC._id }, { $set: { balance: 1999 } });
  const bBlocked = await json('/api/driver/long-range', {
    token: driverToken(driverB), method: 'PATCH', body: { enabled: true }
  });
  const cBlocked = await json('/api/driver/long-range', {
    token: driverToken(driverC), method: 'PATCH', body: { enabled: true }
  });
  assert.equal(bBlocked.response.status, 403);
  assert.equal(cBlocked.response.status, 403);
  assert.equal(bBlocked.body.error, 'Minimum Wallet Balance of Rs 3,000 required for Toyota Highroof to enable Long Range rides.');
  assert.equal(cBlocked.body.error, 'Minimum Wallet Balance of Rs 2,000 required for Car Sedan to enable Long Range rides.');

  await models.Wallet.updateOne({ user: driverB._id }, { $set: { balance: 3000 } });
  await models.Wallet.updateOne({ user: driverC._id }, { $set: { balance: 2000 } });
  const bEnabled = await json('/api/driver/long-range', {
    token: driverToken(driverB), method: 'PATCH', body: { enabled: true }
  });
  const cEnabled = await json('/api/driver/long-range', {
    token: driverToken(driverC), method: 'PATCH', body: { enabled: true }
  });
  assert.equal(bEnabled.response.status, 200);
  assert.equal(cEnabled.response.status, 200);

  const heartbeat = new Date();
  await models.User.updateMany({ _id: { $in: [driverB._id, driverC._id] } }, {
    $set: { isOnline: true, lastOnlineHeartbeat: heartbeat, currentLocation: { lat: 31.52, lng: 74.35 } }
  });
  const settings = longRangeSettings();
  const bMatches = await findLongRangeBroadcastDrivers({ lat: 31.52, lng: 74.35 }, 'Toyota Highroof', settings);
  const cMatches = await findLongRangeBroadcastDrivers({ lat: 31.52, lng: 74.35 }, 'Car Sedan', settings);
  assert.ok(bMatches.drivers.some(driver => String(driver._id) === String(driverB._id)));
  assert.ok(cMatches.drivers.some(driver => String(driver._id) === String(driverC._id)));

  const customer = await models.User.create({
    name: 'Audit Customer', email: 'audit.customer@myride.test',
    password: 'not-used', role: 'customer', accountStatus: 'active'
  });
  const longRangeRide = await models.Ride.create({
    passenger: customer._id, driver: null, status: 'requested', vehicleType: 'Toyota Highroof',
    isLongRange: true, fare: 1000, pickupLocation: { lat: 31.52, lng: 74.35 }, dropoffLocation: { lat: 32.0, lng: 74.7 }
  });
  const beforeCompletion = await models.Wallet.findOne({ user: driverB._id }).lean();
  assert.equal(beforeCompletion.transactions.filter(tx => tx.description === 'Long Range commission').length, 0);
  const accepted = await json(`/api/rides/${longRangeRide._id}/accept`, {
    token: driverToken(driverB), method: 'PATCH'
  });
  assert.equal(accepted.response.status, 200);
  const arrived = await json(`/api/rides/${longRangeRide._id}/status`, {
    token: driverToken(driverB), method: 'PATCH', body: { status: 'arrived' }
  });
  assert.equal(arrived.response.status, 200);
  const started = await json(`/api/rides/${longRangeRide._id}/status`, {
    token: driverToken(driverB), method: 'PATCH', body: { status: 'in-progress', pin: accepted.body.verificationPin }
  });
  assert.equal(started.response.status, 200);
  const afterStart = await models.Wallet.findOne({ user: driverB._id }).lean();
  assert.equal(afterStart.transactions.filter(tx => tx.description === 'Long Range commission').length, 0, 'commission must not be charged at acceptance or ride start');
  const completed = await json(`/api/rides/${longRangeRide._id}/status`, {
    token: driverToken(driverB), method: 'PATCH', body: { status: 'completed' }
  });
  assert.equal(completed.response.status, 200);
  const afterCompletion = await models.Wallet.findOne({ user: driverB._id }).lean();
  const commissions = afterCompletion.transactions.filter(tx => tx.description === 'Long Range commission');
  assert.equal(commissions.length, 1);
  assert.equal(commissions[0].amount, 125);

  const overridden = await json(`/api/admin/drivers/${driverB._id}/ride-preference`, {
    token: adminToken, method: 'PATCH', body: { ridePreference: 'Both' }
  });
  assert.equal(overridden.response.status, 200);
  assert.equal(overridden.body.driver.ridePreference, 'Both');
  assert.equal(overridden.body.dailyFee.charged, true, 'Admin override immediately restores the standard Daily Fee rule');
  const afterOverride = await models.Wallet.findOne({ user: driverB._id }).lean();
  assert.equal(afterOverride.transactions.filter(tx => /Automatic daily fee/.test(tx.description)).length, 1);
  assert.equal((await models.User.findById(driverB._id).lean()).ridePreference, 'Both');
});