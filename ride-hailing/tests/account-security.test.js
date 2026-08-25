'use strict';

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const rideHailing = require('../server');
const { app, models, setEmailTransporterForTests } = rideHailing;

const JWT_SECRET = 'ride-hailing-secret-fallback';
const original = {
  userFindOne: models.User.findOne,
  userFindById: models.User.findById,
  userCreate: models.User.create,
  userUpdateOne: models.User.updateOne,
  walletCreate: models.Wallet.create,
  subAdminFindById: models.SubAdmin.findById,
  settingsFindOne: models.Settings.findOne,
  settingsFindOneAndUpdate: models.Settings.findOneAndUpdate
};

afterEach(() => {
  Object.assign(models.User, {
    findOne: original.userFindOne,
    findById: original.userFindById,
    create: original.userCreate,
    updateOne: original.userUpdateOne
  });
  Object.assign(models.Wallet, { create: original.walletCreate });
  Object.assign(models.SubAdmin, { findById: original.subAdminFindById });
  Object.assign(models.Settings, {
    findOne: original.settingsFindOne,
    findOneAndUpdate: original.settingsFindOneAndUpdate
  });
  setEmailTransporterForTests(rideHailing.emailTransporter || { sendMail: async () => {} });
});

function query(value) {
  return {
    select() { return this; },
    lean: async () => value,
    then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); }
  };
}

async function request(server, path, options = {}) {
  const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) }
  });
  const type = response.headers.get('content-type') || '';
  return {
    response,
    body: type.includes('application/json') ? await response.json() : await response.arrayBuffer()
  };
}

async function withServer(callback) {
  const server = app.listen(0);
  try {
    return await callback(server);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

function adminToken(version = 0) {
  return jwt.sign({ isAdmin: true, email: 'admin@myride.com', adminSessionVersion: version }, JWT_SECRET);
}

function subAdminToken() {
  return jwt.sign({ isSubAdmin: true, email: 'sub@myride.com' }, JWT_SECRET);
}

function registrationBody(overrides = {}) {
  return {
    name: 'Ayesha Khan',
    phone: '03001234567',
    email: 'ayesha@example.test',
    password: 'password123',
    role: 'customer',
    cnicNumber: '35202-1234567-9',
    // Valid data-URL shape with unreadable image bytes. This reaches the
    // identity-verification branch instead of failing client-upload parsing.
    cnicFront: 'data:image/png;base64,AAAA',
    cnicBack: 'data:image/png;base64,AAAA',
    ...overrides
  };
}

test('unreadable and mismatched customer ID documents return the exact rider-facing failure', async () => {
  models.User.findOne = () => query(null);

  await withServer(async server => {
    for (const documents of [
      { cnicFront: 'data:image/png;base64,AAAA', cnicBack: 'data:image/png;base64,AAAA' },
      { cnicFront: 'data:image/png;base64,AAAB', cnicBack: 'data:image/png;base64,AAAC' }
    ]) {
      const result = await request(server, '/api/auth/register', {
        method: 'POST',
        body: JSON.stringify(registrationBody(documents))
      });
      assert.equal(result.response.status, 422);
      assert.equal(result.body.error, 'Wrong Documents / Document Verification Failed');
    }
  });
});

test('duplicate National IDs are rejected before another customer is created', async () => {
  const nationalIdHash = crypto.createHmac('sha256', JWT_SECRET)
    .update('3520212345679').digest('hex');
  let lookedUpHash;
  models.User.findOne = queryInput => {
    if (queryInput.nationalIdHash) {
      lookedUpHash = queryInput.nationalIdHash;
      return query({ _id: 'existing-customer' });
    }
    return query(null);
  };

  await withServer(async server => {
    const result = await request(server, '/api/auth/register', {
      method: 'POST',
      body: JSON.stringify(registrationBody())
    });
    assert.equal(result.response.status, 409);
    assert.equal(result.body.error, 'This CNIC / NIC is already registered');
    assert.equal(lookedUpHash, nationalIdHash);
  });
});

test('email is required for both customer and driver registration', async () => {
  await withServer(async server => {
    for (const role of ['customer', 'driver']) {
      const result = await request(server, '/api/auth/register', {
        method: 'POST',
        body: JSON.stringify(registrationBody({ role, email: '' }))
      });
      assert.equal(result.response.status, 400);
      assert.equal(result.body.error, 'Email address is required');
    }
  });
});

test('customer identity files are not public and only a Super Admin can retrieve them', async () => {
  const customerId = 'customer-identity-test';
  const fileName = 'customer_id_front_test.png';
  const fileContent = Buffer.from('private identity document');
  const fs = require('fs');
  const path = require('path');
  const identityDir = path.resolve(__dirname, '..', 'uploads', 'customer_identity');
  fs.mkdirSync(identityDir, { recursive: true });
  fs.writeFileSync(path.join(identityDir, fileName), fileContent, { mode: 0o600 });

  const security = { passwordHash: '', recoveryKeyHash: '', sessionVersion: 0 };
  models.Settings.findOne = () => ({ lean: async () => ({ value: security }) });
  models.User.findOne = queryInput => queryInput._id === customerId
    ? { select: () => query({ customerIdFront: fileName, identityVerifiedAt: new Date() }) }
    : query(null);
  models.SubAdmin.findById = () => ({
    select: () => query({ _id: 'sub-admin', username: 'ops', permissions: {}, isBlocked: false })
  });

  try {
    await withServer(async server => {
      const publicResult = await request(server, `/uploads/customer_identity/${fileName}`);
      assert.equal(publicResult.response.status, 404);

      const subAdminResult = await request(server, `/api/admin/customer-identity/${customerId}/front`, {
        headers: { authorization: `Bearer ${subAdminToken()}` }
      });
      assert.equal(subAdminResult.response.status, 403);

      const superAdminResult = await request(server, `/api/admin/customer-identity/${customerId}/front`, {
        headers: { authorization: `Bearer ${adminToken()}` }
      });
      assert.equal(superAdminResult.response.status, 200);
      assert.deepEqual(Buffer.from(await superAdminResult.body), fileContent);
      assert.equal(superAdminResult.response.headers.get('cache-control'), 'private, no-store');
    });
  } finally {
    fs.rmSync(path.join(identityDir, fileName), { force: true });
  }
});

test('driver identity documents are private and unsafe document URLs are rejected', async () => {
  const fs = require('fs');
  const path = require('path');
  const driverId = 'private-driver-document-test';
  const fileName = 'cnicFront_private-test.jpg';
  const fileContent = Buffer.from('private driver identity document');
  const documentDir = path.resolve(__dirname, '..', 'uploads', 'driver_identity');
  fs.mkdirSync(documentDir, { recursive: true });
  fs.writeFileSync(path.join(documentDir, fileName), fileContent, { mode: 0o600 });

  const security = { passwordHash: '', recoveryKeyHash: '', sessionVersion: 0 };
  models.Settings.findOne = () => ({ lean: async () => ({ value: security }) });
  models.User.findOne = queryInput => queryInput._id === driverId
    ? { select: () => query({ _id: driverId, role: 'driver', cnicFront: fileName }) }
    : query(null);

  try {
    await withServer(async server => {
      const publicResult = await request(server, `/uploads/driver_docs/${fileName}`);
      assert.equal(publicResult.response.status, 404);

      const unauthenticatedResult = await request(server, `/api/admin/driver-documents/${driverId}/cnicFront`);
      assert.equal(unauthenticatedResult.response.status, 401);

      const adminResult = await request(server, `/api/admin/driver-documents/${driverId}/cnicFront`, {
        headers: { authorization: `Bearer ${adminToken()}` }
      });
      assert.equal(adminResult.response.status, 200);
      assert.deepEqual(Buffer.from(await adminResult.body), fileContent);
      assert.equal(adminResult.response.headers.get('cache-control'), 'private, no-store');

      const unsafeRegistration = await request(server, '/api/auth/register', {
        method: 'POST',
        body: JSON.stringify(registrationBody({
          role: 'driver',
          vehicleType: 'Car Mini',
          vehicleModel: 'Test Car',
          vehiclePlate: 'TEST-123',
          profilePhoto: 'javascript:alert(1)',
          licensePhoto: 'data:image/png;base64,AAAA',
          cnicFront: 'data:image/png;base64,AAAA',
          cnicBack: 'data:image/png;base64,AAAA',
          vehicleRegPhoto: 'data:image/png;base64,AAAA'
        }))
      });
      assert.equal(unsafeRegistration.response.status, 400);
      assert.match(unsafeRegistration.body.error, /^Profile Photo: .*JPEG, PNG, or WebP image/i);
    });
  } finally {
    fs.rmSync(path.join(documentDir, fileName), { force: true });
  }
});

test('recovery-key setup works, rate limits attempts, and invalidates old Super Admin sessions', async () => {
  const security = { passwordHash: '', recoveryKeyHash: '', sessionVersion: 0 };
  models.Settings.findOne = () => ({ lean: async () => ({ value: { ...security } }) });
  models.Settings.findOneAndUpdate = async (_filter, update) => {
    Object.assign(security, update.value);
    return { value: { ...security } };
  };

  await withServer(async server => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const limited = await request(server, '/api/admin/forgot-password', {
        method: 'POST',
        body: JSON.stringify({
          email: 'rate-limit@example.test',
          recoveryKey: 'wrong-recovery-key',
          newPassword: 'new-admin-password'
        })
      });
      assert.equal(limited.response.status, 401);
    }
    const rateLimited = await request(server, '/api/admin/forgot-password', {
      method: 'POST',
      body: JSON.stringify({
        email: 'rate-limit@example.test',
        recoveryKey: 'wrong-recovery-key',
        newPassword: 'new-admin-password'
      })
    });
    assert.equal(rateLimited.response.status, 429);

    const oldTokenResult = await request(server, '/api/admin/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'admin@myride.com', password: 'admin1234' })
    });
    assert.equal(oldTokenResult.response.status, 200);
    const oldToken = oldTokenResult.body.token;

    const setup = await request(server, '/api/admin/security/recovery-key', {
      method: 'PUT',
      headers: { authorization: `Bearer ${oldToken}` },
      body: JSON.stringify({ currentPassword: 'admin1234', recoveryKey: 'a-secure-recovery-key' })
    });
    assert.equal(setup.response.status, 200);
    assert.equal(setup.body.recoveryKeyConfigured, true);

    const reset = await request(server, '/api/admin/forgot-password', {
      method: 'POST',
      body: JSON.stringify({
        email: 'admin@myride.com',
        recoveryKey: 'a-secure-recovery-key',
        newPassword: 'new-admin-password'
      })
    });
    assert.equal(reset.response.status, 200);
    assert.equal(security.sessionVersion, 1);

    const oldSession = await request(server, '/api/admin/security/status', {
      headers: { authorization: `Bearer ${oldToken}` }
    });
    assert.equal(oldSession.response.status, 401);

    const newLogin = await request(server, '/api/admin/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'admin@myride.com', password: 'new-admin-password' })
    });
    assert.equal(newLogin.response.status, 200);
    const newSession = await request(server, '/api/admin/security/status', {
      headers: { authorization: `Bearer ${newLogin.body.token}` }
    });
    assert.equal(newSession.response.status, 200);
  });
});

test('Customer and Driver requests require the latest matching session token', async () => {
  for (const role of ['customer', 'driver']) {
    const user = { _id: `${role}-1`, activeSessionToken: `${role}-current` };
    models.User.findById = () => query(user);
    const token = jwt.sign({ id: user._id, role, name: role }, JWT_SECRET);

    await withServer(async server => {
      const missing = await request(server, '/api/auth/me', {
        headers: { authorization: `Bearer ${token}` }
      });
      assert.equal(missing.response.status, 401);
      assert.equal(missing.body.error, 'LOGGED_IN_ELSEWHERE');

      const replaced = await request(server, '/api/auth/me', {
        headers: { authorization: `Bearer ${token}`, 'x-session-token': `${role}-old` }
      });
      assert.equal(replaced.response.status, 401);
      assert.equal(replaced.body.error, 'LOGGED_IN_ELSEWHERE');

      const current = await request(server, '/api/auth/me', {
        headers: { authorization: `Bearer ${token}`, 'x-session-token': user.activeSessionToken }
      });
      assert.equal(current.response.status, 200);
    });
  }
});

test('unknown recovery emails return exactly Wrong email without creating an OTP', async () => {
  let updated = false;
  models.User.findOne = () => query(null);
  models.User.updateOne = async () => { updated = true; };

  await withServer(async server => {
    const result = await request(server, '/api/auth/forgot-password', {
      method: 'POST',
      body: JSON.stringify({ email: 'unknown@example.test' })
    });
    assert.equal(result.response.status, 404);
    assert.equal(result.body.error, 'Wrong email');
    assert.equal(updated, false);
  });
});

test('an emailed OTP password reset replaces the active session', async () => {
  const user = {
    _id: 'reset-user',
    email: 'ayesha@example.test',
    phone: '+923001234567',
    otpCode: await bcrypt.hash('123456', 10),
    otpExpiry: new Date(Date.now() + 60_000),
    activeSessionToken: 'old-session'
  };
  let update;
  models.User.findOne = () => query(user);
  models.User.updateOne = async (_filter, next) => {
    update = next;
    Object.assign(user, next);
  };
  models.User.findById = () => query(user);
  const oldToken = jwt.sign({ id: user._id, role: 'customer', name: 'Customer' }, JWT_SECRET);

  await withServer(async server => {
    const reset = await request(server, '/api/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({ email: 'ayesha@example.test', otp: '123456', newPassword: 'a-new-password' })
    });
    assert.equal(reset.response.status, 200);
    assert.equal(update.otpCode, null);
    assert.equal(update.otpExpiry, null);
    assert.notEqual(update.activeSessionToken, 'old-session');

    const oldSession = await request(server, '/api/auth/me', {
      headers: { authorization: `Bearer ${oldToken}`, 'x-session-token': 'old-session' }
    });
    assert.equal(oldSession.response.status, 401);
    assert.equal(oldSession.body.error, 'LOGGED_IN_ELSEWHERE');
  });
});

test('password reset rejects an incorrect emailed OTP', async () => {
  const otpCode = await bcrypt.hash('654321', 10);
  models.User.findOne = () => query({
    _id: 'reset-user', email: 'ayesha@example.test',
    otpCode,
    otpExpiry: new Date(Date.now() + 60_000)
  });

  await withServer(async server => {
    const reset = await request(server, '/api/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({ email: 'ayesha@example.test', otp: '123456', newPassword: 'a-new-password' })
    });
    assert.equal(reset.response.status, 400);
    assert.equal(reset.body.error, 'Invalid or expired OTP');
  });
});