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
  adminFindById: models.Admin.findById,
  adminFindOneAndUpdate: models.Admin.findOneAndUpdate
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
  Object.assign(models.Admin, {
    findById: original.adminFindById,
    findOneAndUpdate: original.adminFindOneAndUpdate
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

function configuredAdminEmail() {
  return process.env.ADMIN_EMAIL || 'admin@myride.com';
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
  models.Admin.findById = () => ({ lean: async () => security });
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
  models.Admin.findById = () => ({ lean: async () => security });
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
  const previousSmtp = {
    SMTP_HOST: process.env.SMTP_HOST,
    SMTP_USER: process.env.SMTP_USER,
    SMTP_PASS: process.env.SMTP_PASS,
    EMAIL_FROM: process.env.EMAIL_FROM
  };
  process.env.SMTP_HOST = 'smtp.test';
  process.env.SMTP_USER = 'admin@example.test';
  process.env.SMTP_PASS = 'test-smtp-password';
  process.env.EMAIL_FROM = 'admin@example.test';
  const sentMail = [];
  setEmailTransporterForTests({ sendMail: async mail => { sentMail.push(mail); } });
  const security = {
    passwordHash: bcrypt.hashSync('admin1234', 4),
    recoveryKeyHash: '',
    sessionVersion: 0
  };
  models.Admin.findById = () => ({ lean: async () => ({ ...security }) });
  models.Admin.findOneAndUpdate = async (_filter, update) => {
    Object.assign(security, update.$set);
    return { ...security };
  };

  try {
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
        body: JSON.stringify({ email: configuredAdminEmail(), password: 'admin1234' })
      });
      assert.equal(oldTokenResult.response.status, 200);
      const oldToken = oldTokenResult.body.token;
      const oldTokenClaims = jwt.verify(oldToken, JWT_SECRET);
      assert.equal(oldTokenClaims.id, 'super-admin');
      assert.equal(oldTokenClaims.isAdmin, true);
      assert.equal(oldTokenClaims.isSuperAdmin, true);
      assert.equal(oldTokenClaims.email, configuredAdminEmail());
      assert.equal(oldTokenClaims.adminSessionVersion, 0);

      const otpRequest = await request(server, '/api/admin/security/otp/request', {
      method: 'POST',
      headers: { authorization: `Bearer ${oldToken}` },
      body: JSON.stringify({ action: 'recovery-key' })
      });
      assert.equal(otpRequest.response.status, 200);
      const setupOtp = sentMail.at(-1).text.match(/\b\d{6}\b/)[0];

      const setup = await request(server, '/api/admin/security/recovery-key', {
      method: 'PUT',
      headers: { authorization: `Bearer ${oldToken}` },
      body: JSON.stringify({
        currentPassword: 'admin1234',
        recoveryKey: 'a-secure-recovery-key',
        otp: setupOtp
      })
      });
      assert.equal(setup.response.status, 200);
      assert.equal(setup.body.recoveryKeyConfigured, true);
      assert.equal(security.sessionVersion, 1);

      const resetOtpRequest = await request(server, '/api/admin/forgot-password/request-otp', {
      method: 'POST',
      body: JSON.stringify({
        email: configuredAdminEmail(),
        recoveryKey: 'a-secure-recovery-key'
      })
      });
      assert.equal(resetOtpRequest.response.status, 200);
      const resetOtp = sentMail.at(-1).text.match(/\b\d{6}\b/)[0];
      const reset = await request(server, '/api/admin/forgot-password', {
      method: 'POST',
      body: JSON.stringify({
          email: configuredAdminEmail(),
        recoveryKey: 'a-secure-recovery-key',
        newPassword: 'new-admin-password',
        otp: resetOtp
      })
      });
      assert.equal(reset.response.status, 200);
      assert.equal(security.sessionVersion, 2);

      const oldSession = await request(server, '/api/admin/security/status', {
      headers: { authorization: `Bearer ${oldToken}` }
      });
      assert.equal(oldSession.response.status, 401);

      const newLogin = await request(server, '/api/admin/login', {
      method: 'POST',
        body: JSON.stringify({ email: configuredAdminEmail(), password: 'new-admin-password' })
      });
      assert.equal(newLogin.response.status, 200);
      const newSession = await request(server, '/api/admin/security/status', {
      headers: { authorization: `Bearer ${newLogin.body.token}` }
      });
      assert.equal(newSession.response.status, 200);
      const newTokenClaims = jwt.verify(newLogin.body.token, JWT_SECRET);
      assert.equal(newTokenClaims.isSuperAdmin, true);
      assert.equal(newTokenClaims.adminSessionVersion, 2);
    });
  } finally {
    for (const [key, value] of Object.entries(previousSmtp)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('preview Admin password secret overrides a stale ephemeral database hash', async () => {
  const previousEnv = {
    ADMIN_EMAIL: process.env.ADMIN_EMAIL,
    ADMIN_PASSWORD: process.env.ADMIN_PASSWORD,
    DEMO_ACCOUNTS_ENABLED: process.env.DEMO_ACCOUNTS_ENABLED,
    NODE_ENV: process.env.NODE_ENV,
    MONGO_URI: process.env.MONGO_URI
  };
  process.env.ADMIN_EMAIL = 'machinescarelab@gmail.com';
  process.env.ADMIN_PASSWORD = 'preview-admin-password';
  process.env.DEMO_ACCOUNTS_ENABLED = 'true';
  process.env.NODE_ENV = 'development';
  delete process.env.MONGO_URI;

  const staleHash = bcrypt.hashSync('old-preview-password', 4);
  models.Admin.findById = () => ({
    lean: async () => ({ value: { passwordHash: staleHash, recoveryKeyHash: '', sessionVersion: 0 } })
  });

  try {
    await withServer(async server => {
      const staleLogin = await request(server, '/api/admin/login', {
        method: 'POST',
        body: JSON.stringify({ email: 'machinescarelab@gmail.com', password: 'old-preview-password' })
      });
      assert.equal(staleLogin.response.status, 401);

      const currentLogin = await request(server, '/api/admin/login', {
        method: 'POST',
        body: JSON.stringify({ email: 'machinescarelab@gmail.com', password: 'preview-admin-password' })
      });
      assert.equal(currentLogin.response.status, 200);
    });
  } finally {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('pre-login Admin configuration uses the clean fallback without credential fields', async () => {
  const previousEmail = process.env.ADMIN_EMAIL;
  delete process.env.ADMIN_EMAIL;
  models.Admin.findById = () => query({
      email: 'legacy-settings-admin@example.test',
      passwordHash: 'bcrypt-password-hash',
      recoveryKeyHash: 'bcrypt-recovery-hash',
      sessionVersion: 9
  });

  try {
    await withServer(async server => {
      const result = await request(server, '/api/admin/login-config');
      assert.equal(result.response.status, 200);
       assert.deepEqual(result.body, { email: 'admin@myride.com' });
      assert.equal(result.body.password, undefined);
      assert.equal(result.body.recoveryKey, undefined);
      assert.equal(result.body.passwordHash, undefined);
      assert.equal(result.body.sessionVersion, undefined);
    });
  } finally {
    if (previousEmail === undefined) delete process.env.ADMIN_EMAIL;
    else process.env.ADMIN_EMAIL = previousEmail;
  }
});

test('legacy Settings and shared User Admin-shaped records cannot authenticate', async () => {
  const previousEmail = process.env.ADMIN_EMAIL;
  delete process.env.ADMIN_EMAIL;
  const legacyPasswordHash = bcrypt.hashSync('legacy-admin-password', 4);
  models.Admin.findById = () => query(null);
  models.Settings.findOne = () => query({
    key: 'admin_security',
    value: {
      email: 'admin@myride.com',
      passwordHash: legacyPasswordHash,
      sessionVersion: 0
    }
  });
  models.User.findOne = () => query({
    _id: 'legacy-admin',
    email: 'admin@myride.com',
    isAdmin: true,
    password: legacyPasswordHash
  });

  try {
    await withServer(async server => {
      const result = await request(server, '/api/admin/login', {
        method: 'POST',
        body: JSON.stringify({ email: 'admin@myride.com', password: 'legacy-admin-password' })
      });
      assert.equal(result.response.status, 401);
    });
  } finally {
    if (previousEmail === undefined) delete process.env.ADMIN_EMAIL;
    else process.env.ADMIN_EMAIL = previousEmail;
  }
});

test('Admin credential sync initializes MongoDB with hashes and non-sensitive email metadata', async () => {
  const previousEnv = {
    ADMIN_EMAIL: process.env.ADMIN_EMAIL,
    ADMIN_PASSWORD: process.env.ADMIN_PASSWORD,
    ADMIN_RECOVERY_KEY: process.env.ADMIN_RECOVERY_KEY,
    NODE_ENV: process.env.NODE_ENV,
    MONGO_URI: process.env.MONGO_URI,
    DEMO_ACCOUNTS_ENABLED: process.env.DEMO_ACCOUNTS_ENABLED
  };
  process.env.ADMIN_EMAIL = 'configured-admin@example.test';
  process.env.ADMIN_PASSWORD = 'configured-admin-password';
  process.env.ADMIN_RECOVERY_KEY = 'configured-recovery-key';
  process.env.NODE_ENV = 'production';
  process.env.MONGO_URI = 'mongodb://admin-sync.test';
  delete process.env.DEMO_ACCOUNTS_ENABLED;

  let storedValue;
  models.Admin.findById = () => query(null);
  models.Admin.findOneAndUpdate = async (_filter, update) => {
    storedValue = update.$set;
    return storedValue;
  };

  try {
    const result = await rideHailing.syncAdminSecurity();
    assert.equal(result.email, 'configured-admin@example.test');
    assert.equal(result.sessionVersion, 0);
    assert.equal(await bcrypt.compare('configured-admin-password', storedValue.passwordHash), true);
    assert.equal(await bcrypt.compare('configured-recovery-key', storedValue.recoveryKeyHash), true);
    assert.equal(storedValue.password, undefined);
    assert.equal(storedValue.recoveryKey, undefined);
    assert.equal(storedValue.ADMIN_PASSWORD, undefined);
    assert.equal(storedValue.ADMIN_RECOVERY_KEY, undefined);
  } finally {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('Admin credential sync is idempotent when the database already matches the environment', async () => {
  const previousEnv = {
    ADMIN_EMAIL: process.env.ADMIN_EMAIL,
    ADMIN_PASSWORD: process.env.ADMIN_PASSWORD,
    ADMIN_RECOVERY_KEY: process.env.ADMIN_RECOVERY_KEY,
    NODE_ENV: process.env.NODE_ENV,
    MONGO_URI: process.env.MONGO_URI
  };
  process.env.ADMIN_EMAIL = 'configured-admin@example.test';
  process.env.ADMIN_PASSWORD = 'configured-admin-password';
  process.env.ADMIN_RECOVERY_KEY = 'configured-recovery-key';
  process.env.NODE_ENV = 'production';
  process.env.MONGO_URI = 'mongodb://admin-sync.test';

  const stored = {
    email: 'configured-admin@example.test',
    passwordHash: await bcrypt.hash('configured-admin-password', 4),
    recoveryKeyHash: await bcrypt.hash('configured-recovery-key', 4),
    sessionVersion: 3
  };
  let updateCount = 0;
  models.Admin.findById = () => query(stored);
  models.Admin.findOneAndUpdate = async () => {
    updateCount += 1;
    return stored;
  };

  try {
    const result = await rideHailing.syncAdminSecurity();
    assert.equal(result.updated, false);
    assert.equal(result.sessionVersion, 3);
    assert.equal(updateCount, 0);
  } finally {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('Admin credential sync repairs stale backup hashes and invalidates old sessions', async () => {
  const previousEnv = {
    ADMIN_EMAIL: process.env.ADMIN_EMAIL,
    ADMIN_PASSWORD: process.env.ADMIN_PASSWORD,
    ADMIN_RECOVERY_KEY: process.env.ADMIN_RECOVERY_KEY,
    NODE_ENV: process.env.NODE_ENV,
    MONGO_URI: process.env.MONGO_URI
  };
  process.env.ADMIN_EMAIL = 'configured-admin@example.test';
  process.env.ADMIN_PASSWORD = 'configured-admin-password';
  process.env.ADMIN_RECOVERY_KEY = 'configured-recovery-key';
  process.env.NODE_ENV = 'production';
  process.env.MONGO_URI = 'mongodb://admin-sync.test';

  const stored = {
    email: 'restored-old-admin@example.test',
    passwordHash: await bcrypt.hash('restored-old-password', 4),
    recoveryKeyHash: await bcrypt.hash('restored-old-recovery-key', 4),
    sessionVersion: 7
  };
  let updatedValue;
  models.Admin.findById = () => query(stored);
  models.Admin.findOneAndUpdate = async (_filter, update) => {
    updatedValue = update.$set;
    return updatedValue;
  };

  try {
    const result = await rideHailing.syncAdminSecurity();
    assert.equal(result.updated, true);
    assert.equal(updatedValue.email, 'configured-admin@example.test');
    assert.equal(updatedValue.sessionVersion, 8);
    assert.equal(await bcrypt.compare('configured-admin-password', updatedValue.passwordHash), true);
    assert.equal(await bcrypt.compare('configured-recovery-key', updatedValue.recoveryKeyHash), true);
    assert.equal(await bcrypt.compare('restored-old-password', updatedValue.passwordHash), false);
    assert.equal(await bcrypt.compare('restored-old-recovery-key', updatedValue.recoveryKeyHash), false);
  } finally {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('dedicated Admin credentials remain usable when environment bootstrap values are absent', async () => {
  const previousEnv = {
    ADMIN_EMAIL: process.env.ADMIN_EMAIL,
    ADMIN_PASSWORD: process.env.ADMIN_PASSWORD,
    ADMIN_RECOVERY_KEY: process.env.ADMIN_RECOVERY_KEY,
    NODE_ENV: process.env.NODE_ENV,
    MONGO_URI: process.env.MONGO_URI,
    DEMO_ACCOUNTS_ENABLED: process.env.DEMO_ACCOUNTS_ENABLED
  };
  delete process.env.ADMIN_EMAIL;
  delete process.env.ADMIN_PASSWORD;
  delete process.env.ADMIN_RECOVERY_KEY;
  process.env.NODE_ENV = 'production';
  process.env.MONGO_URI = 'mongodb://admin-sync.test';
  delete process.env.DEMO_ACCOUNTS_ENABLED;

  const stored = {
    email: 'admin@myride.com',
    passwordHash: await bcrypt.hash('database-admin-password', 4),
    recoveryKeyHash: await bcrypt.hash('database-recovery-key', 4),
    sessionVersion: 2
  };
  let updateCount = 0;
  models.Admin.findById = () => query(stored);
  models.Admin.findOneAndUpdate = async () => {
    updateCount += 1;
    return stored;
  };

  try {
    const result = await rideHailing.syncAdminSecurity();
    assert.equal(result.updated, false);
     assert.equal(result.email, 'admin@myride.com');
    assert.equal(result.passwordConfigured, true);
    assert.equal(result.recoveryKeyConfigured, true);
    assert.equal(updateCount, 0);

    await withServer(async server => {
      const login = await request(server, '/api/admin/login', {
        method: 'POST',
        body: JSON.stringify({
         email: 'admin@myride.com',
          password: 'database-admin-password'
        })
      });
      assert.equal(login.response.status, 200);
    });
  } finally {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('invalid Admin environment credentials fail synchronization without exposing their values', async () => {
  const previousEnv = {
    ADMIN_EMAIL: process.env.ADMIN_EMAIL,
    ADMIN_PASSWORD: process.env.ADMIN_PASSWORD,
    ADMIN_RECOVERY_KEY: process.env.ADMIN_RECOVERY_KEY,
    NODE_ENV: process.env.NODE_ENV,
    MONGO_URI: process.env.MONGO_URI
  };
  process.env.ADMIN_EMAIL = 'configured-admin@example.test';
  process.env.ADMIN_PASSWORD = 'short';
  process.env.ADMIN_RECOVERY_KEY = 'short-key';
  process.env.NODE_ENV = 'production';
  process.env.MONGO_URI = 'mongodb://admin-sync.test';

  try {
    await assert.rejects(
      () => rideHailing.syncAdminSecurity(),
      error => {
        assert.match(error.message, /ADMIN_PASSWORD must be at least 10 characters/);
        assert.match(error.message, /ADMIN_RECOVERY_KEY must be at least 12 characters/);
        assert.doesNotMatch(error.message, /short-key/);
        return true;
      }
    );
  } finally {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('environment-managed Admin credentials reject database-only password and recovery-key changes', async () => {
  const previousEnv = {
    ADMIN_EMAIL: process.env.ADMIN_EMAIL,
    ADMIN_PASSWORD: process.env.ADMIN_PASSWORD,
    ADMIN_RECOVERY_KEY: process.env.ADMIN_RECOVERY_KEY,
    NODE_ENV: process.env.NODE_ENV,
    MONGO_URI: process.env.MONGO_URI
  };
  process.env.ADMIN_EMAIL = 'configured-admin@example.test';
  process.env.ADMIN_PASSWORD = 'configured-admin-password';
  process.env.ADMIN_RECOVERY_KEY = 'configured-recovery-key';
  process.env.NODE_ENV = 'production';
  process.env.MONGO_URI = 'mongodb://admin-sync.test';

  const stored = {
    email: 'configured-admin@example.test',
    passwordHash: await bcrypt.hash('configured-admin-password', 4),
    recoveryKeyHash: await bcrypt.hash('configured-recovery-key', 4),
    sessionVersion: 4
  };
  let updateCount = 0;
  models.Admin.findById = () => query(stored);
  models.Admin.findOneAndUpdate = async () => {
    updateCount += 1;
    return stored;
  };
  const token = jwt.sign({
    id: 'super-admin',
    isAdmin: true,
    isSuperAdmin: true,
    email: stored.email,
    adminSessionVersion: stored.sessionVersion
  }, JWT_SECRET);

  try {
    await withServer(async server => {
      const passwordChange = await request(server, '/api/admin/security/password', {
        method: 'PATCH',
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({
          currentPassword: 'configured-admin-password',
          newPassword: 'another-admin-password'
        })
      });
      assert.equal(passwordChange.response.status, 409);

      const recoveryChange = await request(server, '/api/admin/security/recovery-key', {
        method: 'PUT',
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({
          currentPassword: 'configured-admin-password',
          recoveryKey: 'another-recovery-key'
        })
      });
      assert.equal(recoveryChange.response.status, 409);

      const passwordReset = await request(server, '/api/admin/forgot-password', {
        method: 'POST',
        body: JSON.stringify({
          email: stored.email,
          recoveryKey: 'configured-recovery-key',
          newPassword: 'another-admin-password'
        })
      });
      assert.equal(passwordReset.response.status, 409);
      assert.equal(updateCount, 0);
    });
  } finally {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('Admin password changes require a fresh emailed OTP and throttle resend requests', async () => {
  const previousEnv = {
    ADMIN_EMAIL: process.env.ADMIN_EMAIL,
    ADMIN_PASSWORD: process.env.ADMIN_PASSWORD,
    ADMIN_RECOVERY_KEY: process.env.ADMIN_RECOVERY_KEY,
    SMTP_HOST: process.env.SMTP_HOST,
    SMTP_USER: process.env.SMTP_USER,
    SMTP_PASS: process.env.SMTP_PASS,
    EMAIL_FROM: process.env.EMAIL_FROM,
    NODE_ENV: process.env.NODE_ENV,
    MONGO_URI: process.env.MONGO_URI,
    DEMO_ACCOUNTS_ENABLED: process.env.DEMO_ACCOUNTS_ENABLED
  };
  process.env.ADMIN_EMAIL = 'admin-otp@example.test';
  delete process.env.ADMIN_PASSWORD;
  delete process.env.ADMIN_RECOVERY_KEY;
  process.env.SMTP_HOST = 'smtp.test';
  process.env.SMTP_USER = 'admin@example.test';
  process.env.SMTP_PASS = 'test-smtp-password';
  process.env.EMAIL_FROM = 'admin@example.test';
  process.env.NODE_ENV = 'development';
  delete process.env.MONGO_URI;
  delete process.env.DEMO_ACCOUNTS_ENABLED;

  const security = {
    email: process.env.ADMIN_EMAIL,
    passwordHash: bcrypt.hashSync('current-admin-password', 4),
    recoveryKeyHash: bcrypt.hashSync('existing-recovery-key', 4),
    sessionVersion: 0
  };
  const sentMail = [];
  let updateCount = 0;
  models.Admin.findById = () => query(security);
  models.Admin.findOneAndUpdate = async (_filter, update) => {
    updateCount += 1;
    Object.assign(security, update.$set);
    return { ...security };
  };
  setEmailTransporterForTests({ sendMail: async mail => { sentMail.push(mail); } });

  try {
    await withServer(async server => {
      const login = await request(server, '/api/admin/login', {
        method: 'POST',
        body: JSON.stringify({
          email: security.email,
          password: 'current-admin-password'
        })
      });
      assert.equal(login.response.status, 200);
      const token = login.body.token;

      const missingOtp = await request(server, '/api/admin/security/password', {
        method: 'PATCH',
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({
          currentPassword: 'current-admin-password',
          newPassword: 'new-admin-password'
        })
      });
      assert.equal(missingOtp.response.status, 400);
      assert.equal(updateCount, 0);

      const firstRequest = await request(server, '/api/admin/security/otp/request', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: 'password' })
      });
      assert.equal(firstRequest.response.status, 200);
      assert.equal(firstRequest.body.otp, undefined);
      assert.doesNotMatch(JSON.stringify(firstRequest.body), /\d{6}/);
      assert.match(sentMail.at(-1).text, /\b\d{6}\b/);
      const otp = sentMail.at(-1).text.match(/\b\d{6}\b/)[0];

      const wrongOtp = await request(server, '/api/admin/security/password', {
        method: 'PATCH',
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({
          currentPassword: 'current-admin-password',
          newPassword: 'new-admin-password',
          otp: '000000'
        })
      });
      assert.equal(wrongOtp.response.status, 401);
      assert.equal(updateCount, 0);

      const changed = await request(server, '/api/admin/security/password', {
        method: 'PATCH',
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({
          currentPassword: 'current-admin-password',
          newPassword: 'new-admin-password',
          otp
        })
      });
      assert.equal(changed.response.status, 200);
      assert.equal(security.sessionVersion, 1);
      assert.equal(await bcrypt.compare('new-admin-password', security.passwordHash), true);

      const replay = await request(server, '/api/admin/security/password', {
        method: 'PATCH',
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({
          currentPassword: 'current-admin-password',
          newPassword: 'another-admin-password',
          otp
        })
      });
      assert.equal(replay.response.status, 401);

      const currentToken = (await request(server, '/api/admin/login', {
        method: 'POST',
        body: JSON.stringify({ email: security.email, password: 'new-admin-password' })
      })).body.token;
      for (let attempt = 0; attempt < 2; attempt++) {
        const resend = await request(server, '/api/admin/security/otp/request', {
          method: 'POST',
          headers: { authorization: `Bearer ${currentToken}` },
          body: JSON.stringify({ action: 'password' })
        });
        assert.equal(resend.response.status, 200);
      }
      const rateLimited = await request(server, '/api/admin/security/otp/request', {
        method: 'POST',
        headers: { authorization: `Bearer ${currentToken}` },
        body: JSON.stringify({ action: 'password' })
      });
      assert.equal(rateLimited.response.status, 429);
    });
  } finally {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
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