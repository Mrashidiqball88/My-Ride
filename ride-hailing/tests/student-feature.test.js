'use strict';

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const jwt = require('jsonwebtoken');

const feature = require('../server');
const {
  app, models, normalizeStudentDiscountSettings,
  applyStudentDiscountToFareQuote, customerRegistrationAccountStatus,
  getVerifiedStudentDiscountPercent,
  FARE_VEHICLE_CATEGORIES
} = feature;

const JWT_SECRET = 'ride-hailing-secret-fallback';
const originalSettingsFindOne = models.Settings.findOne;
const originalSettingsUpdate = models.Settings.findOneAndUpdate;
const originalAdminFindById = models.Admin.findById;
const originalUserFindById = models.User.findById;
const originalUserFind = models.User.find;
const originalUserFindOneAndUpdate = models.User.findOneAndUpdate;
const originalUserFindByIdAndUpdate = models.User.findByIdAndUpdate;
const originalRideCountDocuments = models.Ride.countDocuments;

afterEach(() => {
  models.Settings.findOne = originalSettingsFindOne;
  models.Settings.findOneAndUpdate = originalSettingsUpdate;
  models.Admin.findById = originalAdminFindById;
  models.User.findById = originalUserFindById;
  models.User.find = originalUserFind;
  models.User.findOneAndUpdate = originalUserFindOneAndUpdate;
  models.User.findByIdAndUpdate = originalUserFindByIdAndUpdate;
  models.Ride.countDocuments = originalRideCountDocuments;
});

function adminToken() {
  return jwt.sign({ id: 'admin-1', isAdmin: true, email: 'admin@example.test' }, JWT_SECRET);
}

async function request(server, path, options = {}) {
  const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) }
  });
  return { response, body: await response.json() };
}

test('student discount normalization is bounded and fare breakdown is auditable', () => {
  assert.equal(customerRegistrationAccountStatus(false, true), 'active');
  assert.equal(customerRegistrationAccountStatus(true, true), 'pending');
  assert.equal(customerRegistrationAccountStatus(false, false), 'pending');
  assert.deepEqual(normalizeStudentDiscountSettings({ discountPercent: -4 }), {
    enabled: true,
    discountPercent: 0,
    maxDiscountedRidesPerDay: 2,
    startTime: '06:00',
    endTime: '17:00'
  });
  assert.deepEqual(normalizeStudentDiscountSettings({
    enabled: false,
    discountPercent: 125,
    maxDiscountedRidesPerDay: 3,
    startTime: '07:30',
    endTime: '18:45'
  }), {
    enabled: false,
    discountPercent: 100,
    maxDiscountedRidesPerDay: 3,
    startTime: '07:30',
    endTime: '18:45'
  });
  const quote = applyStudentDiscountToFareQuote({ totalFare: 500, subtotal: 500 }, 15);
  assert.equal(quote.totalBeforeDiscount, 500);
  assert.equal(quote.studentDiscountPercent, 15);
  assert.equal(quote.studentDiscountAmount, 75);
  assert.equal(quote.payableFare, 425);
  assert.equal(quote.totalFare, 425);
});

test('student registration rejects missing mandatory Student ID details', async () => {
  models.Settings.findOne = ({ key }) => ({
    lean: async () => key === 'student_discount_settings'
      ? { value: { enabled: true, discountPercent: 10 } }
      : null
  });
  const server = app.listen(0);
  try {
    const result = await request(server, '/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Student Example',
        email: 'student-feature@example.test',
        password: 'password123',
        phone: '03001234567',
        role: 'customer',
        cnicNumber: '3520212345671',
        cnicFront: 'data:image/jpeg;base64,AA==',
        cnicBack: 'data:image/jpeg;base64,AA==',
        isStudent: true
      })
    });
    assert.equal(result.response.status, 400);
    assert.match(result.body.error, /Student ID number is required/);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('Admin student discount setting accepts valid values and rejects out-of-range values', async () => {
  let stored = null;
  models.Admin.findById = () => ({ lean: async () => ({ email: 'admin@example.test', sessionVersion: 0 }) });
  models.Settings.findOne = () => ({ lean: async () => stored ? { value: stored } : null });
  models.Settings.findOneAndUpdate = async (_query, update) => {
    stored = update.value;
    return { value: stored };
  };
  const server = app.listen(0);
  try {
    const saved = await request(server, '/api/admin/student-discount-settings', {
      method: 'PATCH',
      headers: { authorization: `Bearer ${adminToken()}` },
      body: JSON.stringify({
        discountPercent: 20,
        maxDiscountedRidesPerDay: 3,
        startTime: '06:00',
        endTime: '17:00'
      })
    });
    assert.equal(saved.response.status, 200);
    assert.equal(saved.body.settings.discountPercent, 20);
    assert.equal(saved.body.settings.enabled, true);
    assert.equal(saved.body.settings.maxDiscountedRidesPerDay, 3);
    assert.equal(saved.body.settings.startTime, '06:00');
    assert.equal(saved.body.settings.endTime, '17:00');

    const disabled = await request(server, '/api/admin/student-discount-settings', {
      method: 'PATCH',
      headers: { authorization: `Bearer ${adminToken()}` },
      body: JSON.stringify({ enabled: false, discountPercent: 20 })
    });
    assert.equal(disabled.response.status, 200);
    assert.equal(disabled.body.settings.enabled, false);
    assert.equal(disabled.body.settings.maxDiscountedRidesPerDay, 3);
    assert.equal(disabled.body.settings.startTime, '06:00');
    assert.equal(disabled.body.settings.endTime, '17:00');

    const rejected = await request(server, '/api/admin/student-discount-settings', {
      method: 'PATCH',
      headers: { authorization: `Bearer ${adminToken()}` },
      body: JSON.stringify({ discountPercent: 101 })
    });
    assert.equal(rejected.response.status, 422);

    const invalidLimit = await request(server, '/api/admin/student-discount-settings', {
      method: 'PATCH',
      headers: { authorization: `Bearer ${adminToken()}` },
      body: JSON.stringify({ discountPercent: 20, maxDiscountedRidesPerDay: 1.5 })
    });
    assert.equal(invalidLimit.response.status, 422);

    const invalidTime = await request(server, '/api/admin/student-discount-settings', {
      method: 'PATCH',
      headers: { authorization: `Bearer ${adminToken()}` },
      body: JSON.stringify({ discountPercent: 20, startTime: '25:00', endTime: '17:00' })
    });
    assert.equal(invalidTime.response.status, 422);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('student discount honors the UTC time window and completed daily ride limit', async () => {
  let completedDiscountedRides = 0;
  let countQuery = null;
  models.Settings.findOne = ({ key }) => ({
    lean: async () => key === 'student_discount_settings'
      ? {
          value: {
            enabled: true,
            discountPercent: 10,
            maxDiscountedRidesPerDay: 2,
            startTime: '06:00',
            endTime: '17:00'
          }
        }
      : null
  });
  models.User.findById = () => ({
    select: () => ({
      lean: async () => ({
        role: 'customer',
        isStudent: true,
        studentVerificationStatus: 'approved'
      })
    })
  });
  models.Ride.countDocuments = async query => {
    countQuery = query;
    return completedDiscountedRides;
  };

  const insideWindow = new Date('2026-09-05T08:00:00.000Z');
  assert.equal(await getVerifiedStudentDiscountPercent('student-1', insideWindow), 10);
  assert.equal(countQuery.status, 'completed');
  assert.deepEqual(countQuery['fareQuote.studentDiscountPercent'], { $gt: 0 });
  assert.equal(countQuery.settledAt.$gte.toISOString(), '2026-09-05T00:00:00.000Z');
  assert.equal(countQuery.settledAt.$lt.toISOString(), '2026-09-06T00:00:00.000Z');

  completedDiscountedRides = 2;
  assert.equal(await getVerifiedStudentDiscountPercent('student-1', insideWindow), 0);

  completedDiscountedRides = 0;
  assert.equal(
    await getVerifiedStudentDiscountPercent('student-1', new Date('2026-09-05T17:00:00.000Z')),
    0
  );
});

test('Student registration is rejected while the master Student feature is disabled', async () => {
  models.Settings.findOne = ({ key }) => ({
    lean: async () => key === 'student_discount_settings'
      ? { value: { enabled: false, discountPercent: 20 } }
      : null
  });
  const server = app.listen(0);
  try {
    const result = await request(server, '/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ name: 'Student Example', email: 'disabled-student@example.test', password: 'password123', phone: '03001234567', role: 'customer', isStudent: true })
    });
    assert.equal(result.response.status, 403);
    assert.match(result.body.error, /Student registration is currently disabled/);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('fare calculation applies the discount only to an approved Customer', async () => {
  const category = FARE_VEHICLE_CATEGORIES[0];
  const fareSettings = Object.fromEntries(FARE_VEHICLE_CATEGORIES.map(name => [name, {
    baseFare: 100,
    distanceSlabs: [{ minKm: 0, maxKm: null, rate: 100 }],
    peakRules: []
  }]));
  const settingValue = key => {
    if (key === 'daily_fare_settings') return fareSettings;
    if (key === 'per_km_rates') return {};
    if (key === 'student_discount_settings') {
      return {
        enabled: true,
        discountPercent: 10,
        maxDiscountedRidesPerDay: 2,
        startTime: '00:00',
        endTime: '23:59'
      };
    }
    return null;
  };
  models.Settings.findOne = ({ key }) => ({ lean: async () => ({ value: settingValue(key) }) });
  models.Ride.countDocuments = async () => 0;
  const server = app.listen(0);
  try {
    models.User.findById = () => ({
      select: () => ({ lean: async () => ({
        role: 'customer',
        isStudent: true,
        studentVerificationStatus: 'pending'
      }) })
    });
    const unverified = await request(server, '/api/fare/calculate', {
      method: 'POST',
      headers: { authorization: `Bearer ${jwt.sign({ id: 'student-1', role: 'customer' }, JWT_SECRET)}` },
      body: JSON.stringify({ vehicleType: category, distanceKm: 1 })
    });
    assert.equal(unverified.response.status, 200);
    assert.equal(unverified.body.studentDiscountPercent, 0);
    assert.equal(unverified.body.totalBeforeDiscount, unverified.body.totalFare);

    models.User.findById = () => ({
      select: () => ({ lean: async () => ({
        role: 'customer',
        isStudent: true,
        studentVerificationStatus: 'approved'
      }) })
    });
    const verified = await request(server, '/api/fare/calculate', {
      method: 'POST',
      headers: { authorization: `Bearer ${jwt.sign({ id: 'student-1', role: 'customer' }, JWT_SECRET)}` },
      body: JSON.stringify({ vehicleType: category, distanceKm: 1 })
    });
    assert.equal(verified.response.status, 200);
    assert.equal(verified.body.studentDiscountPercent, 10);
    assert.equal(verified.body.studentDiscountAmount, Math.round(verified.body.totalBeforeDiscount * 0.1));
    assert.equal(verified.body.payableFare, verified.body.totalFare);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('disabled global student discounts produce a zero server-authoritative discount', async () => {
  const category = FARE_VEHICLE_CATEGORIES[0];
  const fareSettings = Object.fromEntries(FARE_VEHICLE_CATEGORIES.map(name => [name, {
    baseFare: 100,
    distanceSlabs: [{ minKm: 0, maxKm: null, rate: 100 }],
    peakRules: []
  }]));
  models.Settings.findOne = ({ key }) => ({
    lean: async () => key === 'daily_fare_settings'
      ? { value: fareSettings }
      : key === 'student_discount_settings'
        ? { value: { enabled: false, discountPercent: 50 } }
        : { value: {} }
  });
  models.User.findById = () => ({
    select: () => ({ lean: async () => ({
      role: 'customer', isStudent: true, studentVerificationStatus: 'approved'
    }) })
  });
  models.Ride.countDocuments = async () => 0;
  const server = app.listen(0);
  try {
    const result = await request(server, '/api/fare/calculate', {
      method: 'POST',
      headers: { authorization: `Bearer ${jwt.sign({ id: 'student-1', role: 'customer' }, JWT_SECRET)}` },
      body: JSON.stringify({ vehicleType: category, distanceKm: 1 })
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.body.studentDiscountPercent, 0);
    assert.equal(result.body.studentDiscountAmount, 0);
    assert.equal(result.body.payableFare, result.body.totalBeforeDiscount);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('Admin can list and approve a pending Student application', async () => {
  models.Admin.findById = () => ({ lean: async () => ({ email: 'admin@example.test', sessionVersion: 0 }) });
  const student = {
    _id: 'student-1',
    name: 'Student Example',
    email: 'student-feature@example.test',
    role: 'customer',
    isStudent: true,
    studentVerificationStatus: 'pending',
    studentIdNumber: 'STU-123',
    studentInstitution: 'Example University',
    cnicNumber: '3520212345671',
    customerIdFront: 'front.jpg',
    customerIdBack: 'back.jpg',
    studentIdImage: 'student-id.jpg'
  };
  models.User.find = () => ({
    select() { return this; },
    sort() { return this; },
    limit() { return this; },
    lean: async () => [student]
  });
  let updatedStatus = null;
  models.User.findOneAndUpdate = () => ({
    select: async () => ({
      ...student,
      studentVerificationStatus: updatedStatus,
      accountStatus: updatedStatus === 'approved' ? 'active' : 'pending'
    })
  });
  const server = app.listen(0);
  try {
    const listed = await request(server, '/api/admin/student-approvals?status=pending', {
      headers: { authorization: `Bearer ${adminToken()}` }
    });
    assert.equal(listed.response.status, 200);
    assert.equal(listed.body[0].hasStudentIdImage, true);
    assert.equal(listed.body[0].studentIdImage, undefined);

    updatedStatus = 'approved';
    const approved = await request(server, '/api/admin/student-approvals/student-1', {
      method: 'PATCH',
      headers: { authorization: `Bearer ${adminToken()}` },
      body: JSON.stringify({ status: 'approved' })
    });
    assert.equal(approved.response.status, 200);
    assert.equal(approved.body.user.studentVerificationStatus, 'approved');
    assert.equal(approved.body.user.accountStatus, 'active');

    updatedStatus = 'rejected';
    const rejected = await request(server, '/api/admin/student-approvals/student-1', {
      method: 'PATCH',
      headers: { authorization: `Bearer ${adminToken()}` },
      body: JSON.stringify({ status: 'rejected' })
    });
    assert.equal(rejected.response.status, 200);
    assert.equal(rejected.body.user.studentVerificationStatus, 'rejected');
    assert.equal(rejected.body.user.accountStatus, 'pending');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('generic Customer activation cannot bypass Student Approval', async () => {
  models.Admin.findById = () => ({ lean: async () => ({ email: 'admin@example.test', sessionVersion: 0 }) });
  models.User.findById = () => ({
    select: async () => ({
      role: 'customer',
      isStudent: true,
      studentVerificationStatus: 'pending'
    })
  });
  let genericActivationCalled = false;
  models.User.findByIdAndUpdate = () => {
    genericActivationCalled = true;
    return { select: async () => ({}) };
  };
  const server = app.listen(0);
  try {
    const result = await request(server, '/api/admin/users/student-1/status', {
      method: 'PATCH',
      headers: { authorization: `Bearer ${adminToken()}` },
      body: JSON.stringify({ action: 'approve' })
    });
    assert.equal(result.response.status, 409);
    assert.equal(genericActivationCalled, false);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('Customer and Admin surfaces include student verification and fare breakdown controls', () => {
  const customer = fs.readFileSync('public/customer.html', 'utf8');
  const admin = fs.readFileSync('public/admin.html', 'utf8');
  assert.match(customer, /id="r-is-student"/);
  assert.match(customer, /id="r-student-id-image"/);
  assert.match(customer, /id="fare-total-before-discount"/);
  assert.match(customer, /id="fare-student-discount"/);
  assert.match(customer, /id="fare-payable-amount"/);
  assert.match(customer, /student-verification:updated/);
  assert.match(customer, /studentFeatureEnabled/);
  assert.match(admin, /id="sec-student-approvals"/);
  assert.match(admin, /\/api\/admin\/student-documents/);
  assert.match(admin, /id="student-discount-enabled"/);
  assert.match(admin, /Enable Student registration and discounts/);
  assert.match(admin, /Student review/);
  assert.match(admin, /id="student-discount-percent"/);
  assert.match(admin, /id="student-discount-daily-limit"/);
  assert.match(admin, /id="student-discount-start-time"/);
  assert.match(admin, /id="student-discount-end-time"/);
});