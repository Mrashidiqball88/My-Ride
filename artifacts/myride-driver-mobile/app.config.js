const baseConfig = require('./app.json').expo;

const mapboxPublicToken = String(
  process.env.MAPBOX_PUBLIC_TOKEN ||
  process.env.EXPO_PUBLIC_MAPBOX_PUBLIC_TOKEN ||
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
    mapboxPublicToken,
  },
  plugins: [
    ...(baseConfig.plugins || []),
    './plugins/withDriverAlertCapabilities',
  ],
};