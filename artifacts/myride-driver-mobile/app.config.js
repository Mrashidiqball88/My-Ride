const baseConfig = require('./app.json').expo;

const mapboxPublicToken = String(
  process.env.MAPBOX_PUBLIC_TOKEN ||
  process.env.EXPO_PUBLIC_MAPBOX_PUBLIC_TOKEN ||
  ''
).trim();

// Expo SDK 54 requires a project ID when exchanging the device FCM/APNs
// token for an Expo push token. Replit supplies its stable project UUID to
// the mobile workflow; a real EAS project ID can override it for release
// builds.
const expoProjectId = String(
  process.env.EXPO_PUBLIC_EAS_PROJECT_ID ||
  process.env.EAS_PROJECT_ID ||
  process.env.EXPO_PUBLIC_REPL_ID ||
  process.env.REPL_ID ||
  ''
).trim();

module.exports = {
  ...baseConfig,
  ios: {
    ...(baseConfig.ios || {}),
    bundleIdentifier: baseConfig.ios?.bundleIdentifier || 'com.myride.driver',
  },
  android: {
    ...(baseConfig.android || {}),
    package: baseConfig.android?.package || 'com.myride.driver',
  },
  extra: {
    ...(baseConfig.extra || {}),
    ...(expoProjectId
      ? { eas: { ...(baseConfig.extra?.eas || {}), projectId: expoProjectId } }
      : {}),
    mapboxPublicToken,
  },
  plugins: [
    ...(baseConfig.plugins || []),
    './plugins/withDriverAlertCapabilities',
  ],
};