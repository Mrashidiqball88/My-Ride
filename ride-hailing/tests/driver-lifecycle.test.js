'use strict';

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const service = require('../server');

const { app, models, chargeDailyFeeForOnlineDriver, runDailyDeduction } = service;
const original = {
  userFindById: models.User.findById,
  userFind: models.User.find,
  userUpdateOne: models.User.updateOne,
  userFindOne: models.User.findOne,
  userFindByIdAndUpdate: models.User.findByIdAndUpdate,
  walletFindOne: models.Wallet.findOne,
  walletFindOneAndUpdate: models.Wallet.findOneAndUpdate,
  settingsFindOne: models.Settings.findOne,
  subAdminFindById: models.SubAdmin.findById,
};

afterEach(() => {
  models.User.findById = original.userFindById;
  models.User.find = original.userFind;
  models.User.updateOne = original.userUpdateOne;
  models.User.findOne = original.userFindOne;
  models.User.findByIdAndUpdate = original.userFindByIdAndUpdate;
  models.Wallet.findOne = original.walletFindOne;
  models.Wallet.findOneAndUpdate = original.walletFindOneAndUpdate;
  models.Settings.findOne = original.settingsFindOne;
  models.SubAdmin.findById = original.subAdminFindById;
});

function driverToken() {
  return jwt.sign({ id: '507f1f77bcf86cd799439011', role: 'driver', accountStatus: 'active', name: 'Driver' }, 'ride-hailing-secret-fallback');
}

function subAdminToken() {
  return jwt.sign({ isSubAdmin: true, subAdminId: '507f1f77bcf86cd799439012', username: 'ops' }, 'ride-hailing-secret-fallback');
}

function superAdminToken() {
  return jwt.sign({ isAdmin: true, username: 'admin' }, 'ride-hailing-secret-fallback');
}

async function adminRequest(server, path, token, method = 'GET') {
  const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  });
  const raw = await response.text();
  try { return { response, body: JSON.parse(raw) }; }
  catch { return { response, body: { raw } }; }
}

async function adminJsonRequest(server, path, token, method, body) {
  const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { response, body: await response.json() };
}

function driverDocument(overrides = {}) {
  return {
    accountStatus: 'active',
    vehicleType: 'Car Mini',
    isOnline: true,
    ...overrides,
  };
}

async function request(server, path, body) {
  const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${driverToken()}` },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

test('native availability persists online state with a heartbeat instead of tying it to a socket lifetime', async () => {
  const updates = [];
  models.Settings.findOne = () => ({ lean: async () => null });
  models.User.findById = () => ({ select: () => ({ lean: async () => driverDocument() }) });
  models.Wallet.findOne = () => ({ select: () => ({ lean: async () => ({ balance: 0 }) }) });
  models.User.updateOne = async (_query, update) => { updates.push(update); return { acknowledged: true }; };

  const server = app.listen(0);
  try {
    const online = await request(server, '/api/driver/availability', { isOnline: true });
    assert.equal(online.response.status, 200);
    assert.equal(online.body.isOnline, true);
    assert.equal(updates[0].isOnline, true);
    assert.ok(updates[0].lastOnlineHeartbeat instanceof Date);

    const heartbeat = await request(server, '/api/driver/heartbeat', {});
    assert.equal(heartbeat.response.status, 200);
    assert.ok(updates[1].lastOnlineHeartbeat instanceof Date);
    assert.equal('isOnline' in updates[1], false);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('daily fee is charged from the wallet only when a driver goes online, and insufficient balance blocks activation', async () => {
  const updates = [];
  const charges = [];
  let walletBalance = 500;
  models.Settings.findOne = () => ({
    lean: async () => ({ value: { 'Car Mini': 100 } })
  });
  models.User.findById = () => ({
    select: () => ({
      lean: async () => driverDocument({ paidUntilDate: null })
    })
  });
  models.User.updateOne = async (_query, update) => { updates.push(update); return { acknowledged: true }; };
  models.Wallet.findOneAndUpdate = async (_query, update) => {
    charges.push(update);
    walletBalance -= 100;
    return { balance: walletBalance };
  };
  models.Wallet.findOne = () => ({
    select: () => ({
      lean: async () => ({ balance: walletBalance, dailyFeeChargedDate: '' })
    })
  });

  const server = app.listen(0);
  try {
    const offline = await request(server, '/api/driver/availability', { isOnline: false });
    assert.equal(offline.response.status, 200);
    assert.equal(charges.length, 0);

    const online = await request(server, '/api/driver/availability', { isOnline: true });
    assert.equal(online.response.status, 200);
    assert.equal(charges.length, 1);
    assert.equal(charges[0].$inc.balance, -100);
    assert.match(charges[0].$push.transactions.description, /going online/);
    assert.ok(updates.some(update => update.paidUntilDate));

    walletBalance = 50;
    models.Wallet.findOneAndUpdate = async () => null;
    const insufficient = await request(server, '/api/driver/availability', { isOnline: true });
    assert.equal(insufficient.response.status, 403);
    assert.match(insufficient.body.error, /must cover today's Daily Fee/);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('Long Range Only drivers are exempt from Daily Fees while Short Range Only and Both are charged', async () => {
  let walletTouched = false;
  models.Wallet.findOne = () => { walletTouched = true; throw new Error('Long Range Only must not read or debit a Daily Fee wallet'); };
  models.Wallet.findOneAndUpdate = () => { walletTouched = true; throw new Error('Long Range Only must not debit a Daily Fee wallet'); };
  const exempt = await chargeDailyFeeForOnlineDriver('driver-long-range', {
    vehicleType: 'Car Sedan', ridePreference: 'Long Range Only'
  });
  assert.equal(exempt.exempt, true);
  assert.equal(exempt.charged, false);
  assert.equal(walletTouched, false);

  let deducted = 0;
  models.Wallet.findOne = () => ({ select: () => ({ lean: async () => ({ balance: 5000, fee_paid_at: null }) }) });
  models.Wallet.findOneAndUpdate = async (_query, update) => {
    deducted += -update.$inc.balance;
    return { balance: 4900 };
  };
  models.User.updateOne = async () => ({ acknowledged: true });
  const settings = { 'Car Sedan': 100 };
  for (const ridePreference of ['Short Range Only', 'Both']) {
    const result = await chargeDailyFeeForOnlineDriver(`driver-${ridePreference}`, {
      vehicleType: 'Car Sedan', ridePreference, paidUntilDate: null, lastDailyFeePaidAt: null
    }, settings);
    assert.equal(result.charged, true);
  }
  assert.equal(deducted, 200);
});

test('the scheduled Daily Fee sweep skips Long Range Only and charges eligible Both drivers', async () => {
  const drivers = [
    { _id: 'long-range-only', vehicleType: 'Car Mini', ridePreference: 'Long Range Only', paidUntilDate: null, lastDailyFeePaidAt: null },
    { _id: 'both-ranges', vehicleType: 'Car Mini', ridePreference: 'Both', paidUntilDate: null, lastDailyFeePaidAt: null }
  ];
  models.User.find = () => ({ select: () => drivers });
  models.Settings.findOne = () => ({ lean: async () => ({ value: { 'Car Mini': 100 } }) });
  const touchedWallets = [];
  models.Wallet.findOne = (query) => ({
    select: () => ({ lean: async () => {
      touchedWallets.push(query.user);
      return { balance: 500, fee_paid_at: null };
    } })
  });
  const charges = [];
  models.Wallet.findOneAndUpdate = async (query, update) => {
    charges.push({ query, update });
    return { balance: 400 };
  };
  models.User.updateOne = async () => ({ acknowledged: true });

  await runDailyDeduction({ force: true });
  assert.deepEqual(touchedWallets, ['both-ranges']);
  assert.equal(charges.length, 1);
  assert.equal(charges[0].query.user, 'both-ranges');
});

test('Long Range toggle checks the configured wallet minimum for the Driver vehicle category', async () => {
  const perKmRates = Object.fromEntries(service.FARE_VEHICLE_CATEGORIES.map(category => [category, 100]));
  const minimumWalletBalances = Object.fromEntries(service.FARE_VEHICLE_CATEGORIES.map(category => [category, 500]));
  minimumWalletBalances['Toyota Highroof'] = 4000;
  models.Settings.findOne = () => ({
    lean: async () => ({ value: { enabled: true, perKmRates, minimumWalletBalances } })
  });
  let balance = 3999;
  models.User.findById = () => ({
    select: () => ({ lean: async () => driverDocument({ vehicleType: 'Toyota Highroof', longRangeEnabled: false }) })
  });
  models.Wallet.findOne = () => ({ select: () => ({ lean: async () => ({ balance }) }) });
  const updates = [];
  models.User.updateOne = async (_query, update) => { updates.push(update); return { acknowledged: true }; };

  const server = app.listen(0);
  try {
    const blocked = await fetch(`http://127.0.0.1:${server.address().port}/api/driver/long-range`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${driverToken()}` },
      body: JSON.stringify({ enabled: true })
    });
    assert.equal(blocked.status, 403);
    assert.equal((await blocked.json()).error, 'Minimum Wallet Balance of Rs 4,000 required for Toyota Highroof to enable Long Range rides.');

    balance = 4000;
    const allowed = await fetch(`http://127.0.0.1:${server.address().port}/api/driver/long-range`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${driverToken()}` },
      body: JSON.stringify({ enabled: true })
    });
    assert.equal(allowed.status, 200);
    assert.equal(updates.at(-1).longRangeEnabled, true);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('an active 24-hour fee pass survives reconnects, then expires into one new online charge', async () => {
  const charges = [];
  const chargeQueries = [];
  let paidAt = new Date(Date.now() - (2 * 60 * 60 * 1000));
  models.Settings.findOne = () => ({
    lean: async () => ({ value: { 'Car Mini': 100 } })
  });
  models.User.findById = () => ({
    select: () => ({
      lean: async () => driverDocument({ lastDailyFeePaidAt: paidAt, paidUntilDate: null, isFreeTrial: false })
    })
  });
  models.User.updateOne = async () => ({ acknowledged: true });
  models.Wallet.findOne = () => ({
    select: () => ({
      lean: async () => ({ balance: 500, fee_paid_at: paidAt })
    })
  });
  models.Wallet.findOneAndUpdate = async (query, update) => {
    chargeQueries.push(query);
    charges.push(update);
    return { balance: 400 };
  };

  const server = app.listen(0);
  try {
    const reconnect = await request(server, '/api/driver/availability', { isOnline: true });
    assert.equal(reconnect.response.status, 200);
    assert.equal(charges.length, 0, 'a fee pass under 24 hours old must not be charged again');

    paidAt = new Date(Date.now() - (25 * 60 * 60 * 1000));
    const afterExpiry = await request(server, '/api/driver/availability', { isOnline: true });
    assert.equal(afterExpiry.response.status, 200);
    assert.equal(charges.length, 1);
    assert.ok(charges[0].$set.fee_paid_at instanceof Date);
    assert.ok(chargeQueries[0].$or.some(condition => condition.fee_paid_at?.$lte));
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('background GPS location rejects invalid coordinates and only accepts a valid driver location', async () => {
  const updates = [];
  models.User.findById = () => ({ select: () => ({ lean: async () => driverDocument() }) });
  models.User.updateOne = async (_query, update) => { updates.push(update); return { acknowledged: true }; };

  const server = app.listen(0);
  try {
    const invalid = await request(server, '/api/driver/location', { lat: 123, lng: 0 });
    assert.equal(invalid.response.status, 422);
    assert.equal(updates.length, 0);

    const valid = await request(server, '/api/driver/location', { lat: 31.5204, lng: 74.3587 });
    assert.equal(valid.response.status, 200);
    assert.equal(updates.length, 1);
    assert.equal(updates[0]['currentLocation.lat'], 31.5204);
    assert.equal(updates[0]['currentLocation.lng'], 74.3587);
    assert.ok(updates[0].lastOnlineHeartbeat instanceof Date);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('vehicle document replacement requires an image and immediately returns the driver to approval review', async () => {
  const password = await bcrypt.hash('current-password', 4);
  const record = {
    _id: '507f1f77bcf86cd799439011',
    role: 'driver',
    password,
    vehicleType: 'Car Mini',
    vehicleModel: 'Old Model',
    vehiclePlate: 'OLD-123',
    vehicleRegPhoto: '/uploads/driver_docs/old.jpg',
    accountStatus: 'active',
    isOnline: true,
    longRangeEnabled: true
  };
  let persisted;
  models.User.findById = () => Object.assign(record, {
    select: async () => ({ ...record, ...persisted })
  });
  models.User.updateOne = async (_query, update) => {
    persisted = update;
    return { acknowledged: true };
  };

  const server = app.listen(0);
  try {
    const missingDocument = await request(server, '/api/user/update-profile', {
      currentPassword: 'current-password',
      vehicleType: 'Toyota Saloon Coaster',
      vehicleModel: 'New Model',
      vehiclePlate: 'NEW-456'
    });
    assert.equal(missingDocument.response.status, 400);
    assert.match(missingDocument.body.error, /document/i);

    const submitted = await request(server, '/api/user/update-profile', {
      currentPassword: 'current-password',
      vehicleType: 'Toyota Saloon Coaster',
      vehicleModel: 'New Model',
      vehiclePlate: 'new-456',
      vehicleRegPhoto: 'data:image/png;base64,aGVsbG8='
    });
    assert.equal(submitted.response.status, 200);
    assert.equal(persisted.vehicleModel, 'New Model');
    assert.equal(persisted.vehiclePlate, 'NEW-456');
    assert.equal(persisted.vehicleType, 'Toyota Saloon Coaster');
    assert.equal(persisted.accountStatus, 'pending');
    assert.equal(persisted.identityVerificationStatus, 'pending');
    assert.equal(persisted.isOnline, false);
    assert.equal(persisted.longRangeEnabled, false);
    assert.ok(persisted.vehicleReviewRequestedAt instanceof Date);
    assert.match(persisted.vehicleRegPhoto, /^data:image\/png;base64,/);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('a Driver awaiting vehicle re-approval cannot reactivate availability', async () => {
  models.User.findById = () => ({
    select: () => ({
      lean: async () => driverDocument({ accountStatus: 'pending', isOnline: false })
    })
  });
  const server = app.listen(0);
  try {
    const result = await request(server, '/api/driver/availability', { isOnline: true });
    assert.equal(result.response.status, 403);
    assert.match(result.body.error, /not approved/i);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('Admin approval restores a changed-vehicle Driver and rejection leaves them unavailable', async () => {
  const updates = [];
  models.Settings.findOne = () => ({ lean: async () => null });
  models.User.findById = id => ({
    select: async () => ({ _id: id, role: 'driver' })
  });
  models.User.findByIdAndUpdate = (_id, update) => {
    updates.push(update);
    return { select: async () => ({ _id, ...update }) };
  };
  const server = app.listen(0);
  try {
    const approval = await adminJsonRequest(
      server,
      '/api/admin/users/507f1f77bcf86cd799439011/status',
      superAdminToken(),
      'PATCH',
      { action: 'approve' }
    );
    assert.equal(approval.response.status, 200);
    assert.equal(updates[0].accountStatus, 'active');
    assert.equal(updates[0].identityVerificationStatus, 'approved');
    assert.equal(updates[0].vehicleReviewRequestedAt, null);
    assert.equal(updates[0].isOnline, false);

    const rejection = await adminJsonRequest(
      server,
      '/api/admin/users/507f1f77bcf86cd799439011/status',
      superAdminToken(),
      'PATCH',
      { action: 'reject', reason: 'Document does not match the number plate' }
    );
    assert.equal(rejection.response.status, 200);
    assert.equal(updates[1].accountStatus, 'blocked');
    assert.equal(updates[1].identityVerificationStatus, 'rejected');
    assert.equal(updates[1].isOnline, false);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('customer wallet deposits are disabled and driver submissions require proof', async () => {
  const customerToken = jwt.sign(
    { id: '507f1f77bcf86cd799439012', role: 'customer', accountStatus: 'active', name: 'Customer' },
    'ride-hailing-secret-fallback'
  );
  const server = app.listen(0);
  try {
    const topUpResponse = await fetch(`http://127.0.0.1:${server.address().port}/api/wallet/add-funds`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${customerToken}` },
      body: JSON.stringify({ amount: 1000 })
    });
    assert.equal(topUpResponse.status, 410);

    const noProof = await request(server, '/api/payments/submit', {
      trxId: 'PAYMENT-1234',
      amount: 100,
      paymentType: 'jazzcash'
    });
    assert.equal(noProof.response.status, 422);
    assert.match(noProof.body.error, /proof screenshot/i);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('payment webhooks cannot approve Driver recharge requests and TRX IDs have a unique database index', async () => {
  const server = app.listen(0);
  try {
    const webhookResponse = await fetch(`http://127.0.0.1:${server.address().port}/api/payments/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ trxId: 'PAYMENT-1234', status: 'success' })
    });
    assert.equal(webhookResponse.status, 410);
    const body = await webhookResponse.json();
    assert.match(body.error, /manual Admin approval/i);

    const indexes = models.Payment.schema.indexes();
    assert.ok(indexes.some(([key, options]) => key.trxId === 1 && options.unique === true));
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('Sub-Admin permissions normalize to the full catalog and reject unknown legacy flags', () => {
  const normalized = service.normalizeSubAdminPermissions({
    viewOverview: true,
    viewPaymentProofs: true,
    manageWallets: true
  });
  assert.equal(Object.keys(normalized).length, service.SUB_ADMIN_PERMISSION_CATALOG.length);
  assert.equal(normalized.viewOverview, true);
  assert.equal(normalized.viewPaymentProofs, true);
  assert.equal('manageWallets' in normalized, false);
  assert.equal(normalized.manageFareSettings, false);
});

test('Sub-Admins cannot bypass driver or customer status permissions through direct API calls', async () => {
  models.SubAdmin.findById = () => ({
    select: () => ({
      lean: async () => ({
        _id: '507f1f77bcf86cd799439012',
        username: 'limited-ops',
        isBlocked: false,
        permissions: { viewDrivers: true }
      })
    })
  });
  models.User.findById = id => ({
    select: () => ({ _id: id, role: String(id).endsWith('1') ? 'driver' : 'customer' })
  });

  const server = app.listen(0);
  try {
    const driverReject = await adminJsonRequest(
      server,
      '/api/admin/users/507f1f77bcf86cd799439011/status',
      subAdminToken(),
      'PATCH',
      { action: 'reject' }
    );
    assert.equal(driverReject.response.status, 403);
    assert.match(driverReject.body.error, /manageDriverApprovals/);

    const customerSuspend = await adminJsonRequest(
      server,
      '/api/admin/users/507f1f77bcf86cd799439012/status',
      subAdminToken(),
      'PATCH',
      { action: 'suspend' }
    );
    assert.equal(customerSuspend.response.status, 403);
    assert.match(customerSuspend.body.error, /manageCustomers/);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('Sub-Admin revocation takes effect immediately and protected settings APIs fail closed', async () => {
  let permissions = { manageRideSettings: true };
  models.SubAdmin.findById = () => ({
    select: () => ({
      lean: async () => ({
        _id: '507f1f77bcf86cd799439012',
        username: 'ops',
        isBlocked: false,
        permissions
      })
    })
  });
  models.Settings.findOne = () => ({ lean: async () => null });
  const server = app.listen(0);
  try {
    const token = subAdminToken();
    const allowed = await adminRequest(server, '/api/admin/ride-settings', token);
    assert.equal(allowed.response.status, 200);

    permissions = {};
    const revoked = await adminRequest(server, '/api/admin/ride-settings', token);
    assert.equal(revoked.response.status, 403);
    assert.match(revoked.body.error, /manageRideSettings/);

    const payments = await adminRequest(server, '/api/admin/payments?status=pending', token);
    assert.equal(payments.response.status, 403);
    assert.match(payments.body.error, /viewPayments/);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('a Sub-Admin with no permissions is denied every protected Admin module', async () => {
  models.SubAdmin.findById = () => ({
    select: () => ({
      lean: async () => ({
        _id: '507f1f77bcf86cd799439012',
        username: 'readless',
        isBlocked: false,
        permissions: {}
      })
    })
  });
  const protectedRoutes = [
    ['GET', '/api/admin/stats'], ['GET', '/api/admin/drivers'], ['GET', '/api/admin/passengers'],
    ['GET', '/api/admin/rides'], ['GET', '/api/admin/sos'], ['GET', '/api/admin/payments?status=pending'],
    ['GET', '/api/admin/audit-logs'], ['GET', '/api/admin/support'], ['GET', '/api/admin/ratings'],
    ['GET', '/api/admin/daily-fee-compliance'], ['GET', '/api/admin/daily-fee-compliance/driver/507f1f77bcf86cd799439011'],
    ['GET', '/api/admin/settings'], ['GET', '/api/admin/ride-settings'], ['GET', '/api/admin/fare-settings'],
    ['GET', '/api/admin/per-km-rates'], ['GET', '/api/admin/daily-fee-settings'], ['GET', '/api/admin/daily-income'],
    ['PATCH', '/api/admin/sos/507f1f77bcf86cd799439011/resolve'],
    ['PATCH', '/api/admin/payments/507f1f77bcf86cd799439011/approve'],
    ['PATCH', '/api/admin/payments/507f1f77bcf86cd799439011/reject'],
    ['PATCH', '/api/admin/support/507f1f77bcf86cd799439011/resolve'],
    ['POST', '/api/admin/drivers/grant-trial'], ['POST', '/api/admin/daily-fee-compliance/remind'],
    ['POST', '/api/admin/drivers/grant-fee-waiver'], ['PATCH', '/api/admin/ride-settings'],
    ['PATCH', '/api/admin/per-km-rates'], ['PATCH', '/api/admin/daily-fee-settings'],
    ['PATCH', '/api/admin/fare-settings'], ['PATCH', '/api/admin/settings'],
    ['GET', '/api/admin/account-deletion-requests']
  ];
  const server = app.listen(0);
  try {
    for (const [method, path] of protectedRoutes) {
      const result = await adminRequest(server, path, subAdminToken(), method);
      assert.equal(result.response.status, 403, `${method} ${path} should deny an unprivileged Sub-Admin`);
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});