'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const service = require('../server');

const ENV_KEYS = [
  'MONGO_SERVER_SELECTION_TIMEOUT_MS',
  'MONGO_CONNECT_TIMEOUT_MS',
  'MONGO_HEARTBEAT_FREQUENCY_MS',
  'MONGO_INITIAL_RETRY_ATTEMPTS',
  'MONGO_INITIAL_RETRY_DELAY_MS',
  'MONGO_MAX_RETRY_DELAY_MS',
  'MONGO_URI',
  'MONGODB_URI',
  'MONGO_URL',
  'MONGODB_URL',
  'DATABASE_URL',
  'NODE_ENV'
];

function withEnvironment(values, callback) {
  const previous = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
  for (const key of ENV_KEYS) {
    if (Object.prototype.hasOwnProperty.call(values, key)) {
      if (values[key] === undefined) delete process.env[key];
      else process.env[key] = values[key];
    }
  }
  try {
    return callback();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('MongoDB connection defaults allow normal Atlas network latency', () => {
  withEnvironment({
    MONGO_SERVER_SELECTION_TIMEOUT_MS: undefined,
    MONGO_CONNECT_TIMEOUT_MS: undefined,
    MONGO_HEARTBEAT_FREQUENCY_MS: undefined,
    MONGO_INITIAL_RETRY_ATTEMPTS: undefined,
    MONGO_INITIAL_RETRY_DELAY_MS: undefined,
    MONGO_MAX_RETRY_DELAY_MS: undefined
  }, () => {
    assert.deepEqual(service.getMongoConnectionOptions(), {
      serverSelectionTimeoutMS: 30000,
      connectTimeoutMS: 30000,
      heartbeatFrequencyMS: 10000
    });
    assert.deepEqual(service.getMongoRetryOptions(), {
      maxAttempts: 0,
      initialDelayMS: 5000,
      maxDelayMS: 30000
    });
  });
});

test('MongoDB connection and retry settings accept production overrides', () => {
  withEnvironment({
    MONGO_SERVER_SELECTION_TIMEOUT_MS: '45000',
    MONGO_CONNECT_TIMEOUT_MS: '60000',
    MONGO_HEARTBEAT_FREQUENCY_MS: '15000',
    MONGO_INITIAL_RETRY_ATTEMPTS: '7',
    MONGO_INITIAL_RETRY_DELAY_MS: '3000',
    MONGO_MAX_RETRY_DELAY_MS: '45000'
  }, () => {
    assert.deepEqual(service.getMongoConnectionOptions(), {
      serverSelectionTimeoutMS: 45000,
      connectTimeoutMS: 60000,
      heartbeatFrequencyMS: 15000
    });
    assert.deepEqual(service.getMongoRetryOptions(), {
      maxAttempts: 7,
      initialDelayMS: 3000,
      maxDelayMS: 45000
    });
  });
});

test('invalid MongoDB tuning values fall back safely and keep heartbeat below selection timeout', () => {
  withEnvironment({
    MONGO_SERVER_SELECTION_TIMEOUT_MS: '1000',
    MONGO_CONNECT_TIMEOUT_MS: 'not-a-number',
    MONGO_HEARTBEAT_FREQUENCY_MS: '60000',
    MONGO_INITIAL_RETRY_ATTEMPTS: '-1',
    MONGO_INITIAL_RETRY_DELAY_MS: '0',
    MONGO_MAX_RETRY_DELAY_MS: '999999999'
  }, () => {
    const connection = service.getMongoConnectionOptions();
    assert.deepEqual(connection, {
      serverSelectionTimeoutMS: 30000,
      connectTimeoutMS: 30000,
      heartbeatFrequencyMS: 29000
    });
    assert.deepEqual(service.getMongoRetryOptions(), {
      maxAttempts: 0,
      initialDelayMS: 5000,
      maxDelayMS: 30000
    });
  });
});

test('health state reports connecting while a configured database is not ready', () => {
  withEnvironment({
    MONGO_URI: 'mongodb://atlas.example.test/myride',
    MONGODB_URI: undefined,
    MONGO_URL: undefined,
    MONGODB_URL: undefined,
    DATABASE_URL: undefined
  }, () => {
    assert.notEqual(mongoose.connection.readyState, 1);
    assert.equal(service.getDatabaseStatus(), 'connecting');
  });
});

test('MongoDB resolver accepts the legacy URI names without exposing credentials', () => {
  withEnvironment({
    MONGO_URI: undefined,
    MONGODB_URI: 'mongodb+srv://legacy.example.test/myride',
    MONGO_URL: undefined,
    MONGODB_URL: undefined,
    DATABASE_URL: undefined
  }, () => {
    assert.deepEqual(service.getConfiguredMongoUri(), {
      uri: 'mongodb+srv://legacy.example.test/myride',
      source: 'MONGODB_URI'
    });
  });
});

test('MongoDB resolver does not mistake a PostgreSQL DATABASE_URL for Mongo', () => {
  withEnvironment({
    MONGO_URI: undefined,
    MONGODB_URI: undefined,
    MONGO_URL: undefined,
    MONGODB_URL: undefined,
    DATABASE_URL: 'postgresql://example.test/myride',
    NODE_ENV: 'production'
  }, () => {
    assert.deepEqual(service.getConfiguredMongoUri(), { uri: '', source: '' });
    assert.equal(service.getDatabaseStatus(), 'unconfigured');
  });
});

test('health state reports an unconfigured production database without implying demo mode', () => {
  withEnvironment({
    MONGO_URI: undefined,
    MONGODB_URI: undefined,
    MONGO_URL: undefined,
    MONGODB_URL: undefined,
    DATABASE_URL: undefined,
    NODE_ENV: 'production'
  }, () => {
    assert.notEqual(mongoose.connection.readyState, 1);
    assert.equal(service.getDatabaseStatus(), 'unconfigured');
  });
});