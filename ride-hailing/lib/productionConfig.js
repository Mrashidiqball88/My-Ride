'use strict';

const PRODUCTION_REQUIRED_VARIABLES = Object.freeze([
  {
    label: 'MongoDB URI',
    keys: ['MONGO_URI', 'MONGODB_URI', 'MONGO_URL', 'MONGODB_URL'],
    validate: value => /^mongodb(?:\+srv)?:\/\//i.test(value)
  },
  {
    label: 'JWT_SECRET',
    keys: ['JWT_SECRET'],
    minLength: 32
  },
  {
    label: 'SESSION_SECRET',
    keys: ['SESSION_SECRET'],
    minLength: 32
  },
  {
    label: 'Mapbox token',
    keys: ['MAPBOX_PUBLIC_TOKEN', 'MAPBOX_ACCESS_TOKEN', 'MAPBOX_TOKEN']
  },
  {
    label: 'REDIS_URL',
    keys: ['REDIS_URL'],
    validate: value => /^rediss?:\/\//i.test(value)
  },
  {
    label: 'ADMIN_EMAIL',
    keys: ['ADMIN_EMAIL'],
    validate: value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
  },
  {
    label: 'ADMIN_PASSWORD',
    keys: ['ADMIN_PASSWORD'],
    minLength: 10
  },
  {
    label: 'ADMIN_RECOVERY_KEY',
    keys: ['ADMIN_RECOVERY_KEY'],
    minLength: 12
  },
  {
    label: 'SMTP_HOST',
    keys: ['SMTP_HOST']
  },
  {
    label: 'SMTP_USER',
    keys: ['SMTP_USER']
  },
  {
    label: 'SMTP_PASS',
    keys: ['SMTP_PASS']
  },
  {
    label: 'EMAIL_FROM',
    keys: ['EMAIL_FROM']
  },
  {
    label: 'VAPID_PUBLIC_KEY',
    keys: ['VAPID_PUBLIC_KEY']
  },
  {
    label: 'VAPID_PRIVATE_KEY',
    keys: ['VAPID_PRIVATE_KEY']
  },
  {
    label: 'VAPID_EMAIL',
    keys: ['VAPID_EMAIL'],
    validate: value => /^mailto:[^\s@]+@[^\s@]+$/.test(value)
  },
  {
    label: 'PAYMENT_CONFIG_ENCRYPTION_KEY',
    keys: ['PAYMENT_CONFIG_ENCRYPTION_KEY'],
    minLength: 32
  }
]);

const PRODUCTION_FORBIDDEN_FLAGS = Object.freeze([
  'DEMO_ACCOUNTS_ENABLED',
  'PHONE_OTP_TEST_MODE',
  'MYRIDE_TEST_MODE',
  'TEST_MODE',
  'MOCK_MODE',
  'PREVIEW_MODE'
]);

function normalizedValue(env, key) {
  return String(env?.[key] || '').trim();
}

function firstMatchingValue(env, keys) {
  for (const key of keys) {
    const value = normalizedValue(env, key);
    if (value) return { key, value };
  }
  return null;
}

function validateProductionEnvironment(env = process.env) {
  const errors = [];

  if (normalizedValue(env, 'NODE_ENV') !== 'production') {
    errors.push('NODE_ENV must be exactly "production"');
  }

  const enabledFlags = PRODUCTION_FORBIDDEN_FLAGS.filter(
    key => normalizedValue(env, key).toLowerCase() === 'true'
  );
  if (enabledFlags.length > 0) {
    errors.push(`production/test flags must be disabled: ${enabledFlags.join(', ')}`);
  }

  for (const requirement of PRODUCTION_REQUIRED_VARIABLES) {
    const match = firstMatchingValue(env, requirement.keys);
    if (!match) {
      errors.push(`${requirement.label} is required (${requirement.keys.join(' or ')})`);
      continue;
    }
    if (requirement.minLength && match.value.length < requirement.minLength) {
      errors.push(`${match.key} must be at least ${requirement.minLength} characters`);
      continue;
    }
    if (requirement.validate && !requirement.validate(match.value)) {
      errors.push(`${match.key} has an invalid format`);
    }
  }

  return {
    ok: errors.length === 0,
    errors
  };
}

function assertProductionEnvironment(env = process.env) {
  const result = validateProductionEnvironment(env);
  if (result.ok) return result;

  throw new Error([
    '[production-config] Refusing to start.',
    ...result.errors.map(error => `- ${error}`),
    'See ride-hailing/.env.example for the required production configuration.'
  ].join('\n'));
}

function assertTestEnvironment(env = process.env) {
  if (normalizedValue(env, 'NODE_ENV') !== 'test') {
    throw new Error('[test-config] MYRIDE_TEST_MODE requires NODE_ENV=test');
  }
  if (normalizedValue(env, 'MYRIDE_TEST_MODE').toLowerCase() !== 'true') {
    throw new Error('[test-config] MYRIDE_TEST_MODE=true is required for the test server');
  }
}

function assertStartupConfiguration(env = process.env) {
  if (normalizedValue(env, 'MYRIDE_TEST_MODE').toLowerCase() === 'true') {
    assertTestEnvironment(env);
    return { mode: 'test' };
  }
  assertProductionEnvironment(env);
  return { mode: 'production' };
}

module.exports = {
  PRODUCTION_REQUIRED_VARIABLES,
  PRODUCTION_FORBIDDEN_FLAGS,
  validateProductionEnvironment,
  assertProductionEnvironment,
  assertStartupConfiguration
};