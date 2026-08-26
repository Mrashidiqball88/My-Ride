import React, { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';
import * as Haptics from 'expo-haptics';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import Constants from 'expo-constants';
import { io, Socket } from 'socket.io-client';
import {
  BACKGROUND_LOCATION_TASK,
  activeRideLocationOptions,
  availabilityLocationOptions,
} from '@/lib/background-location';

const TOKEN_KEY = 'myride.driver.token';
const SESSION_KEY = 'myride.driver.session';
const USER_KEY = 'myride.driver.user';
const ONLINE_KEY = 'myride.driver.online';
const ACTIVE_RIDE_KEY = 'myride.driver.activeRide';
const PAKISTAN_ONLY_MESSAGE = 'Please select a location inside Pakistan.';
const API_URL = process.env.EXPO_PUBLIC_RIDE_API_URL ||
  (process.env.EXPO_PUBLIC_DOMAIN ? `https://${process.env.EXPO_PUBLIC_DOMAIN}` : '');
let sessionRevokedHandler: (() => void) | null = null;

class SessionRevokedError extends Error {
  constructor() {
    super('Your account was signed in on another device.');
    this.name = 'SessionRevokedError';
  }
}

export const DRIVER_VEHICLE_CATEGORIES = [
  'Bike', 'Riksha', 'Car Mini AC', 'Car Mini Non-AC', 'Car Sedan', 'Car SUV', 'Van Seven Seats',
  'Cary Dibba', 'Toyota Highroof', 'Toyota Saloon Coaster',
] as const;

export type DriverUser = {
  id: string; name: string; role: 'driver'; accountStatus: string;
  vehicleType?: string; vehicleModel?: string; vehiclePlate?: string;
};
export type RideRequest = {
  id: string; fare: number; distance?: number; vehicleType?: string;
  isLongRange?: boolean;
  broadcastDurationSeconds?: number;
  broadcastExpiresAt?: string | Date;
  pickupLocation?: { address?: string; lat: number; lng: number };
  dropoffLocation?: { address?: string; lat: number; lng: number };
};
export type LongRangeState = {
  enabled: boolean; walletBalance: number; vehicleType?: string; ridePreference?: string;
  settings: { enabled?: boolean; distanceCutoffKm?: number; minimumWalletBalances?: Record<string, number> };
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
    if (response.status === 401 && data.error === 'LOGGED_IN_ELSEWHERE') {
      sessionRevokedHandler?.();
      throw new SessionRevokedError();
    }
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

function normalizeRideRequest(ride: RideRequest & { _id?: string }): RideRequest {
  return { ...ride, id: String(ride.id || ride._id || '') };
}

function isRideOfferLive(ride: RideRequest | null | undefined) {
  const expiresAt = new Date(ride?.broadcastExpiresAt || 0).getTime();
  return Boolean(ride?.id) && Number.isFinite(expiresAt) && expiresAt > Date.now();
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
  const isOnlineRef = useRef(false);
  const activeRideIdRef = useRef<string | null>(null);
  const alertedRideIds = useRef(new Set<string>());
  const localRideNotificationIds = useRef(new Map<string, string>());
  const receivedRideEvents = useRef(new Map<string, number>());
  const lastHeartbeatAckAt = useRef(0);
  const locationServiceMode = useRef<'stopped' | 'availability' | 'active-ride'>('stopped');
  const locationServiceTransition = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => { isOnlineRef.current = isOnline; }, [isOnline]);
  useEffect(() => { activeRideIdRef.current = activeRideId; }, [activeRideId]);

  const clearRideAlert = useCallback((rideId: string) => {
    alertedRideIds.current.delete(rideId);
    const notificationId = localRideNotificationIds.current.get(rideId);
    localRideNotificationIds.current.delete(rideId);
    if (notificationId) {
      void Notifications.cancelScheduledNotificationAsync(notificationId).catch(() => undefined);
      void Notifications.dismissNotificationAsync(notificationId).catch(() => undefined);
    }
  }, []);

  const clearAllRideAlerts = useCallback(() => {
    alertedRideIds.current.clear();
    const notificationIds = [...localRideNotificationIds.current.values()];
    localRideNotificationIds.current.clear();
    notificationIds.forEach(notificationId => {
      void Notifications.cancelScheduledNotificationAsync(notificationId).catch(() => undefined);
      void Notifications.dismissNotificationAsync(notificationId).catch(() => undefined);
    });
  }, []);

  const hydrateAvailableRides = useCallback(async (requestedRideId?: string) => {
    if (!tokenRef.current || !isOnlineRef.current) return false;
    try {
      const rides = await api('/api/rides/available', tokenRef.current, sessionRef.current || undefined);
      const liveRides = Array.isArray(rides)
        ? rides.map(ride => normalizeRideRequest(ride as RideRequest & { _id?: string })).filter(isRideOfferLive)
        : [];
      const nextRide = requestedRideId
        ? liveRides.find(ride => ride.id === requestedRideId)
        : liveRides[0];
      setPendingRide(current => nextRide || (isRideOfferLive(current) ? current : null));
      return Boolean(nextRide);
    } catch {
      // A reconnect can race the availability change; socket retry continues.
      return false;
    }
  }, []);

  const loadLongRange = useCallback(async () => {
    if (!tokenRef.current) return;
    const data = await api('/api/driver/long-range', tokenRef.current, sessionRef.current || undefined);
    setLongRangeState(data as LongRangeState);
  }, []);

  const connectSocket = useCallback(() => {
    if (!tokenRef.current || socket.current) return;
    setConnection('connecting');
    const nextSocket = io(API_URL, {
      path: '/socket.io', auth: { token: tokenRef.current, sessionToken: sessionRef.current }, transports: ['websocket'],
      reconnection: true, reconnectionAttempts: Infinity, reconnectionDelay: 1000, reconnectionDelayMax: 15_000,
      timeout: 20_000, forceNew: true,
    });
    socket.current = nextSocket;
    nextSocket.on('connect', () => {
      setConnection('connected');
      if (isOnlineRef.current) {
        nextSocket.emit('driver:status', { isOnline: true });
      }
      if (activeRideIdRef.current) nextSocket.emit('ride:join', activeRideIdRef.current);
      void hydrateAvailableRides();
    });
    nextSocket.on('disconnect', () => {
      lastHeartbeatAckAt.current = 0;
      setConnection('connecting');
    });
    nextSocket.on('connect_error', () => setConnection('connecting'));
    nextSocket.on('driver:heartbeat:ack', () => {
      // The REST heartbeat remains the background fallback. This timestamp is
      // used only to detect a foreground socket that needs a clean reconnect.
      lastHeartbeatAckAt.current = Date.now();
    });
    nextSocket.on('driver:rehydrate', () => void hydrateAvailableRides());
    nextSocket.on('ride:new', (ride: RideRequest) => {
      const nextRide = normalizeRideRequest(ride);
      if (!isOnlineRef.current || activeRideIdRef.current || !isRideOfferLive(nextRide)) return;
      const previousEventAt = receivedRideEvents.current.get(nextRide.id) || 0;
      if (Date.now() - previousEventAt < 120_000) return;
      const receivedAt = Date.now();
      receivedRideEvents.current.set(nextRide.id, receivedAt);
      setTimeout(() => {
        if (receivedRideEvents.current.get(nextRide.id) === receivedAt) {
          receivedRideEvents.current.delete(nextRide.id);
        }
      }, 120_000);
      setPendingRide(current => current?.id === nextRide.id ? current : nextRide);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      // Expo's remote notification already displays in the foreground. Only
      // create a local fallback while backgrounded, and only once per ride.
      if (AppState.currentState !== 'active' && !alertedRideIds.current.has(nextRide.id)) {
        alertedRideIds.current.add(nextRide.id);
        void Notifications.scheduleNotificationAsync({
          content: {
            title: 'New ride request',
            body: `${nextRide.pickupLocation?.address || 'Nearby pickup'} · Rs ${Number(nextRide.fare || 0).toLocaleString()}`,
            sound: 'default', categoryIdentifier: 'ride-request', data: { type: 'ride:new', ride: nextRide },
          },
          trigger: null,
        }).then(notificationId => {
          // A cancellation can arrive before the notification promise settles.
          // Do not leave a late local alert behind for a retired ride.
          if (alertedRideIds.current.has(nextRide.id)) {
            localRideNotificationIds.current.set(nextRide.id, notificationId);
          } else {
            void Notifications.cancelScheduledNotificationAsync(notificationId).catch(() => undefined);
            void Notifications.dismissNotificationAsync(notificationId).catch(() => undefined);
          }
        }).catch(() => undefined);
      }
    });
    nextSocket.on('ride:taken', ({ rideId }: { rideId: string }) => {
      clearRideAlert(rideId);
      setPendingRide(current => current?.id === rideId ? null : current);
    });
    nextSocket.on('ride:accepted', ({ rideId }: { rideId: string }) => {
      clearRideAlert(rideId);
      setPendingRide(current => current?.id === rideId ? null : current);
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
      if (status === 'cancelled') {
        clearRideAlert(rideId);
        setPendingRide(current => current?.id === rideId ? null : current);
      }
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
  }, [clearRideAlert, hydrateAvailableRides]);

  const sendCurrentLocation = useCallback(async (location: Location.LocationObject) => {
    if (!tokenRef.current || !isOnlineRef.current) return;
    try {
      await api('/api/driver/location', tokenRef.current, sessionRef.current || undefined, {
        method: 'POST', body: JSON.stringify({
          lat: location.coords.latitude, lng: location.coords.longitude, rideId: activeRideIdRef.current || undefined,
        }),
      });
    } catch (error) {
      if (error instanceof Error && error.message === PAKISTAN_ONLY_MESSAGE) {
        setError(PAKISTAN_ONLY_MESSAGE);
        return;
      }
      throw error;
    }
  }, []);

  const startLocationService = useCallback(async (activeRideTracking = Boolean(activeRideIdRef.current)) => {
    if (Platform.OS === 'web') {
      throw new Error('Persistent driver service requires the native My Ride Driver app.');
    }
    const foreground = await Location.requestForegroundPermissionsAsync();
    if (!foreground.granted) throw new Error('Location permission is required to go online.');
    const background = await Location.requestBackgroundPermissionsAsync();
    if (!background.granted) throw new Error('Allow location access all the time to remain online while the screen is off.');
    await configureNotifications();
    const desiredMode = activeRideTracking ? 'active-ride' : 'availability';
    const transition = locationServiceTransition.current
      .catch(() => undefined)
      .then(async () => {
        const isStarted = await Location.hasStartedLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
        if (isStarted && locationServiceMode.current !== desiredMode) {
          await Location.stopLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
        }
        if (!isStarted || locationServiceMode.current !== desiredMode) {
          await Location.startLocationUpdatesAsync(
            BACKGROUND_LOCATION_TASK,
            activeRideTracking ? activeRideLocationOptions : availabilityLocationOptions
          );
        }
        locationServiceMode.current = desiredMode;
        const latest = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Highest });
        await sendCurrentLocation(latest);
      });
    locationServiceTransition.current = transition;
    await transition;
  }, [sendCurrentLocation]);

  const stopLocationService = useCallback(async () => {
    const transition = locationServiceTransition.current
      .catch(() => undefined)
      .then(async () => {
        if (Platform.OS !== 'web' && await Location.hasStartedLocationUpdatesAsync(BACKGROUND_LOCATION_TASK)) {
          await Location.stopLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
        }
        locationServiceMode.current = 'stopped';
      });
    locationServiceTransition.current = transition;
    await transition;
  }, []);

  const clearRevokedSession = useCallback(() => {
    socket.current?.disconnect();
    socket.current = null;
    tokenRef.current = null;
    sessionRef.current = null;
    clearAllRideAlerts();
    void stopLocationService();
    void Promise.all([TOKEN_KEY, SESSION_KEY, USER_KEY, ONLINE_KEY, ACTIVE_RIDE_KEY]
      .map(key => SecureStore.deleteItemAsync(key)));
    setUser(null);
    setIsOnline(false);
    setPendingRide(null);
    setActiveRideId(null);
    setLongRangeState(null);
    setConnection('offline');
    setError('Your account was signed in on another device. Please sign in again.');
  }, [clearAllRideAlerts, stopLocationService]);

  useEffect(() => {
    sessionRevokedHandler = clearRevokedSession;
    return () => {
      if (sessionRevokedHandler === clearRevokedSession) sessionRevokedHandler = null;
    };
  }, [clearRevokedSession]);

  const setOnlineState = useCallback(async (next: boolean) => {
    const token = tokenRef.current;
    if (!token) throw new Error('Sign in is required.');
    try {
      await api('/api/driver/availability', token, sessionRef.current || undefined, {
        method: 'POST', body: JSON.stringify({ isOnline: next }),
      });
      if (next) {
        isOnlineRef.current = true;
        await startLocationService(Boolean(activeRideIdRef.current));
      }
      await SecureStore.setItemAsync(ONLINE_KEY, String(next));
      setIsOnline(next);
      socket.current?.emit('driver:status', { isOnline: next });
      if (!next) {
        isOnlineRef.current = false;
        setPendingRide(null);
        clearAllRideAlerts();
        await stopLocationService();
      }
    } catch (cause) {
      if (next) {
        isOnlineRef.current = false;
        await api('/api/driver/availability', token, sessionRef.current || undefined, {
          method: 'POST', body: JSON.stringify({ isOnline: false }),
        }).catch(() => undefined);
        await stopLocationService();
      }
      throw cause;
    }
  }, [clearAllRideAlerts, startLocationService, stopLocationService]);

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
      const data = response.notification.request.content.data as {
        type?: string; ride?: RideRequest & { _id?: string }; rideId?: string;
      };
      if (data.type === 'ride:new') {
        const rideId = String(data.rideId || data.ride?.id || data.ride?._id || '');
        if (response.actionIdentifier === 'dismiss') {
          if (rideId) clearRideAlert(rideId);
        } else if (rideId) {
          // Notification payloads can be stale after background suspension.
          // Recheck the authoritative available-rides list before showing it.
          void hydrateAvailableRides(rideId);
        }
      }
    });
    void Notifications.getLastNotificationResponseAsync().then(response => {
      const data = response?.notification.request.content.data as {
        type?: string; ride?: RideRequest & { _id?: string }; rideId?: string;
      } | undefined;
      const rideId = String(data?.rideId || data?.ride?.id || data?.ride?._id || '');
      if (data?.type === 'ride:new' && rideId) {
        void hydrateAvailableRides(rideId);
      }
    }).catch(() => undefined);
    return () => subscription.remove();
  }, [clearRideAlert, hydrateAvailableRides]);

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
      const clientSentAt = new Date().toISOString();
      if (socket.current?.connected) {
        if (lastHeartbeatAckAt.current && Date.now() - lastHeartbeatAckAt.current > 60_000) {
          // A transport can look connected while the foreground app has
          // stopped receiving application frames. Recreate it once, then let
          // Socket.io's normal reconnect and server rehydration take over.
          socket.current.disconnect();
          socket.current.connect();
          return;
        }
        socket.current.emit('driver:heartbeat', { clientSentAt });
      }
      // This REST heartbeat is intentionally retained for Android background
      // suspension, where the JavaScript Socket.io timer may stop running.
      if (tokenRef.current) {
        void api('/api/driver/heartbeat', tokenRef.current, sessionRef.current || undefined, {
          method: 'POST',
        }).catch(() => undefined);
      }
    }, 25_000);
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') {
        socket.current?.connect();
        socket.current?.emit('driver:status', { isOnline: true });
        void registerExpoToken();
        void hydrateAvailableRides();
      }
    });
    return () => { clearInterval(interval); subscription.remove(); };
  }, [hydrateAvailableRides, isOnline, registerExpoToken]);

  useEffect(() => {
    if (!pendingRide) return;
    const remainingMs = new Date(pendingRide.broadcastExpiresAt || 0).getTime() - Date.now();
    if (remainingMs <= 0) {
      clearRideAlert(pendingRide.id);
      setPendingRide(null);
      return;
    }
    const timeout = setTimeout(() => {
      clearRideAlert(pendingRide.id);
      setPendingRide(current => current?.id === pendingRide.id ? null : current);
    }, remainingMs + 25);
    return () => clearTimeout(timeout);
  }, [clearRideAlert, pendingRide]);

  useEffect(() => {
    if (!ready || !user || !isOnline || Platform.OS === 'web') return;
    // Restore the existing foreground/background location task after a normal
    // process restart. If Android permissions were revoked, fail closed.
    void startLocationService(Boolean(activeRideId)).catch(async cause => {
      setError(cause instanceof Error ? cause.message : 'Background location is no longer available.');
      await setOnlineState(false).catch(() => undefined);
    });
  }, [activeRideId, isOnline, ready, startLocationService, user]);

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
    if (!isRideOfferLive(pendingRide)) {
      setPendingRide(null);
      throw new Error('This ride request has expired.');
    }
    await api(`/api/rides/${pendingRide.id}/counter`, tokenRef.current, sessionRef.current || undefined, {
      method: 'PATCH', body: JSON.stringify({ price: pendingRide.fare, type: 'accept' }),
    });
    socket.current?.emit('ride:join', pendingRide.id);
    clearRideAlert(pendingRide.id);
    setPendingRide(null);
  }, [clearRideAlert, pendingRide]);

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