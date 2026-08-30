const baseConfig = require('./app.json').expo;

const mapboxPublicToken = String(
  process.env.MAPBOX_PUBLIC_TOKEN ||
  process.env.EXPO_PUBLIC_MAPBOX_PUBLIC_TOKEN ||
  ''
).trim();

module.exports = {
  ...baseConfig,
  extra: {
    ...(baseConfig.extra || {}),
    mapboxPublicToken,
  },
};