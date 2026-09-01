'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const runtimeSource = fs.readFileSync(
  path.join(__dirname, '../../artifacts/myride-driver-mobile/context/DriverRuntime.tsx'),
  'utf8',
);
const homeSource = fs.readFileSync(
  path.join(__dirname, '../../artifacts/myride-driver-mobile/app/index.tsx'),
  'utf8',
);
const appConfig = JSON.parse(fs.readFileSync(
  path.join(__dirname, '../../artifacts/myride-driver-mobile/app.json'),
  'utf8',
));
const appConfigSource = fs.readFileSync(
  path.join(__dirname, '../../artifacts/myride-driver-mobile/app.config.js'),
  'utf8',
);
const serverSource = fs.readFileSync(
  path.join(__dirname, '../server.js'),
  'utf8',
);

test('native Driver cannot go online without alert and background readiness', () => {
  assert.match(runtimeSource, /getPermissionsAsync\(\)/);
  assert.match(runtimeSource, /requestPermissionsAsync\(\)/);
  assert.match(runtimeSource, /getForegroundPermissionsAsync\(\)/);
  assert.match(runtimeSource, /getBackgroundPermissionsAsync\(\)/);
  assert.match(runtimeSource, /RIDE_ALERT_CHANNEL_ID/);
  assert.match(runtimeSource, /getNotificationChannelAsync\(RIDE_ALERT_CHANNEL_ID\)/);
  assert.match(runtimeSource, /getExpoPushTokenAsync/);
  assert.match(runtimeSource, /hasStartedLocationUpdatesAsync/);
  assert.match(runtimeSource, /foregroundServiceReady/);
  assert.match(runtimeSource, /LOCK_SCREEN_ACK_KEY/);
  assert.match(runtimeSource, /refreshAlertReadiness\(\{ requestPermissions: true \}\)/);
  assert.match(runtimeSource, /addNotificationReceivedListener/);
  assert.match(runtimeSource, /openSpecialSettings/);
  assert.match(runtimeSource, /overlayPermissionGranted/);
  assert.match(runtimeSource, /batteryOptimizationExempt/);
  assert.match(runtimeSource, /fullScreenIntentAllowed/);
  assert.match(homeSource, /driver-alert-readiness/);
  assert.match(homeSource, /disabled=\{busy \|\| \(!isWeb && !runtime\.alertReadiness\.ready\)\}/);
});

test('native build declares the OS capabilities required by the readiness gate', () => {
  const androidPermissions = appConfig.expo.android.permissions || [];
  const plugins = appConfig.expo.plugins || [];
  assert.ok(androidPermissions.includes('ACCESS_BACKGROUND_LOCATION'));
  assert.ok(androidPermissions.includes('FOREGROUND_SERVICE'));
  assert.ok(androidPermissions.includes('POST_NOTIFICATIONS'));
  assert.ok(androidPermissions.includes('SYSTEM_ALERT_WINDOW'));
  assert.ok(androidPermissions.includes('REQUEST_IGNORE_BATTERY_OPTIMIZATIONS'));
  assert.ok(androidPermissions.includes('USE_FULL_SCREEN_INTENT'));
  assert.ok(plugins.some(plugin => Array.isArray(plugin) && plugin[0] === 'expo-location'));
  assert.ok(plugins.some(plugin => Array.isArray(plugin) && plugin[0] === 'expo-notifications'));
  assert.match(appConfigSource, /withDriverAlertCapabilities/);
});

test('native push delivery uses the versioned urgent channel and offer expiry', () => {
  assert.match(serverSource, /NATIVE_RIDE_ALERT_CHANNEL_ID = 'ride-alerts-critical-v2'/);
  assert.match(serverSource, /channelId: NATIVE_RIDE_ALERT_CHANNEL_ID/);
  assert.match(serverSource, /ttl: Math\.max\(1, Math\.ceil\(\(new Date\(ridePayload\.broadcastExpiresAt\)/);
  assert.match(serverSource, /priority: 'high'/);
});