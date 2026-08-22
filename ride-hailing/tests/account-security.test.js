'use strict';

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const rideHailing = require('../server');
const { app, models } = rideHailing;

const JWT_SECRET = 'ride-hailing-secret-fallback';
const original = {
  userFindOne: models.User.findOne,
  userCreate: models.User.create,
  userUpdateOne: models.User.updateOne,
  walletCreate: models.Wallet.create,
  settingsFindOne: models.Settings.findOne,
  settingsFindOneAndUpdate: models.Settings.findOneAndUpdate
};

afterEach(() => {
  Object.assign(models.User, {
    findOne: original.userFindOne,
    create: original.userCreate,
    updateOne: original.userUpdateOne
  });
  Object.assign(models.Wallet, { create: original.walletCreate });
  Object.assign(models.Settings, {
    findOne: original.settingsFindOne,
    findOneAndUpdate: original.settingsFindOneAndUpdate
  });
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
    cnicFront: 'not-an-image',
    cnicBack: 'not-an-image',
    ...overrides
  };
}

test('unreadable and mismatched customer ID documents return the exact rider-facing failure', async () => {
  models.User.findOne = () => query(null);

  await withServer(async server => {
    for (const documents of [
      { cnicFront: 'not-an-image', cnicBack: 'not-an-image' },
      { cnicFront: 'data:image/png;base64,not-a-real-image', cnicBack: 'data:image/png;base64,also-not-real' }
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