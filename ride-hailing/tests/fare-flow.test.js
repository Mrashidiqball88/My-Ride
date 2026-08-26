'use strict';

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

const fare = require('../server');
const {
  app, io, models, FARE_VEHICLE_CATEGORIES, DEFAULT_PER_KM_RATES,
  DEFAULT_RIDE_BROADCAST_RADIUS_KM, DEFAULT_RIDE_BROADCAST_REQUEST_DURATION_SECONDS, normalizeRideBroadcastSettings,
  validateRideBroadcastSettings, rideOfferIsStillOpenQuery, findRideBroadcastDrivers, findLongRangeBroadcastDrivers, emitRideRequestToDrivers, emitRideLifecycle, chargeLongRangeCommission,
  normalizeLongRangeSettings, validateLongRangeSettings, calculateRideFare
   , normalizeTerms, normalizeFareVehicle, normalizeFareSettings, storedVehicleTypesForFareCategory
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
const TEST_SESSION = 'test-session';

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

test('Admin can save one vehicle fare without completing other categories', async () => {
  let stored = null;
  models.Settings.findOne = ({ key }) => ({
    lean: async () => key === 'daily_fare_settings' ? { value: stored } : null
  });
  models.Settings.findOneAndUpdate = async (_query, update) => {
    stored = update.value;
    return { value: stored };
  };
  models.Ride.find = async () => [];

  const server = app.listen(0);
  try {
    const result = await request(server, '/api/admin/fare-settings', {
      method: 'PATCH',
      headers: { authorization: `Bearer ${adminToken()}` },
      body: JSON.stringify({
        category: 'Bike',
        dailyFareSettings: {
          Bike: {
            baseFare: 50,
            distanceSlabs: [{ minKm: 0, maxKm: null, rate: 25 }],
            peakRules: []
          }
        }
      })
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.body.category, 'Bike');
    assert.deepEqual(stored.Bike, {
      baseFare: 50,
      distanceSlabs: [{ minKm: 0, maxKm: null, rate: 25 }],
      peakRules: []
    });
    assert.equal(stored.Riksha.baseFare, null);
    assert.deepEqual(stored.Riksha.distanceSlabs, []);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('Customer and Driver terms stay independent and publish role-specific reads', async () => {
  let stored = { customer: 'Customer v1', driver: 'Driver v1' };
  models.Settings.findOne = () => ({ lean: async () => ({ value: stored }) });
  models.Settings.findOneAndUpdate = async (_query, update) => {
    stored = update.value;
    return { value: stored };
  };
  const testServer = app.listen(0);
  try {
    const customer = await request(testServer, '/api/terms/customer');
    const driver = await request(testServer, '/api/terms/driver');
    assert.equal(customer.body.content, 'Customer v1');
    assert.equal(driver.body.content, 'Driver v1');
    const saved = await request(testServer, '/api/admin/terms', {
      method: 'PATCH',
      headers: { authorization: `Bearer ${adminToken()}` },
      body: JSON.stringify({ driver: 'Driver v2' })
    });
    assert.equal(saved.response.status, 200);
    assert.equal(saved.body.terms.customer, 'Customer v1');
    assert.equal(saved.body.terms.driver, 'Driver v2');
    const customerAfter = await request(testServer, '/api/terms/customer');
    const driverAfter = await request(testServer, '/api/terms/driver');
    assert.equal(customerAfter.body.content, 'Customer v1');
    assert.equal(driverAfter.body.content, 'Driver v2');
  } finally {
    await new Promise(resolve => testServer.close(resolve));
  }
});

test('Long Range fares begin at the configured cutoff and use vehicle-specific rates', () => {
  const longRange = normalizeLongRangeSettings({
    enabled: true, distanceCutoffKm: 50, minimumWalletBalance: 750, broadcastRadiusKm: 35,
    commissionPercent: 12.5, commissionTiming: 'started',
    perKmRates: Object.fromEntries(FARE_VEHICLE_CATEGORIES.map(category => [category, 210]))
  });
  assert.equal(validateLongRangeSettings(longRange).errors.length, 0);
  assert.ok(Object.values(longRange.minimumWalletBalances).every(value => value === 750), 'legacy global minimum migrates to every vehicle category');
  const standardRates = { 'Car Mini': 50 };
  const veryShort = calculateRideFare(settingsFor(300, 100), longRange, 'Car Mini', 2, new Date(), standardRates);
  assert.equal(veryShort.isLongRange, undefined);
  assert.equal(veryShort.perKmRate, standardRates['Car Mini']);
  assert.equal(veryShort.totalFare, 300 + (2 * standardRates['Car Mini']));
  const short = calculateRideFare(settingsFor(300, 100), longRange, 'Car Mini', 5, new Date(), standardRates);
  assert.equal(short.isLongRange, undefined);
  assert.equal(short.longRangeRatePerKm, undefined);
  const local = calculateRideFare(settingsFor(300, 100), longRange, 'Car Mini', 49.99, new Date(), DEFAULT_PER_KM_RATES);
  const long = calculateRideFare(settingsFor(300, 100), longRange, 'Car Mini', 50, new Date(), DEFAULT_PER_KM_RATES);
  assert.equal(local.isLongRange, undefined);
  assert.equal(long.isLongRange, true);
  assert.equal(long.longRangeRatePerKm, 210);
  assert.equal(long.totalFare, 10500);
  const invalid = validateLongRangeSettings({ enabled: true, perKmRates: {} });
  assert.equal(invalid.errors.length, FARE_VEHICLE_CATEGORIES.length);
});

test('Long Range settings keep independent minimum wallet balances by vehicle category', () => {
  const settings = normalizeLongRangeSettings({
    minimumWalletBalances: { Bike: 500, 'Car Sedan': 2000, 'Toyota Highroof': 4000, 'Toyota Saloon Coaster': 5000 }
  });
  assert.equal(settings.minimumWalletBalances.Bike, 500);
  assert.equal(settings.minimumWalletBalances['Car Sedan'], 2000);
  assert.equal(settings.minimumWalletBalances['Toyota Highroof'], 4000);
  assert.equal(settings.minimumWalletBalances['Toyota Saloon Coaster'], 5000);
  assert.equal(settings.minimumWalletBalances['Car Mini AC'], 500);
  assert.equal(settings.minimumWalletBalances['Car Mini Non-AC'], 500);
});

test('Car Mini AC and Non-AC retain independent fares while legacy Mini data migrates safely', () => {
  assert.ok(FARE_VEHICLE_CATEGORIES.includes('Car Mini AC'));
  assert.ok(FARE_VEHICLE_CATEGORIES.includes('Car Mini Non-AC'));
  assert.ok(!FARE_VEHICLE_CATEGORIES.includes('Car Mini'));
  assert.equal(normalizeFareVehicle('Car Mini'), 'Car Mini Non-AC');
  assert.ok(storedVehicleTypesForFareCategory('Car Mini Non-AC').includes('Car Mini'));
  assert.ok(!storedVehicleTypesForFareCategory('Car Mini AC').includes('Car Mini'));

  const legacyFare = {
    baseFare: 180,
    distanceSlabs: [{ minKm: 0, maxKm: null, rate: 50 }],
    peakRules: []
  };
  const migratedFares = normalizeFareSettings({ 'Car Mini': legacyFare });
  assert.deepEqual(migratedFares['Car Mini AC'], legacyFare);
  assert.deepEqual(migratedFares['Car Mini Non-AC'], legacyFare);

  const longRange = normalizeLongRangeSettings({
    enabled: true,
    distanceCutoffKm: 50,
    minimumWalletBalances: { 'Car Mini': 850, 'Car Mini AC': 1200 },
    perKmRates: { 'Car Mini': 95, 'Car Mini AC': 130 }
  });
  assert.equal(longRange.minimumWalletBalances['Car Mini AC'], 1200);
  assert.equal(longRange.minimumWalletBalances['Car Mini Non-AC'], 850);
  assert.equal(longRange.perKmRates['Car Mini AC'], 130);
  assert.equal(longRange.perKmRates['Car Mini Non-AC'], 95);

  const fares = settingsFor(200, 100);
  const localRates = { 'Car Mini AC': 75, 'Car Mini Non-AC': 55 };
  assert.equal(calculateRideFare(fares, longRange, 'Car Mini AC', 10, new Date(), localRates).totalFare, 950);
  assert.equal(calculateRideFare(fares, longRange, 'Car Mini Non-AC', 10, new Date(), localRates).totalFare, 750);
  assert.equal(calculateRideFare(fares, longRange, 'Car Mini AC', 50, new Date(), localRates).totalFare, 6500);
  assert.equal(calculateRideFare(fares, longRange, 'Car Mini Non-AC', 50, new Date(), localRates).totalFare, 4750);
});

test('Toyota Highroof and Toyota Saloon Coaster are canonical categories with independent standard and Long Range rates', () => {
  assert.ok(FARE_VEHICLE_CATEGORIES.includes('Toyota Highroof'));
  assert.ok(FARE_VEHICLE_CATEGORIES.includes('Toyota Saloon Coaster'));
  assert.equal(normalizeFareVehicle('Toyota Hi Roof'), 'Toyota Highroof');
  assert.equal(normalizeFareVehicle('Toyota Coaster'), 'Toyota Saloon Coaster');
  assert.ok(storedVehicleTypesForFareCategory('Toyota Highroof').includes('Toyota Hi-Roof'));
  assert.equal(DEFAULT_PER_KM_RATES['Toyota Highroof'], 120);
  assert.equal(DEFAULT_PER_KM_RATES['Toyota Saloon Coaster'], 140);

  const longRange = normalizeLongRangeSettings({
    enabled: true,
    perKmRates: Object.fromEntries(FARE_VEHICLE_CATEGORIES.map(category => [
      category,
      category === 'Toyota Highroof' ? 180 : category === 'Toyota Saloon Coaster' ? 220 : 100
    ]))
  });
  const fares = settingsFor(200, 100);
  const highroof = calculateRideFare(fares, longRange, 'Toyota Highroof', 12, new Date(), DEFAULT_PER_KM_RATES);
  const coaster = calculateRideFare(fares, longRange, 'Toyota Saloon Coaster', 50, new Date(), DEFAULT_PER_KM_RATES);
  assert.equal(highroof.totalFare, 200 + (12 * 120));
  assert.equal(coaster.isLongRange, true);
  assert.equal(coaster.longRangeRatePerKm, 220);
  assert.equal(coaster.totalFare, 50 * 220);
});

test('Customer fare quote uses active Long Range rates without daily fare slabs', async () => {
  const expectedRates = {
    Bike: 25, Riksha: 40, 'Car Mini AC': 90, 'Car Mini Non-AC': 80, 'Car Sedan': 100,
    'Cary Dibba': 90, 'Car SUV': 120, 'Van Seven Seats': 150,
    'Toyota Highroof': 175, 'Toyota Saloon Coaster': 225
  };
  const longRangeSettings = {
    enabled: true,
    distanceCutoffKm: 50,
    perKmRates: expectedRates
  };
  models.Settings.findOne = ({ key }) => ({
    lean: async () => ({
      value: key === 'long_range_ride_settings' ? longRangeSettings : null
    })
  });

  const server = app.listen(0);
  try {
    const config = await request(server, '/api/customer/fare-config');
    assert.deepEqual(config.body.longRangeSettings.perKmRates, expectedRates);
    assert.equal(config.body.longRangeSettings.enabled, true);

    const result = await request(server, '/api/fare/calculate', {
      method: 'POST',
      body: JSON.stringify({ vehicleType: 'Riksha', distanceKm: 293.3 })
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.body.longRangeRatePerKm, 40);
    assert.equal(result.body.totalFare, Math.round(293.3 * 40));

    for (const [category, rate] of Object.entries(expectedRates)) {
      const quote = await request(server, '/api/fare/calculate', {
        method: 'POST',
        body: JSON.stringify({ vehicleType: category, distanceKm: 293.3 })
      });
      assert.equal(quote.response.status, 200, `${category} quote should succeed`);
      assert.equal(quote.body.longRangeRatePerKm, rate);
      assert.equal(quote.body.totalFare, Math.round(293.3 * rate));
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('Long Range commission is charged once only after a completed ride', async () => {
  const updates = [];
  let debitAttempt = 0;
  models.Wallet.findOneAndUpdate = async () => {
    debitAttempt++;
    return debitAttempt === 1 ? { balance: 900 } : null;
  };
  models.Wallet.exists = async () => debitAttempt > 1;
  models.Ride.updateOne = async (_query, update) => { updates.push(update); };
  const ride = { _id: 'long-range-ride', isLongRange: true, fare: 1000, longRangeCommissionChargedAt: null };
  const settings = { commissionTiming: 'completed', commissionPercent: 10 };
  assert.equal((await chargeLongRangeCommission(ride, 'driver-1', 'accepted', settings)).ok, true);
  assert.equal(debitAttempt, 0, 'accepting must not charge a completion-timed commission');
  assert.equal((await chargeLongRangeCommission(ride, 'driver-1', 'completed', settings)).ok, true);
  assert.equal((await chargeLongRangeCommission(ride, 'driver-1', 'completed', settings)).ok, true);
  assert.equal(debitAttempt, 2);
  assert.equal(updates.length, 2);
  assert.equal(updates[0].$set.longRangeCommissionAmount, 100);
});

test('ride creation uses the server-calculated fare and records the authoritative offer expiry', async () => {
  const settings = settingsFor(300, 125);
  models.User.findById = () => ({
    select: () => ({
      lean: async () => ({
        activeSessionToken: TEST_SESSION,
        accountStatus: 'active',
        identityVerificationStatus: 'approved'
      })
    })
  });
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
      headers: { authorization: `Bearer ${customerToken()}`, 'x-session-token': TEST_SESSION },
      body: JSON.stringify({
        pickupLocation: { lat: 31.5204, lng: 74.3587 },
        dropoffLocation: { lat: 33.6844, lng: 73.0479 },
        distance: 7,
        vehicleType: 'Car Mini',
        fare: 1
      })
    });
    assert.equal(result.response.status, 201);
    assert.equal(created.fare, 650);
    assert.equal(created.fareQuote.totalFare, 650);
    assert.equal(result.body.fare, 650);
    assert.equal(created.broadcastDurationSeconds, DEFAULT_RIDE_BROADCAST_REQUEST_DURATION_SECONDS);
    assert.ok(created.broadcastExpiresAt instanceof Date);
    assert.ok(created.broadcastExpiresAt.getTime() > created.createdAt.getTime());
    assert.equal(new Date(result.body.broadcastExpiresAt).getTime(), created.broadcastExpiresAt.getTime());
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('Customer fare adjustments are server-bounded negotiation offers', async () => {
  const settings = settingsFor(300, 125);
  models.User.findById = () => ({
    select: () => ({
      lean: async () => ({
        activeSessionToken: TEST_SESSION,
        accountStatus: 'active',
        identityVerificationStatus: 'approved'
      })
    })
  });
  models.Settings.findOne = ({ key }) => ({
    lean: async () => ({ value: key === 'per_km_rates' ? DEFAULT_PER_KM_RATES : settings })
  });
  let created;
  models.Ride.create = async input => {
    created = { ...input, _id: 'offered-ride', createdAt: new Date(), save: async function save() { return this; } };
    return created;
  };
  io.to = () => ({ emit() {} });

  const server = app.listen(0);
  try {
    const accepted = await request(server, '/api/rides', {
      method: 'POST',
      headers: { authorization: `Bearer ${customerToken()}`, 'x-session-token': TEST_SESSION },
      body: JSON.stringify({
        pickupLocation: { lat: 31.5204, lng: 74.3587 },
        dropoffLocation: { lat: 33.6844, lng: 73.0479 },
        distance: 7,
        vehicleType: 'Car Mini',
        customerOffer: 780
      })
    });
    assert.equal(accepted.response.status, 201);
    assert.equal(created.fareQuote.totalFare, 650);
    assert.equal(created.fare, 780);

    const rejected = await request(server, '/api/rides', {
      method: 'POST',
      headers: { authorization: `Bearer ${customerToken()}`, 'x-session-token': TEST_SESSION },
      body: JSON.stringify({
        pickupLocation: { lat: 31.5204, lng: 74.3587 },
        dropoffLocation: { lat: 33.6844, lng: 73.0479 },
        distance: 7,
        vehicleType: 'Car Mini',
        customerOffer: 100
      })
    });
    assert.equal(rejected.response.status, 422);
    assert.match(rejected.body.error, /between Rs 330 and Rs 1,300/);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('Customer fare offset is added to the authoritative Admin quote', async () => {
  const settings = settingsFor(300, 125);
  models.User.findById = () => ({
    select: () => ({
      lean: async () => ({
        activeSessionToken: TEST_SESSION,
        accountStatus: 'active',
        identityVerificationStatus: 'approved'
      })
    })
  });
  models.Settings.findOne = ({ key }) => ({
    lean: async () => ({ value: key === 'per_km_rates' ? DEFAULT_PER_KM_RATES : settings })
  });
  let created;
  models.Ride.create = async input => {
    created = { ...input, _id: 'offset-ride', createdAt: new Date(), save: async function save() { return this; } };
    return created;
  };
  io.to = () => ({ emit() {} });

  const server = app.listen(0);
  try {
    const accepted = await request(server, '/api/rides', {
      method: 'POST',
      headers: { authorization: `Bearer ${customerToken()}`, 'x-session-token': TEST_SESSION },
      body: JSON.stringify({
        pickupLocation: { lat: 31.5204, lng: 74.3587 },
        dropoffLocation: { lat: 33.6844, lng: 73.0479 },
        distance: 7,
        vehicleType: 'Car Mini',
        customerFareOffset: 130
      })
    });
    assert.equal(accepted.response.status, 201);
    assert.equal(created.fareQuote.totalFare, 650);
    assert.equal(created.customerFareOffset, 130);
    assert.equal(created.fare, created.fareQuote.totalFare + created.customerFareOffset);

    const rejected = await request(server, '/api/rides', {
      method: 'POST',
      headers: { authorization: `Bearer ${customerToken()}`, 'x-session-token': TEST_SESSION },
      body: JSON.stringify({
        pickupLocation: { lat: 31.5204, lng: 74.3587 },
        dropoffLocation: { lat: 33.6844, lng: 73.0479 },
        distance: 7,
        vehicleType: 'Car Mini',
        customerFareOffset: -400
      })
    });
    assert.equal(rejected.response.status, 422);
    assert.match(rejected.body.error, /between Rs 330 and Rs 1,300/);
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

test('ride broadcast settings default to a 60 second window and validate the Admin duration', () => {
  assert.deepEqual(normalizeRideBroadcastSettings(), {
    maximumRideBroadcastRadiusKm: DEFAULT_RIDE_BROADCAST_RADIUS_KM,
    broadcastRequestDurationSeconds: DEFAULT_RIDE_BROADCAST_REQUEST_DURATION_SECONDS
  });
  assert.deepEqual(normalizeRideBroadcastSettings({ maximumRideBroadcastRadiusKm: 8, broadcastRequestDurationSeconds: 45 }), {
    maximumRideBroadcastRadiusKm: 8, broadcastRequestDurationSeconds: 45
  });
  assert.match(validateRideBroadcastSettings({ maximumRideBroadcastRadiusKm: 0, broadcastRequestDurationSeconds: 60 }).errors.join(' '), /between/);
  assert.match(validateRideBroadcastSettings({ maximumRideBroadcastRadiusKm: 100.001, broadcastRequestDurationSeconds: 60 }).errors.join(' '), /between/);
  assert.match(validateRideBroadcastSettings({ maximumRideBroadcastRadiusKm: 10, broadcastRequestDurationSeconds: 29 }).errors.join(' '), /between 30 and 120/);
  assert.match(validateRideBroadcastSettings({ maximumRideBroadcastRadiusKm: 10, broadcastRequestDurationSeconds: 60.5 }).errors.join(' '), /whole number/);
  assert.equal(validateRideBroadcastSettings({ maximumRideBroadcastRadiusKm: 10, broadcastRequestDurationSeconds: 60 }).errors.length, 0);
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
      body: JSON.stringify({ rideBroadcastSettings: { maximumRideBroadcastRadiusKm: 8.5, broadcastRequestDurationSeconds: 75 } })
    });
    assert.equal(saved.response.status, 200);
    assert.deepEqual(stored, { maximumRideBroadcastRadiusKm: 8.5, broadcastRequestDurationSeconds: 75 });
    assert.deepEqual(saved.body.settings, stored);

    const rejected = await request(server, '/api/admin/ride-settings', {
      method: 'PATCH',
      headers: { authorization: `Bearer ${adminToken()}` },
      body: JSON.stringify({ rideBroadcastSettings: { maximumRideBroadcastRadiusKm: -1, broadcastRequestDurationSeconds: 20 } })
    });
    assert.equal(rejected.response.status, 422);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('the server-side offer guard excludes expired request windows', () => {
  const now = new Date('2026-08-23T12:00:00.000Z');
  assert.deepEqual(rideOfferIsStillOpenQuery(now), {
    $or: [
      { broadcastExpiresAt: { $gt: now } },
      { broadcastExpiresAt: null, createdAt: { $gte: new Date('2026-08-23T11:59:00.000Z') } }
    ]
  });
});

test('shared broadcast matcher only selects fresh, wallet-eligible drivers inside the configured radius', async () => {
  let driverQuery;
  models.User.find = query => {
    driverQuery = query;
    return ({
    select: () => ({
      lean: async () => [
        { _id: 'near-driver', currentLocation: { lat: 31.5204, lng: 74.3587 }, expoPushToken: 'ExponentPushToken[near]' },
        { _id: 'far-driver', currentLocation: { lat: 32.5204, lng: 74.3587 }, expoPushToken: 'ExponentPushToken[far]' },
        { _id: 'invalid-location', currentLocation: { lat: 0, lng: 0 }, expoPushToken: 'ExponentPushToken[invalid]' },
      ]
    })
    });
  };
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
  assert.deepEqual(driverQuery.vehicleType.$in, ['Car Mini Non-AC', 'Car Mini', 'Car Mini Non AC', 'Car Mini NonAC']);

  await findRideBroadcastDrivers(
    { lat: 31.5204, lng: 74.3587 },
    'Car Mini AC',
    { maximumRideBroadcastRadiusKm: 5 }
  );
  assert.deepEqual(driverQuery.vehicleType.$in, ['Car Mini AC', 'Car Mini A/C']);
  assert.ok(!driverQuery.vehicleType.$in.includes('Car Mini'));

  const emissions = [];
  io.to = room => ({ emit: (event, payload) => emissions.push({ room, event, payload }) });
  emitRideRequestToDrivers(result.drivers, { id: 'ride-nearby-only' });
  assert.deepEqual(emissions, [{
    room: 'user:near-driver',
    event: 'ride:new',
    payload: { id: 'ride-nearby-only' }
  }]);
});

test('ride lifecycle events reach vehicle, rider, driver, and ride audiences once with an idempotent revision', () => {
  const emissions = [];
  io.to = rooms => ({ emit: (event, payload) => emissions.push({ rooms, event, payload }) });
  const ride = {
    _id: 'ride-realtime',
    passenger: 'customer-realtime',
    driver: 'driver-realtime',
    vehicleType: 'Toyota Highroof',
    updatedAt: new Date('2026-08-24T04:00:00.000Z')
  };

  emitRideLifecycle(ride, 'ride:status', { status: 'cancelled' }, { notifyVehicleDrivers: true });

  assert.deepEqual(emissions, [{
    rooms: [
      'ride:ride-realtime',
      'user:customer-realtime',
      'user:driver-realtime',
      'drivers:Toyota Highroof'
    ],
    event: 'ride:status',
    payload: {
      rideId: 'ride-realtime',
      eventId: 'ride:status:ride-realtime:2026-08-24T04:00:00.000Z',
      revision: '2026-08-24T04:00:00.000Z',
      status: 'cancelled'
    }
  }]);
});

test('customer cancellation event reaches the assigned and previously notified driver audiences', () => {
  const emissions = [];
  io.to = rooms => ({ emit: (event, payload) => emissions.push({ rooms, event, payload }) });
  const ride = {
    _id: 'ride-cancelled',
    passenger: 'customer-cancelled',
    driver: 'driver-cancelled',
    vehicleType: 'Car Mini Non-AC',
    notifiedDriverIds: ['driver-cancelled', 'driver-notified'],
    updatedAt: new Date('2026-08-24T05:00:00.000Z')
  };

  emitRideLifecycle(ride, 'ride_cancelled', {
    status: 'cancelled',
    cancelledBy: 'customer'
  }, {
    notifyVehicleDrivers: true,
    notifyDriverIds: ride.notifiedDriverIds
  });

  assert.deepEqual(emissions, [{
    rooms: [
      'ride:ride-cancelled',
      'user:customer-cancelled',
      'user:driver-cancelled',
      'user:driver-notified',
      'drivers:Car Mini Non-AC'
    ],
    event: 'ride_cancelled',
    payload: {
      rideId: 'ride-cancelled',
      eventId: 'ride_cancelled:ride-cancelled:2026-08-24T05:00:00.000Z',
      revision: '2026-08-24T05:00:00.000Z',
      status: 'cancelled',
      cancelledBy: 'customer'
    }
  }]);
});

test('Long Range broadcast only returns opted-in drivers for Socket.io and push delivery', async () => {
  let driverQuery;
  models.User.find = query => {
    driverQuery = query;
    return {
      select: () => ({
        lean: async () => [
          { _id: 'opted-in', longRangeEnabled: true, currentLocation: { lat: 31.5204, lng: 74.3587 }, expoPushToken: 'ExponentPushToken[in]' },
          { _id: 'opted-out', longRangeEnabled: false, currentLocation: { lat: 31.5204, lng: 74.3587 }, expoPushToken: 'ExponentPushToken[out]' }
        ]
      })
    };
  };
  models.Wallet.find = () => ({
    select: () => ({
      lean: async () => [{ user: 'opted-in' }, { user: 'opted-out' }]
    })
  });

  const result = await findLongRangeBroadcastDrivers(
    { lat: 31.5204, lng: 74.3587 },
    'Car Mini',
    { broadcastRadiusKm: 30, minimumWalletBalance: 500 }
  );

  assert.equal(driverQuery.longRangeEnabled, true);
  assert.deepEqual(result.drivers.map(driver => driver._id), ['opted-in']);

  const emissions = [];
  io.to = room => ({ emit: (event, payload) => emissions.push({ room, event, payload }) });
  emitRideRequestToDrivers(result.drivers, { id: 'long-range-only' });
  assert.deepEqual(emissions, [{
    room: 'user:opted-in',
    event: 'ride:new',
    payload: { id: 'long-range-only' }
  }]);
});

test('customer nearby-driver map uses the persisted Admin broadcast radius instead of a hardcoded distance', async () => {
  models.User.findById = () => ({
    select: () => ({ lean: async () => ({ activeSessionToken: TEST_SESSION }) })
  });
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
      headers: { authorization: `Bearer ${customerToken()}`, 'x-session-token': TEST_SESSION }
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
        currentLocation: { lat: 31.5204, lng: 74.3587 },
        activeSessionToken: TEST_SESSION
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
      headers: { authorization: `Bearer ${driverToken()}`, 'x-session-token': TEST_SESSION }
    });
    assert.equal(result.response.status, 200);
    assert.deepEqual(result.body.map(ride => ride._id), ['near-ride']);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});