'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const previousRedisUrl = process.env.REDIS_URL;
delete process.env.REDIS_URL;

const redis = require('../lib/redisAcceleration');

after(async () => {
  await redis.closeRedisAcceleration();
  if (previousRedisUrl === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = previousRedisUrl;
});

test('Redis acceleration stays disabled cleanly when REDIS_URL is absent', async () => {
  assert.equal(await redis.startRedisAcceleration({ log: { log() {}, warn() {} } }), false);
  assert.deepEqual(redis.redisStatus(), {
    configured: false,
    ready: false,
    driverGeoKey: 'myride:drivers:geo',
    settingsPrefix: 'myride:settings:'
  });
});

test('Redis operations return safe fallback signals while unavailable', async () => {
  assert.equal(await redis.upsertDriverPresence({
    driverId: 'driver-unavailable',
    lat: 31.52,
    lng: 74.35,
    vehicleType: 'Car Mini'
  }), false);
  assert.equal(await redis.removeDriverPresence('driver-unavailable'), false);
  assert.equal(await redis.rebuildDriverGeoIndex([]), false);
  assert.equal(await redis.redisGetJson('missing'), null);
  assert.equal(await redis.redisSetJson('missing', { safe: true }), false);
  assert.equal(await redis.redisDelete('missing'), false);
  assert.equal(await redis.searchDriverIds({
    lat: 31.52,
    lng: 74.35,
    radiusKm: 5
  }), null);
});