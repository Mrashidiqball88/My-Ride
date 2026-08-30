import Constants from 'expo-constants';

const configuredToken = String(
  Constants.expoConfig?.extra?.mapboxPublicToken ||
  process.env.EXPO_PUBLIC_MAPBOX_PUBLIC_TOKEN ||
  ''
).trim();

export const MAPBOX_PUBLIC_TOKEN = configuredToken;

export function mapboxStaticMapUrl({
  latitude,
  longitude,
  zoom = 14,
  width = 640,
  height = 260,
}: {
  latitude: number;
  longitude: number;
  zoom?: number;
  width?: number;
  height?: number;
}): string | null {
  if (!MAPBOX_PUBLIC_TOKEN
    || !Number.isFinite(latitude)
    || !Number.isFinite(longitude)
    || latitude < -90 || latitude > 90
    || longitude < -180 || longitude > 180) {
    return null;
  }

  const marker = `pin-s+38bdf8(${longitude},${latitude})`;
  return `https://api.mapbox.com/styles/v1/mapbox/streets-v12/static/${marker}/${longitude},${latitude},${zoom},0/${width}x${height}@2x?access_token=${encodeURIComponent(MAPBOX_PUBLIC_TOKEN)}`;
}