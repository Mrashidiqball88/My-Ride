import React, { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';
import * as Haptics from 'expo-haptics';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import Constants from 'expo-constants';
import { io, Socket } from 'socket.io-client';
import { BACKGROUND_LOCATION_TASK, backgroundLocationOptions } from '@/lib/background-location';

const TOKEN_KEY = 'myride.driver.token';
const SESSION_KEY = 'myride.driver.session';
const USER_KEY = 'myride.driver.user';
const ONLINE_KEY = 'myride.driver.online';
const ACTIVE_RIDE_KEY = 'myride.driver.activeRide';
const API_URL = process.env.EXPO_PUBLIC_RIDE_API_URL ||
  (process.env.EXPO_PUBLIC_DOMAIN ? `https://${process.env.EXPO_PUBLIC_DOMAIN}` : '');

export const DRIVER_VEHICLE_CATEGORIES = [
  'Bike', 'Riksha', 'Car Mini', 'Car Sedan', 'Car SUV', 'Van Seven Seats',
  'Cary Dibba', 'Toyota Highroof', 'Toyota Saloon Coaster',
] as const;

export type DriverUser = {
  id: string; name: string; role: 'driver'; accountStatus: string;
  vehicleType?: string; vehicleModel?: string; vehiclePlate?: string;
};
export type RideRequest = {
  id: string; fare: number; distance?: number; vehicleType?: string;
  isLongRange?: boolean;
  pickupLocation?: { address?: string; lat: number; lng: number };
  dropoffLocation?: { address?: string; lat: number; lng: number };
};
export type LongRangeState = {
  enabled: boolean; walletBalance: number;
  settings: { enabled?: boolean; distanceCutoffKm?: number; minimumWalletBalance?: number };
};

type RuntimeContext = {
  ready: boolean; user: DriverUser | null; isOnline: boolean; connection: 'connected' | 'connecting' | 'offline';
  pendingRide: RideRequest | null; activeRideId: string | null; error: string | null;
  longRange: LongRangeState | null;
  signIn(identifier: string, password: string): Promise<void>;
  signOut(): Promise<void>;
  setOnline(next: boolean): Promise<void>;
  setLongRange(next: boolean): Promise<string>;
  acceptRide(): Promise<void>;
  dismissRide(): void;
  clearError(): void;
};
const DriverContext = createContext<RuntimeContext | null>(null);

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: true,
  }),
});

function api(path: string, token?: string, session?: string, init: RequestInit = {}) {
  if (!API_URL) throw new Error('Driver API address is not configured for this build.');
  return fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(session ? { 'X-Session-Token': session } : {}),
      ...(init.headers || {}),
    },
  }).then(async response => {
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Network request failed (${response.status})`);
    return data;
  });
}

async function configureNotifications() {
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('ride-alerts', {
      name: 'Ride requests', importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 350, 160, 350], sound: 'default', lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
    });
  }
  await Notifications.setNotificationCategoryAsync('ride-request', [
    { identifier: 'accept', buttonTitle: 'Accept', options: { opensAppToForeground: true } },
    { identifier: 'dismiss', buttonTitle: 'Dismiss', options: { opensAppToForeground: true } },
  ]);
  const permissions = await Notifications.getPermissionsAsync();
  if (!permissions.granted) await Notifications.requestPermissionsAsync();
}

export function DriverRuntimeProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [user, setUser] = useState<DriverUser | null>(null);
  const [isOnline, setIsOnline] = useState(false);
  const [connection, setConnection] = useState<RuntimeContext['connection']>('offline');
  const [pendingRide, setPendingRide] = useState<RideRequest | null>(null);
  const [activeRideId, setActiveRideId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [longRange, setLongRangeState] = useState<LongRangeState | null>(null);
  const socket = useRef<Socket | null>(null);
  const tokenRef = useRef<string | null>(null);
  const sessionRef = useRef<string | null>(null);

  const hydrateAvailableRides = useCallback(async () => {
    if (!tokenRef.current || !isOnline) return;
    try {
      const rides = await api('/api/rides/available', tokenRef.current, sessionRef.current || undefined);
      if (Array.isArray(rides) && rides.length) setPendingRide(rides[0] as RideRequest);
    } catch { /* A reconnect can race the availability change; socket retry continues. */ }
  }, [isOnline]);

  const loadLongRange = useCallback(async () => {
    if (!tokenRef.current) return;
    const data = await api('/api/driver/long-range', tokenRef.current, sessionRef.current || undefined);
    setLongRangeState(data as LongRangeState);
  }, []);

  const connectSocket = useCallback(() => {
    if (!tokenRef.current || socket.current) return;
    setConnection('connecting');
    const nextSocket = io(API_URL, {
      path: '/socket.io', auth: { token: tokenRef.current }, transports: ['websocket'],
      reconnection: true, reconnectionAttempts: Infinity, reconnectionDelay: 1000, reconnectionDelayMax: 15_000,
    });
    socket.current = nextSocket;
    nextSocket.on('connect', () => {
      setConnection('connected');
      if (isOnline) {
        nextSocket.emit('driver:status', { isOnline: true });
        nextSocket.emit('driver:heartbeat');
      }
      if (activeRideId) nextSocket.emit('ride:join', activeRideId);
      void hydrateAvailableRides();
    });
    nextSocket.on('disconnect', () => setConnection('connecting'));
    nextSocket.on('connect_error', () => setConnection('connecting'));
    nextSocket.on('driver:rehydrate', () => void hydrateAvailableRides());
    nextSocket.on('ride:new', (ride: RideRequest) => {
      if (!isOnline || activeRideId) return;
      setPendingRide(current => current?.id === ride.id ? current : ride);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      void Notifications.scheduleNotificationAsync({
        content: {
          title: 'New ride request',
          body: `${ride.pickupLocation?.address || 'Nearby pickup'} · Rs ${Number(ride.fare || 0).toLocaleString()}`,
          sound: 'default', categoryIdentifier: 'ride-request', data: { type: 'ride:new', ride },
        },
        trigger: null,
      });
    });
    nextSocket.on('ride:taken', ({ rideId }: { rideId: string }) => {
      setPendingRide(current => current?.id === rideId ? null : current);
    });
    nextSocket.on('ride:accepted', ({ rideId }: { rideId: string }) => {
      setActiveRideId(rideId);
      void SecureStore.setItemAsync(ACTIVE_RIDE_KEY, rideId);
    });
    nextSocket.on('ride:status', ({ rideId, status }: { rideId: string; status: string }) => {
      if (['completed', 'cancelled'].includes(status)) {
        setActiveRideId(current => {
          if (current === rideId) {
            void SecureStore.deleteItemAsync(ACTIVE_RIDE_KEY);
            return null;
          }
          return current;
        });
      }
      if (status === 'cancelled') setPendingRide(current => current?.id === rideId ? null : current);
    });
    nextSocket.on('account:suspended', ({ reason }: { reason?: string }) => {
      setError(reason || 'Your driver account can no longer be online.');
      void setOnlineState(false);
    });
    nextSocket.on('account:vehicle-review', ({ reason }: { reason?: string }) => {
      setError(reason || 'Your vehicle documents are under Admin review. You are offline until approval.');
      setPendingRide(null);
      void setOnlineState(false);
    });
    nextSocket.on('long-range:updated', (data: { enabled: boolean; settings: LongRangeState['settings'] }) => {
      setLongRangeState(current => current ? { ...current, enabled: data.enabled, settings: data.settings || current.settings } : current);
    });
    nextSocket.on('long-range:settings-updated', ({ settings }: { settings: LongRangeState['settings'] }) => {
      setLongRangeState(current => current ? { ...current, enabled: settings?.enabled ? current.enabled : false, settings } : current);
    });
  // setOnlineState is stable through declaration below at execution time.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRideId, hydrateAvailableRides, isOnline]);

  const sendCurrentLocation = useCallback(async (location: Location.LocationObject) => {
    if (!tokenRef.current || !isOnline) return;
    await api('/api/driver/location', tokenRef.current, sessionRef.current || undefined, {
      method: 'POST', body: JSON.stringify({
        lat: location.coords.latitude, lng: location.coords.longitude, rideId: activeRideId || undefined,
      }),
    });
    socket.current?.emit('driver:location', {
      lat: location.coords.latitude, lng: location.coords.longitude, rideId: activeRideId || undefined,
    });
  }, [activeRideId, isOnline]);

  const startLocationService = useCallback(async () => {
    if (Platform.OS === 'web') {
      throw new Error('Persistent driver service requires the native My Ride Driver app.');
    }
    const foreground = await Location.requestForegroundPermissionsAsync();
    if (!foreground.granted) throw new Error('Location permission is required to go online.');
    const background = await Location.requestBackgroundPermissionsAsync();
    if (!background.granted) throw new Error('Allow location access all the time to remain online while the screen is off.');
    await configureNotifications();
    if (!await Location.hasStartedLocationUpdatesAsync(BACKGROUND_LOCATION_TASK)) {
      await Location.startLocationUpdatesAsync(BACKGROUND_LOCATION_TASK, backgroundLocationOptions);
    }
    const latest = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Highest });
    await sendCurrentLocation(latest);
  }, [sendCurrentLocation]);

  const stopLocationService = useCallback(async () => {
    if (Platform.OS !== 'web' && await Location.hasStartedLocationUpdatesAsync(BACKGROUND_LOCATION_TASK)) {
      await Location.stopLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
    }
  }, []);

  const setOnlineState = useCallback(async (next: boolean) => {
    const token = tokenRef.current;
    if (!token) throw new Error('Sign in is required.');
    try {
      await api('/api/driver/availability', token, sessionRef.current || undefined, {
        method: 'POST', body: JSON.stringify({ isOnline: next }),
      });
      if (next) await startLocationService();
      await SecureStore.setItemAsync(ONLINE_KEY, String(next));
      setIsOnline(next);
      socket.current?.emit('driver:status', { isOnline: next });
      if (next) socket.current?.emit('driver:heartbeat');
      else await stopLocationService();
    } catch (cause) {
      if (next) {
        await api('/api/driver/availability', token, sessionRef.current || undefined, {
          method: 'POST', body: JSON.stringify({ isOnline: false }),
        }).catch(() => undefined);
        await stopLocationService();
      }
      throw cause;
    }
  }, [startLocationService, stopLocationService]);

  const registerExpoToken = useCallback(async () => {
    if (Platform.OS === 'web' || !tokenRef.current) return;
    try {
      await configureNotifications();
      const projectId = Constants.easConfig?.projectId ?? Constants.expoConfig?.extra?.eas?.projectId;
      const pushToken = await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined);
      await api('/api/driver/push-token', tokenRef.current, sessionRef.current || undefined, {
        method: 'POST', body: JSON.stringify({ token: pushToken.data }),
      });
    } catch { /* Notifications still work locally even if a development build lacks a project id. */ }
  }, []);

  useEffect(() => {
    Promise.all([
      SecureStore.getItemAsync(TOKEN_KEY), SecureStore.getItemAsync(SESSION_KEY), SecureStore.getItemAsync(USER_KEY),
      SecureStore.getItemAsync(ONLINE_KEY), SecureStore.getItemAsync(ACTIVE_RIDE_KEY),
    ]).then(([token, session, storedUser, storedOnline, storedRide]) => {
      tokenRef.current = token; sessionRef.current = session;
      if (storedUser) setUser(JSON.parse(storedUser) as DriverUser);
      setIsOnline(storedOnline === 'true');
      setActiveRideId(storedRide);
      setReady(true);
    }).catch(() => setReady(true));
  }, []);

  useEffect(() => {
    const subscription = Notifications.addNotificationResponseReceivedListener(response => {
      const data = response.notification.request.content.data as { type?: string; ride?: RideRequest };
      if (data.type === 'ride:new' && data.ride) {
        if (response.actionIdentifier !== 'dismiss') setPendingRide(data.ride);
      }
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (!ready || !tokenRef.current) return;
    connectSocket();
    void registerExpoToken();
    return () => { socket.current?.disconnect(); socket.current = null; };
  }, [connectSocket, ready, registerExpoToken, user]);

  useEffect(() => {
    if (ready && user && tokenRef.current) void loadLongRange().catch(() => undefined);
  }, [loadLongRange, ready, user]);

  useEffect(() => {
    if (!isOnline) return;
    const interval = setInterval(() => {
      socket.current?.emit('driver:heartbeat');
      if (tokenRef.current) void api('/api/driver/heartbeat', tokenRef.current, sessionRef.current || undefined, { method: 'POST' }).catch(() => undefined);
    }, 25_000);
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') {
        socket.current?.connect();
        socket.current?.emit('driver:status', { isOnline: true });
        void hydrateAvailableRides();
      }
    });
    return () => { clearInterval(interval); subscription.remove(); };
  }, [hydrateAvailableRides, isOnline]);

  const signIn = useCallback(async (identifier: string, password: string) => {
    const response = await api('/api/auth/login', undefined, undefined, { method: 'POST', body: JSON.stringify({ identifier, password }) });
    if (response.user?.role !== 'driver') throw new Error('Use the Customer app for this account.');
    if (response.user?.accountStatus !== 'active') throw new Error('Your Driver profile is pending Admin approval.');
    tokenRef.current = response.token; sessionRef.current = response.sessionToken || null;
    const nextUser = response.user as DriverUser;
    await Promise.all([
      SecureStore.setItemAsync(TOKEN_KEY, response.token), SecureStore.setItemAsync(SESSION_KEY, response.sessionToken || ''),
      SecureStore.setItemAsync(USER_KEY, JSON.stringify(nextUser)), SecureStore.setItemAsync(ONLINE_KEY, 'false'),
    ]);
    setUser(nextUser); setIsOnline(false); setError(null);
  }, []);

  const signOut = useCallback(async () => {
    await setOnlineState(false).catch(() => undefined);
    socket.current?.disconnect(); socket.current = null;
    tokenRef.current = null; sessionRef.current = null;
    await Promise.all([TOKEN_KEY, SESSION_KEY, USER_KEY, ONLINE_KEY, ACTIVE_RIDE_KEY].map(key => SecureStore.deleteItemAsync(key)));
    setUser(null); setPendingRide(null); setActiveRideId(null); setConnection('offline');
  }, [setOnlineState]);

  const acceptRide = useCallback(async () => {
    if (!pendingRide || !tokenRef.current) return;
    await api(`/api/rides/${pendingRide.id}/counter`, tokenRef.current, sessionRef.current || undefined, {
      method: 'PATCH', body: JSON.stringify({ price: pendingRide.fare, type: 'accept' }),
    });
    socket.current?.emit('ride:join', pendingRide.id);
    setPendingRide(null);
  }, [pendingRide]);

  const setLongRange = useCallback(async (enabled: boolean) => {
    if (!tokenRef.current) throw new Error('Sign in is required.');
    const result = await api('/api/driver/long-range', tokenRef.current, sessionRef.current || undefined, {
      method: 'PATCH', body: JSON.stringify({ enabled }),
    });
    setLongRangeState(current => ({ ...(current || { walletBalance: 0, settings: result.settings || {} }), enabled: result.enabled, settings: result.settings || current?.settings || {} }));
    return String(result.message || '');
  }, []);

  const value = useMemo<RuntimeContext>(() => ({
    ready, user, isOnline, connection, pendingRide, activeRideId, error, longRange,
    signIn, signOut, setOnline: setOnlineState, setLongRange, acceptRide, dismissRide: () => setPendingRide(null), clearError: () => setError(null),
  }), [acceptRide, activeRideId, error, isOnline, pendingRide, ready, setOnlineState, setLongRange, signIn, signOut, user, connection, longRange]);
  return <DriverContext.Provider value={value}>{children}</DriverContext.Provider>;
}

export function useDriverRuntime() {
  const context = useContext(DriverContext);
  if (!context) throw new Error('useDriverRuntime must be used inside DriverRuntimeProvider');
  return context;
}