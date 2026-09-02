'use strict';

let createClient = null;
try {
  ({ createClient } = require('redis'));
} catch {
  // Redis is an optional acceleration layer. The MongoDB dispatcher must
  // remain importable when the optional client is not installed/configured.
}

const REDIS_NAMESPACE = String(process.env.REDIS_NAMESPACE || 'myride').trim() || 'myride';
const DRIVER_GEO_KEY = `${REDIS_NAMESPACE}:drivers:geo`;
const DRIVER_STATE_PREFIX = `${REDIS_NAMESPACE}:driver-state:`;
const SETTINGS_PREFIX = `${REDIS_NAMESPACE}:settings:`;
const DRIVER_STATE_TTL_SECONDS = Math.max(
  30,
  Number.parseInt(process.env.REDIS_DRIVER_STATE_TTL_SECONDS || '45', 10) || 45
);
const SETTINGS_TTL_SECONDS = Math.max(
  30,
  Number.parseInt(process.env.REDIS_SETTINGS_TTL_SECONDS || '300', 10) || 300
);

let client = null;
let redisReady = false;
let redisStartAttempted = false;
let lastRedisErrorAt = 0;
let logger = console;

function configuredRedisUrl() {
  return String(process.env.REDIS_URL || '').trim();
}

function driverStateKey(driverId) {
  return `${DRIVER_STATE_PREFIX}${String(driverId)}`;
}

function settingsKey(settingKey) {
  return `${SETTINGS_PREFIX}${String(settingKey)}`;
}

function logRedisError(error) {
  const now = Date.now();
  if (now - lastRedisErrorAt < 10_000) return;
  lastRedisErrorAt = now;
  logger.warn(`[redis] ${error?.message || error}`);
}

async function startRedisAcceleration({ log = console } = {}) {
  logger = log;
  if (redisStartAttempted) return redisReady;
  redisStartAttempted = true;

  const url = configuredRedisUrl();
  if (!url) {
    logger.log('[redis] REDIS_URL not configured; using MongoDB dispatch fallback');
    return false;
  }
  if (!createClient) {
    logger.warn('[redis] Redis client is unavailable; using MongoDB dispatch fallback');
    return false;
  }

  client = createClient({
    url,
    socket: {
      connectTimeout: 2_000,
      reconnectStrategy: retries => Math.min(5_000, 250 * Math.max(1, retries))
    }
  });
  client.on('ready', () => {
    redisReady = true;
    logger.log('[redis] ready');
  });
  client.on('end', () => {
    redisReady = false;
    logger.warn('[redis] connection ended; MongoDB fallback remains active');
  });
  client.on('reconnecting', () => {
    redisReady = false;
  });
  client.on('error', logRedisError);

  try {
    await client.connect();
    redisReady = client.isReady;
  } catch (error) {
    redisReady = false;
    logRedisError(error);
  }
  return redisReady;
}

function isRedisReady() {
  return Boolean(redisReady && client?.isReady);
}

async function redisGetJson(key) {
  if (!isRedisReady()) return null;
  try {
    const value = await client.get(key);
    return value === null ? null : JSON.parse(value);
  } catch (error) {
    logRedisError(error);
    return null;
  }
}

async function redisSetJson(key, value, ttlSeconds = SETTINGS_TTL_SECONDS) {
  if (!isRedisReady()) return false;
  try {
    await client.set(key, JSON.stringify(value), { EX: ttlSeconds });
    return true;
  } catch (error) {
    logRedisError(error);
    return false;
  }
}

async function redisDelete(key) {
  if (!isRedisReady()) return false;
  try {
    await client.del(key);
    return true;
  } catch (error) {
    logRedisError(error);
    return false;
  }
}

async function upsertDriverPresence({ driverId, lat, lng, vehicleType, ridePreference, longRangeEnabled }) {
  if (!isRedisReady()) return false;
  const id = String(driverId || '');
  const latitude = Number(lat);
  const longitude = Number(lng);
  if (!id || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return false;

  try {
    await client.multi()
      .sendCommand(['GEOADD', DRIVER_GEO_KEY, String(longitude), String(latitude), id])
      .set(driverStateKey(id), JSON.stringify({
        vehicleType: vehicleType || '',
        ridePreference: ridePreference || '',
        longRangeEnabled: longRangeEnabled === true
      }), { EX: DRIVER_STATE_TTL_SECONDS })
      .exec();
    return true;
  } catch (error) {
    logRedisError(error);
    return false;
  }
}

async function removeDriverPresence(driverId) {
  if (!isRedisReady()) return false;
  const id = String(driverId || '');
  if (!id) return false;
  try {
    await client.multi()
      .sendCommand(['ZREM', DRIVER_GEO_KEY, id])
      .del(driverStateKey(id))
      .exec();
    return true;
  } catch (error) {
    logRedisError(error);
    return false;
  }
}

async function searchDriverIds({ lat, lng, radiusKm }) {
  if (!isRedisReady()) return null;
  const latitude = Number(lat);
  const longitude = Number(lng);
  const radius = Number(radiusKm);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || !Number.isFinite(radius) || radius <= 0) {
    return [];
  }

  try {
    const raw = await client.sendCommand([
      'GEOSEARCH',
      DRIVER_GEO_KEY,
      'FROMLONLAT',
      String(longitude),
      String(latitude),
      'BYRADIUS',
      String(radius),
      'km',
      'WITHDIST'
    ]);
    return raw
      .map(item => Array.isArray(item) ? item[0] : item)
      .map(String)
      .filter(Boolean);
  } catch (error) {
    logRedisError(error);
    return null;
  }
}

async function rebuildDriverGeoIndex(drivers) {
  if (!isRedisReady()) return false;
  if (!Array.isArray(drivers)) return false;
  try {
    const pipeline = client.multi().del(DRIVER_GEO_KEY);
    for (const driver of drivers) {
      const id = String(driver?._id || '');
      const lat = Number(driver?.currentLocation?.lat);
      const lng = Number(driver?.currentLocation?.lng);
      if (!id || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      pipeline
        .sendCommand(['GEOADD', DRIVER_GEO_KEY, String(lng), String(lat), id])
        .set(driverStateKey(id), JSON.stringify({
          vehicleType: driver.vehicleType || '',
          ridePreference: driver.ridePreference || '',
          longRangeEnabled: driver.longRangeEnabled === true
        }), { EX: DRIVER_STATE_TTL_SECONDS });
    }
    await pipeline.exec();
    return true;
  } catch (error) {
    logRedisError(error);
    return false;
  }
}

async function closeRedisAcceleration() {
  if (!client) return;
  redisReady = false;
  await client.quit().catch(() => client.disconnect());
  client = null;
}

function redisStatus() {
  return {
    configured: Boolean(configuredRedisUrl()),
    ready: isRedisReady(),
    driverGeoKey: DRIVER_GEO_KEY,
    settingsPrefix: SETTINGS_PREFIX
  };
}

module.exports = {
  startRedisAcceleration,
  closeRedisAcceleration,
  isRedisReady,
  redisStatus,
  redisGetJson,
  redisSetJson,
  redisDelete,
  upsertDriverPresence,
  removeDriverPresence,
  searchDriverIds,
  rebuildDriverGeoIndex
};