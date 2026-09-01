import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import * as TaskManager from 'expo-task-manager';
import { AppState } from 'react-native';
import {
  ensureRideAlertChannel,
  rideAlertId,
  scheduleNativeRideAlert,
} from '@/lib/ride-alerts';

export const BACKGROUND_LOCATION_TASK = 'myride-driver-background-location';
const TOKEN_KEY = 'myride.driver.token';
const SESSION_KEY = 'myride.driver.session';
const ONLINE_KEY = 'myride.driver.online';
const ACTIVE_RIDE_KEY = 'myride.driver.activeRide';
const BACKGROUND_ALERTS_KEY = 'myride.driver.backgroundRideAlerts';
export const ACTIVE_RIDE_LOCATION_INTERVAL_MS = 3_000;
const DOMAIN = process.env.EXPO_PUBLIC_RIDE_API_URL ||
  (process.env.EXPO_PUBLIC_DOMAIN ? `https://${process.env.EXPO_PUBLIC_DOMAIN}` : '');

async function postLocation(location: Location.LocationObject) {
  const [token, session, online, activeRide] = await Promise.all([
    SecureStore.getItemAsync(TOKEN_KEY),
    SecureStore.getItemAsync(SESSION_KEY),
    SecureStore.getItemAsync(ONLINE_KEY),
    SecureStore.getItemAsync(ACTIVE_RIDE_KEY),
  ]);
  if (!token || online !== 'true' || !DOMAIN) return;
  const response = await fetch(`${DOMAIN}/api/driver/location`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(session ? { 'X-Session-Token': session } : {}),
    },
    body: JSON.stringify({
      lat: location.coords.latitude,
      lng: location.coords.longitude,
      rideId: activeRide || undefined,
    }),
  });
  // An unavailable account must fail closed: do not leave background tracking
  // running after Admin suspension or a logged-out session.
  if (response.status === 401 || response.status === 403) {
    await SecureStore.setItemAsync(ONLINE_KEY, 'false');
    await Location.stopLocationUpdatesAsync(BACKGROUND_LOCATION_TASK).catch(() => undefined);
    return;
  }
}

async function postHeartbeat() {
  const [token, session, online] = await Promise.all([
    SecureStore.getItemAsync(TOKEN_KEY),
    SecureStore.getItemAsync(SESSION_KEY),
    SecureStore.getItemAsync(ONLINE_KEY),
  ]);
  if (!token || online !== 'true' || !DOMAIN) return;
  const response = await fetch(`${DOMAIN}/api/driver/heartbeat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(session ? { 'X-Session-Token': session } : {}),
    },
  });
  if (response.status === 401 || response.status === 403) {
    await SecureStore.setItemAsync(ONLINE_KEY, 'false');
    await Location.stopLocationUpdatesAsync(BACKGROUND_LOCATION_TASK).catch(() => undefined);
  }
}

function isLiveRide(ride: { id?: string; _id?: string; broadcastExpiresAt?: string | Date }) {
  const expiresAt = new Date(ride.broadcastExpiresAt || 0).getTime();
  return Boolean(rideAlertId(ride) && Number.isFinite(expiresAt) && expiresAt > Date.now());
}

async function syncBackgroundRideAlerts() {
  const [token, session, online, activeRide, storedAlerts] = await Promise.all([
    SecureStore.getItemAsync(TOKEN_KEY),
    SecureStore.getItemAsync(SESSION_KEY),
    SecureStore.getItemAsync(ONLINE_KEY),
    SecureStore.getItemAsync(ACTIVE_RIDE_KEY),
    SecureStore.getItemAsync(BACKGROUND_ALERTS_KEY),
  ]);
  if (!token || online !== 'true' || activeRide || !DOMAIN) return;
  // Polling remains a recovery path even after push registration. Expo token
  // registration proves only that the token was accepted by our API; it does
  // not prove that this device or its OEM battery policy delivered the push.
  if (AppState.currentState === 'active') return;

  let knownAlerts: Record<string, string> = {};
  try {
    const parsed = storedAlerts ? JSON.parse(storedAlerts) : {};
    if (parsed && typeof parsed === 'object') knownAlerts = parsed;
  } catch {
    knownAlerts = {};
  }

  const response = await fetch(`${DOMAIN}/api/rides/available`, {
    headers: {
      Authorization: `Bearer ${token}`,
      ...(session ? { 'X-Session-Token': session } : {}),
    },
  });
  if (!response.ok) return;
  const rides = await response.json().catch(() => []);
  const liveRides = Array.isArray(rides) ? rides.filter(isLiveRide) : [];
  const liveIds = new Set(liveRides.map(rideAlertId));

  await ensureRideAlertChannel();
  for (const ride of liveRides) {
    const id = rideAlertId(ride);
    if (!id || knownAlerts[id]) continue;
    const notificationId = await scheduleNativeRideAlert(ride);
    knownAlerts[id] = notificationId;
  }

  for (const [id, notificationId] of Object.entries(knownAlerts)) {
    if (liveIds.has(id)) continue;
    await Notifications.dismissNotificationAsync(notificationId).catch(() => undefined);
    await Notifications.cancelScheduledNotificationAsync(notificationId).catch(() => undefined);
    delete knownAlerts[id];
  }
  await SecureStore.setItemAsync(BACKGROUND_ALERTS_KEY, JSON.stringify(knownAlerts));
}

TaskManager.defineTask(BACKGROUND_LOCATION_TASK, async ({ data, error }) => {
  if (error) return;
  const locations = (data as { locations?: Location.LocationObject[] } | undefined)?.locations ?? [];
  const latest = locations[locations.length - 1];
  if (latest) await postLocation(latest).catch(() => undefined);
  else await postHeartbeat().catch(() => undefined);
  await syncBackgroundRideAlerts().catch(() => undefined);
});

const sharedLocationOptions = {
  accuracy: Location.Accuracy.Highest,
  pausesUpdatesAutomatically: false,
  showsBackgroundLocationIndicator: true,
  foregroundService: {
    notificationTitle: 'My Ride - Driver is online',
    notificationBody: 'Waiting for rides and sharing your location.',
    notificationColor: '#38BDF8',
  },
} satisfies Omit<Location.LocationTaskOptions, 'distanceInterval' | 'timeInterval'>;

export const availabilityLocationOptions: Location.LocationTaskOptions = {
  ...sharedLocationOptions,
  distanceInterval: 25,
  timeInterval: 15_000,
};

export const activeRideLocationOptions: Location.LocationTaskOptions = {
  ...sharedLocationOptions,
  distanceInterval: 0,
  timeInterval: ACTIVE_RIDE_LOCATION_INTERVAL_MS,
};