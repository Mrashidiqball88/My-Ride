'use strict';

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const service = require('../server');

const { app, models } = service;
const JWT_SECRET = 'ride-hailing-secret-fallback';
const original = {
  settingsFindOne: models.Settings.findOne,
  settingsFindOneAndUpdate: models.Settings.findOneAndUpdate,
  adminFindById: models.Admin.findById,
  rideDeleteMany: models.Ride.deleteMany,
  userFind: models.User.find
};

afterEach(() => {
  models.Settings.findOne = original.settingsFindOne;
  models.Settings.findOneAndUpdate = original.settingsFindOneAndUpdate;
  models.Admin.findById = original.adminFindById;
  models.Ride.deleteMany = original.rideDeleteMany;
  models.User.find = original.userFind;
});

function token(overrides = {}) {
  return jwt.sign({ id: 'admin-1', isAdmin: true, isSuperAdmin: true, ...overrides }, JWT_SECRET);
}

async function request(server, path, options = {}) {
  models.Admin.findById = () => ({ lean: async () => ({ email: 'admin@myride.com', sessionVersion: 0 }) });
  const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token()}`, ...(options.headers || {}) }
  });
  return { response, body: await response.json() };
}

test('ride retention purges only old completed and cancelled rides', async () => {
  let query;
  models.Settings.findOne = () => ({ lean: async () => ({ value: { days: 30 } }) });
  models.Ride.deleteMany = async filter => { query = filter; return { deletedCount: 2 }; };

  const server = app.listen(0);
  try {
    const result = await request(server, '/api/admin/ride-retention/purge', { method: 'POST' });
    assert.equal(result.response.status, 200);
    assert.equal(result.body.deletedCount, 2);
    assert.deepEqual(query.status, { $in: ['completed', 'cancelled'] });
    assert.ok(query.createdAt.$lt instanceof Date);
    assert.equal(query.createdAt.$lt.getTime() <= Date.now() - (30 * 24 * 60 * 60 * 1000), true);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('ride retention rejects invalid periods without mutating settings', async () => {
  let updates = 0;
  models.Settings.findOne = () => ({ lean: async () => ({ value: { days: 30 } }) });
  models.Settings.findOneAndUpdate = async () => { updates += 1; };
  const server = app.listen(0);
  try {
    const invalid = await request(server, '/api/admin/ride-retention', {
      method: 'PATCH',
      body: JSON.stringify({ days: 0 })
    });
    assert.equal(invalid.response.status, 422);
    assert.equal(updates, 0);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('Admin global search matches identity and vehicle fields without returning private customer file paths', async () => {
  let filter;
  models.Settings.findOne = () => ({ lean: async () => ({ value: { sessionVersion: 0 } }) });
  models.User.find = input => {
    filter = input;
    const chain = {
      select: () => chain,
      sort: () => chain,
      limit: () => chain,
      lean: async () => [{
        _id: 'customer-1',
        name: 'Ayesha',
        role: 'customer',
        customerIdFront: '/private/customer_identity/front.jpg',
        customerIdBack: '/private/customer_identity/back.jpg'
      }]
    };
    return chain;
  };
  const server = app.listen(0);
  try {
    const result = await request(server, '/api/admin/search?q=35202');
    assert.equal(result.response.status, 200);
    assert.equal(result.body[0].hasCustomerIdentityDocuments, true);
    assert.equal('customerIdFront' in result.body[0], false);
    assert.equal('customerIdBack' in result.body[0], false);
    assert.ok(filter.$and[1].$or.some(condition => condition.cnicNumber));
    assert.ok(filter.$and[1].$or.some(condition => condition.vehiclePlate));
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});