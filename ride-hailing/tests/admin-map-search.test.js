'use strict';

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

const service = require('../server');
const { app, models } = service;
const JWT_SECRET = 'ride-hailing-secret-fallback';
const USER_ID = '507f1f77bcf86cd799439011';

const original = {
  settingsFindOne: models.Settings.findOne,
  adminFindById: models.Admin.findById,
  userFind: models.User.find,
  userFindById: models.User.findById,
  rideFindOne: models.Ride.findOne,
  subAdminFindById: models.SubAdmin.findById
};

afterEach(() => {
  models.Settings.findOne = original.settingsFindOne;
  models.Admin.findById = original.adminFindById;
  models.User.find = original.userFind;
  models.User.findById = original.userFindById;
  models.Ride.findOne = original.rideFindOne;
  models.SubAdmin.findById = original.subAdminFindById;
});

function superAdminToken() {
  return jwt.sign({ id: 'admin-1', isAdmin: true, email: 'admin@example.test' }, JWT_SECRET);
}

function driverOnlySubAdminToken() {
  return jwt.sign({ isSubAdmin: true, subAdminId: '507f1f77bcf86cd799439012', username: 'driver-viewer' }, JWT_SECRET);
}

function adminSecurityStub() {
  models.Admin.findById = () => ({ lean: async () => ({ email: 'admin@myride.com', sessionVersion: 0 }) });
}

function listQuery(items) {
  const chain = {
    select: () => chain,
    sort: () => chain,
    limit: () => chain,
    lean: async () => items
  };
  return chain;
}

function singleQuery(item) {
  const chain = {
    select: () => chain,
    sort: () => chain,
    lean: async () => item
  };
  return chain;
}

async function request(server, path, token) {
  const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    headers: { authorization: `Bearer ${token}` }
  });
  return { response, body: await response.json() };
}

test('Admin map search returns only a fresh online Driver location', async () => {
  adminSecurityStub();
  const now = new Date();
  models.User.find = () => listQuery([
    {
      _id: USER_ID, name: 'Fresh Driver', phone: '03001234567', role: 'driver',
      accountStatus: 'active', isOnline: true, lastOnlineHeartbeat: now,
      currentLocation: { lat: 31.5204, lng: 74.3587 }, vehicleType: 'Car Mini'
    },
    {
      _id: '507f1f77bcf86cd799439013', name: 'Stale Driver', role: 'driver',
      accountStatus: 'active', isOnline: true, lastOnlineHeartbeat: new Date(now.getTime() - 91_000),
      currentLocation: { lat: 31.5204, lng: 74.3587 }
    }
  ]);

  const server = app.listen(0);
  try {
    const result = await request(server, '/api/admin/map-search?q=driver', superAdminToken());
    assert.equal(result.response.status, 200);
    assert.equal(result.body.length, 1);
    assert.equal(result.body[0].name, 'Fresh Driver');
    assert.deepEqual(result.body[0].location, { lat: 31.5204, lng: 74.3587 });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('Admin map location supports active shared Customer locations and rejects role bypasses', async () => {
  adminSecurityStub();
  const customer = {
    _id: USER_ID, name: 'Active Customer', phone: '03007654321', role: 'customer',
    accountStatus: 'active'
  };
  models.User.findById = () => singleQuery(customer);
  models.Ride.findOne = () => singleQuery({
    status: 'in-progress',
    passengerLocation: { lat: 31.521, lng: 74.359 },
    passengerLocationUpdatedAt: new Date()
  });

  const server = app.listen(0);
  try {
    const allowed = await request(server, `/api/admin/map-location/${USER_ID}`, superAdminToken());
    assert.equal(allowed.response.status, 200);
    assert.equal(allowed.body.role, 'customer');
    assert.equal(allowed.body.status, 'in-progress');

    models.SubAdmin.findById = () => ({
      select: () => ({
        lean: async () => ({
          _id: '507f1f77bcf86cd799439012',
          username: 'driver-viewer',
          isBlocked: false,
          permissions: { viewDrivers: true }
        })
      })
    });
    const denied = await request(server, `/api/admin/map-location/${USER_ID}`, driverOnlySubAdminToken());
    assert.equal(denied.response.status, 403);
    assert.match(denied.body.error, /Permission denied/);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});