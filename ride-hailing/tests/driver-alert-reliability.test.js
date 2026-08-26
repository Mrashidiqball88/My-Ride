'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { io: connectClient } = require('socket.io-client');
const service = require('../server');

const { server, models } = service;
const originals = {
  userFindById: models.User.findById,
  userUpdateOne: models.User.updateOne,
  rideFind: models.Ride.find,
  rideFindOne: models.Ride.findOne,
  settingsFindOne: models.Settings.findOne,
  walletFindOne: models.Wallet.findOne,
};

function query(value) {
  return {
    select() { return this; },
    populate() { return this; },
    sort() { return Promise.resolve(value); },
    lean: async () => value,
  };
}

function token() {
  return jwt.sign({
    id: '507f1f77bcf86cd799439011',
    role: 'driver',
    name: 'Driver',
  }, 'ride-hailing-secret-fallback');
}

function restore() {
  models.User.findById = originals.userFindById;
  models.User.updateOne = originals.userUpdateOne;
  models.Ride.find = originals.rideFind;
  models.Ride.findOne = originals.rideFindOne;
  models.Settings.findOne = originals.settingsFindOne;
  models.Wallet.findOne = originals.walletFindOne;
}

test('driver reconnect replays open offers and heartbeat ack preserves client correlation', async () => {
  const updates = [];
  const driver = {
    _id: '507f1f77bcf86cd799439011',
    activeSessionToken: 'test-session',
    accountStatus: 'active',
    isOnline: true,
    vehicleType: 'Car Mini Non-AC',
    ridePreference: 'Both',
    longRangeEnabled: false,
    lastOnlineHeartbeat: new Date(),
    currentLocation: { lat: 31.5204, lng: 74.3587 },
  };
  const ride = {
    _id: '507f1f77bcf86cd799439099',
    pickupLocation: { address: 'Mall Road', lat: 31.5205, lng: 74.3588 },
    dropoffLocation: { address: 'Gulberg', lat: 31.5100, lng: 74.3500 },
    dropoffLocations: [],
    fare: 500,
    distance: 4,
    duration: 15,
    paymentMethod: 'cash',
    vehicleType: 'Car Mini Non-AC',
    isLongRange: false,
    broadcastExpiresAt: new Date(Date.now() + 45_000),
    status: 'requested',
    passenger: { _id: '507f1f77bcf86cd799439088', name: 'Customer' },
  };

  models.User.findById = () => ({
    select(fields) {
      return query(fields === 'activeSessionToken' ? { activeSessionToken: driver.activeSessionToken } : driver);
    },
  });
  models.User.updateOne = async (_query, update) => {
    updates.push(update);
    return { acknowledged: true };
  };
  models.Ride.findOne = () => query(null);
  models.Ride.find = () => query([ride]);
  models.Settings.findOne = () => ({ lean: async () => null });
  models.Wallet.findOne = () => query({ balance: 0 });

  await new Promise(resolve => server.listen(0, resolve));
  const client = connectClient(`http://127.0.0.1:${server.address().port}`, {
    auth: { token: token(), sessionToken: 'test-session' },
    transports: ['websocket'],
    reconnection: false,
  });
  const events = [];
  client.on('driver:rehydrate', payload => events.push(['rehydrate', payload]));
  client.on('ride:new', payload => events.push(['ride:new', payload]));

  try {
    await new Promise((resolve, reject) => {
      client.once('connect', resolve);
      client.once('connect_error', reject);
    });
    await new Promise(resolve => setTimeout(resolve, 30));
    const replay = events.find(([event]) => event === 'ride:new');
    assert.ok(replay, 'a still-open eligible ride is replayed after connect');
    assert.equal(replay[1].id, ride._id);
    assert.deepEqual(events.find(([event]) => event === 'rehydrate')?.[1].pendingRideIds, [ride._id]);

    const heartbeatAck = new Promise(resolve => client.once('driver:heartbeat:ack', resolve));
    client.emit('driver:heartbeat', { clientSentAt: 'client-123' });
    const ack = await heartbeatAck;
    assert.equal(ack.clientSentAt, 'client-123');
    assert.ok(ack.serverTime);
    assert.ok(updates.some(update => update.lastOnlineHeartbeat instanceof Date));
  } finally {
    client.close();
    await new Promise(resolve => server.close(resolve));
    restore();
  }
});