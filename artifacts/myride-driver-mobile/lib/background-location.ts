import * as Location from 'expo-location';
import * as SecureStore from 'expo-secure-store';
import * as TaskManager from 'expo-task-manager';

export const BACKGROUND_LOCATION_TASK = 'myride-driver-background-location';
const TOKEN_KEY = 'myride.driver.token';
const SESSION_KEY = 'myride.driver.session';
const ONLINE_KEY = 'myride.driver.online';
const ACTIVE_RIDE_KEY = 'myride.driver.activeRide';
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

TaskManager.defineTask(BACKGROUND_LOCATION_TASK, async ({ data, error }) => {
  if (error) return;
  const locations = (data as { locations?: Location.LocationObject[] } | undefined)?.locations ?? [];
  const latest = locations[locations.length - 1];
  if (latest) await postLocation(latest);
  else await postHeartbeat();
});

export const backgroundLocationOptions: Location.LocationTaskOptions = {
  accuracy: Location.Accuracy.Highest,
  distanceInterval: 25,
  timeInterval: 15_000,
  pausesUpdatesAutomatically: false,
  showsBackgroundLocationIndicator: true,
  foregroundService: {
    notificationTitle: 'My Ride - Driver is online',
    notificationBody: 'Waiting for rides and sharing your location.',
    notificationColor: '#38BDF8',
  },
};