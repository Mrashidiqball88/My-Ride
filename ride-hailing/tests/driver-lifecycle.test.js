'use strict';

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const service = require('../server');

const { app, models } = service;
const original = {
  userFindById: models.User.findById,
  userUpdateOne: models.User.updateOne,
  walletFindOne: models.Wallet.findOne,
};

afterEach(() => {
  models.User.findById = original.userFindById;
  models.User.updateOne = original.userUpdateOne;
  models.Wallet.findOne = original.walletFindOne;
});

function driverToken() {
  return jwt.sign({ id: '507f1f77bcf86cd799439011', role: 'driver', accountStatus: 'active', name: 'Driver' }, 'ride-hailing-secret-fallback');
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