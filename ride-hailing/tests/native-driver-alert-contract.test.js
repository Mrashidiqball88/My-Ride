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

test('native Driver cannot go online without alert and background readiness', () => {
  assert.match(runtimeSource, /getPermissionsAsync\(\)/);
  assert.match(runtimeSource, /requestPermissionsAsync\(\)/);
  assert.match(runtimeSource, /getForegroundPermissionsAsync\(\)/);
  assert.match(runtimeSource, /getBackgroundPermissionsAsync\(\)/);
  assert.match(runtimeSource, /getNotificationChannelAsync\('ride-alerts'\)/);
  assert.match(runtimeSource, /getExpoPushTokenAsync/);
  assert.match(runtimeSource, /hasStartedLocationUpdatesAsync/);
  assert.match(runtimeSource, /foregroundServiceReady/);
  assert.match(runtimeSource, /LOCK_SCREEN_ACK_KEY/);
  assert.match(runtimeSource, /refreshAlertReadiness\(\{ requestPermissions: true \}\)/);
  assert.match(runtimeSource, /addNotificationReceivedListener/);
  assert.match(homeSource, /driver-alert-readiness/);
  assert.match(homeSource, /disabled=\{busy \|\| \(!isWeb && !runtime\.alertReadiness\.ready\)\}/);
});

test('native build declares the OS capabilities required by the readiness gate', () => {
  const androidPermissions = appConfig.expo.android.permissions || [];
  const plugins = appConfig.expo.plugins || [];
  assert.ok(androidPermissions.includes('ACCESS_BACKGROUND_LOCATION'));
  assert.ok(androidPermissions.includes('FOREGROUND_SERVICE'));
  assert.ok(androidPermissions.includes('POST_NOTIFICATIONS'));
  assert.ok(plugins.some(plugin => Array.isArray(plugin) && plugin[0] === 'expo-location'));
  assert.ok(plugins.some(plugin => Array.isArray(plugin) && plugin[0] === 'expo-notifications'));
});