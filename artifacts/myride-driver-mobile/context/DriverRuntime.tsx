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
import {
  ensureRideAlertChannel,
  scheduleNativeRideAlert,
  RIDE_ALERT_CATEGORY_ID,
  RIDE_ALERT_CHANNEL_ID,
} from '@/lib/ride-alerts';
import {
  AndroidAlertSetting,
  getAndroidAlertCapabilities,
  openAndroidAlertSetting,
} from '@/lib/android-alert-capabilities';

const TOKEN_KEY = 'myride.driver.token';
const SESSION_KEY = 'myride.driver.session';
const USER_KEY = 'myride.driver.user';
const ONLINE_KEY = 'myride.driver.online';
const ACTIVE_RIDE_KEY = 'myride.driver.activeRide';
const LOCK_SCREEN_ACK_KEY = 'myride.driver.lockScreenAlertsConfirmed';
const PUSH_TOKEN_KEY = 'myride.driver.pushToken';
const DEVICE_ID_KEY = 'myride.driver.deviceId';
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
  vehicleType?: string; vehicleModel?: string; vehiclePlate?: string; rating?: number;
  paidUntilDate?: string | Date | null; dailyFeeRate?: number | null;
};
export type RideAcceptanceEligibility = {
  allowed: boolean;
  reason?: string | null;
  dailyFeeDue?: boolean;
  dailyFeeRate?: number | null;
  longRangeCommissionAmount?: number;
};
export type RideRequest = {
  id: string; fare: number; distance?: number; vehicleType?: string; createdAt?: string | Date;
  isLongRange?: boolean;
  acceptanceEligibility?: RideAcceptanceEligibility;
  status?: 'requested' | 'accepted' | 'arrived' | 'in-progress' | 'completed' | 'cancelled';
  passenger?: { id?: string; name?: string; phone?: string };
  verificationPin?: string | null;
  broadcastDurationSeconds?: number;
  broadcastExpiresAt?: string | Date;
  pickupLocation?: { address?: string; lat: number; lng: number };
  dropoffLocation?: { address?: string; lat: number; lng: number };
};
export type DriverPayment = {
  _id?: string;
  trxId?: string;
  amount?: number;
  status?: string;
  vehicleCategory?: string;
  adminNote?: string;
  createdAt?: string | Date;
};
export type DriverWalletSummary = {
  balance?: number;
  currentWalletBalance?: number;
  currentBonus?: number;
  todayIncome?: number;
  todayCompletedRides?: number;
  advanceDeposits?: number;
  realCashRecharges?: number;
  realCashWallet?: number;
  realCashAvailable?: number;
  bonusAvailable?: number;
  bonusWallet?: number;
};
export type DriverLocation = {
  latitude: number;
  longitude: number;
  heading?: number;
  speed?: number;
  timestamp: number;
};
export type LongRangeState = {
  enabled: boolean; walletBalance: number; vehicleType?: string; ridePreference?: string;
  settings: { enabled?: boolean; distanceCutoffKm?: number; minimumWalletBalances?: Record<string, number>; manualCommissionAmounts?: Record<string, number> };
};

export type AlertReadiness = {
  checking: boolean;
  ready: boolean;
  notificationsGranted: boolean;
  alertChannelReady: boolean;
  foregroundLocationGranted: boolean;
  backgroundLocationGranted: boolean;
  pushTokenRegistered: boolean;
  lockScreenConfirmed: boolean;
  foregroundServiceReady: boolean;
  overlayPermissionGranted: boolean;
  batteryOptimizationExempt: boolean;
  fullScreenIntentAllowed: boolean;
  message: string | null;
};

type RuntimeContext = {
  ready: boolean; user: DriverUser | null; isOnline: boolean; connection: 'connected' | 'connecting' | 'offline';
  pendingRide: RideRequest | null; sentOffer: RideRequest | null; activeRide: RideRequest | null; activeRideId: string | null;
  pendingRideAcceptable: boolean; pendingRideBlockReason: string | null;
  driverLocation: DriverLocation | null; error: string | null;
  longRange: LongRangeState | null;
  alertReadiness: AlertReadiness;
  rideHistory: RideRequest[] | null;
  rideHistoryLoading: boolean;
  walletSummary: DriverWalletSummary | null;
  paymentHistory: DriverPayment[];
  paymentsLoading: boolean;
  requestPhoneOtp(phone: string, purpose?: 'login' | 'signup'): Promise<string>;
  signIn(identifier: string, password: string, otp?: string): Promise<void>;
  signOut(): Promise<void>;
  setOnline(next: boolean): Promise<void>;
  prepareAlertReadiness(): Promise<void>;
  confirmLockScreenAlerts(): Promise<void>;
  openAlertSetting(setting: AndroidAlertSetting): Promise<void>;
  setLongRange(next: boolean): Promise<string>;
  refreshRideHistory(): Promise<void>;
  refreshPayments(): Promise<void>;
  acceptRide(): Promise<void>;
  acceptingRide: boolean;
  updateRideStatus(status: 'arrived' | 'in-progress' | 'completed', pin?: string): Promise<void>;
  updatingRideStatus: boolean;
  dismissRide(): void;
  emergencyClearRide(): void;
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

async function apiWithTimeout(path: string, token: string, session: string | undefined, init: RequestInit = {}, timeoutMs = 12_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await api(path, token, session, { ...init, signal: controller.signal });
  } catch (error) {
    if ((error as { name?: string })?.name === 'AbortError') {
      throw new Error('The Driver response timed out. We are checking the ride status.');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function configureNotifications(requestPermission = false) {
  if (Platform.OS === 'android') {
    await ensureRideAlertChannel();
  }
  await Notifications.setNotificationCategoryAsync(RIDE_ALERT_CATEGORY_ID, [
    { identifier: 'accept', buttonTitle: 'Accept', options: { opensAppToForeground: true } },
    { identifier: 'dismiss', buttonTitle: 'Dismiss', options: { opensAppToForeground: true } },
  ]);
  let permissions = await Notifications.getPermissionsAsync();
  if (!permissions.granted && requestPermission) {
    permissions = await Notifications.requestPermissionsAsync();
  }
  const channel = Platform.OS === 'android'
    ? await Notifications.getNotificationChannelAsync(RIDE_ALERT_CHANNEL_ID)
    : null;
  return {
    notificationsGranted: permissions.granted,
    alertChannelReady: Platform.OS !== 'android' || Boolean(
      channel
      && channel.importance === Notifications.AndroidImportance.MAX
      && channel.lockscreenVisibility === Notifications.AndroidNotificationVisibility.PUBLIC
      && channel.sound === 'default'
      && channel.enableVibrate
    ),
  };
}

async function getDriverDeviceId() {
  const existing = await SecureStore.getItemAsync(DEVICE_ID_KEY);
  if (existing) return existing;
  const generated = `native-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  await SecureStore.setItemAsync(DEVICE_ID_KEY, generated);
  return generated;
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
  const [sentOffer, setSentOffer] = useState<RideRequest | null>(null);
  const [acceptingRide, setAcceptingRide] = useState(false);
  const [updatingRideStatus, setUpdatingRideStatus] = useState(false);
  const [activeRide, setActiveRide] = useState<RideRequest | null>(null);
  const [activeRideId, setActiveRideId] = useState<string | null>(null);
  const [driverLocation, setDriverLocation] = useState<DriverLocation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [longRange, setLongRangeState] = useState<LongRangeState | null>(null);
  const [rideHistory, setRideHistory] = useState<RideRequest[] | null>(null);
  const [rideHistoryLoading, setRideHistoryLoading] = useState(false);
  const [walletSummary, setWalletSummary] = useState<DriverWalletSummary | null>(null);
  const [paymentHistory, setPaymentHistory] = useState<DriverPayment[]>([]);
  const [paymentsLoading, setPaymentsLoading] = useState(false);
  const [alertReadiness, setAlertReadiness] = useState<AlertReadiness>({
    checking: Platform.OS !== 'web',
    ready: Platform.OS === 'web',
    notificationsGranted: Platform.OS === 'web',
    alertChannelReady: Platform.OS === 'web',
    foregroundLocationGranted: Platform.OS === 'web',
    backgroundLocationGranted: Platform.OS === 'web',
    pushTokenRegistered: Platform.OS === 'web',
    lockScreenConfirmed: Platform.OS === 'web',
    foregroundServiceReady: Platform.OS === 'web',
    overlayPermissionGranted: Platform.OS === 'web',
    batteryOptimizationExempt: Platform.OS === 'web',
    fullScreenIntentAllowed: Platform.OS === 'web',
    message: Platform.OS === 'web' ? null : 'Complete alert setup before going online.',
  });
  const socket = useRef<Socket | null>(null);
  const tokenRef = useRef<string | null>(null);
  const sessionRef = useRef<string | null>(null);
  const isOnlineRef = useRef(false);
  const activeRideIdRef = useRef<string | null>(null);
  const sentOfferRef = useRef<RideRequest | null>(null);
  const alertedRideIds = useRef(new Set<string>());
  const localRideNotificationIds = useRef(new Map<string, string>());
  const receivedRideEvents = useRef(new Map<string, number>());
  const pendingNotificationRideId = useRef<string | null>(null);
  const locallyClearedRideIds = useRef(new Set<string>());
  const emergencyClearGeneration = useRef(0);
  const lastHeartbeatAckAt = useRef(0);
  const locationServiceMode = useRef<'stopped' | 'availability' | 'active-ride'>('stopped');
  const locationServiceTransition = useRef<Promise<void>>(Promise.resolve());
  const specialSettingPrompted = useRef<AndroidAlertSetting | null>(null);

  useEffect(() => { isOnlineRef.current = isOnline; }, [isOnline]);
  useEffect(() => { sentOfferRef.current = sentOffer; }, [sentOffer]);
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
        ? rides.map(ride => normalizeRideRequest(ride as RideRequest & { _id?: string }))
          .filter(ride => isRideOfferLive(ride) && !locallyClearedRideIds.current.has(ride.id))
        : [];
      const sentOfferId = sentOfferRef.current?.id;
      const nextRide = requestedRideId
        ? liveRides.find(ride => ride.id === requestedRideId && ride.id !== sentOfferId)
        : liveRides.find(ride => ride.id !== sentOfferId);
      setPendingRide(current => nextRide || (isRideOfferLive(current) ? current : null));
      return Boolean(nextRide);
    } catch {
      // A reconnect can race the availability change; socket retry continues.
      return false;
    }
  }, []);

  const hydrateActiveRide = useCallback(async () => {
    if (!tokenRef.current) return false;
    try {
      const response = await api('/api/driver/active-ride', tokenRef.current, sessionRef.current || undefined);
      const ride = response?.ride
        ? normalizeRideRequest(response.ride as RideRequest & { _id?: string })
        : null;
      if (ride?.id && locallyClearedRideIds.current.has(ride.id)) {
        setActiveRide(null);
        setActiveRideId(null);
        return false;
      }
      setActiveRide(ride);
      setActiveRideId(ride?.id || null);
      if (ride?.id) {
        await SecureStore.setItemAsync(ACTIVE_RIDE_KEY, ride.id);
      } else {
        await SecureStore.deleteItemAsync(ACTIVE_RIDE_KEY);
      }
      return Boolean(ride);
    } catch {
      // Socket reconnect and the next foreground refresh remain available.
      return false;
    }
  }, []);

  const handleRideOffer = useCallback((ride: RideRequest, { fromPush = false } = {}) => {
    const nextRide = normalizeRideRequest(ride);
    if (!isOnlineRef.current || activeRideIdRef.current || !isRideOfferLive(nextRide)
      || sentOfferRef.current?.id === nextRide.id
      || locallyClearedRideIds.current.has(nextRide.id)) return;
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
    if (AppState.currentState === 'active') {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    } else if (Platform.OS !== 'web' && !fromPush && !alertedRideIds.current.has(nextRide.id)) {
      alertedRideIds.current.add(nextRide.id);
      void SecureStore.getItemAsync(PUSH_TOKEN_KEY).then(pushToken => {
        if (pushToken) {
          alertedRideIds.current.delete(nextRide.id);
          return;
        }
        return scheduleNativeRideAlert(nextRide).then(notificationId => {
          localRideNotificationIds.current.set(nextRide.id, notificationId);
        });
      }).catch(() => {
        alertedRideIds.current.delete(nextRide.id);
      });
    }
  }, []);

  const loadLongRange = useCallback(async () => {
    if (!tokenRef.current) return;
    const data = await api('/api/driver/long-range', tokenRef.current, sessionRef.current || undefined);
    setLongRangeState(data as LongRangeState);
  }, []);

  const getRideAcceptability = useCallback((ride: RideRequest | null) => {
    if (!ride) return { allowed: false, reason: 'Ride request is no longer available.' };
    if (ride.acceptanceEligibility?.allowed === false) {
      return { allowed: false, reason: ride.acceptanceEligibility.reason || 'This ride cannot be accepted yet.' };
    }
    if (ride.isLongRange) {
      const category = ride.vehicleType || longRange?.vehicleType || user?.vehicleType || 'Car Mini Non-AC';
      const minimum = Number(longRange?.settings?.minimumWalletBalances?.[category] || 0);
      const commission = Number(longRange?.settings?.manualCommissionAmounts?.[category] || 0);
      const required = Math.max(minimum, commission);
      if (!longRange?.settings?.enabled || !longRange.enabled) {
        return { allowed: false, reason: 'Long Range mode is not enabled for this Driver.' };
      }
      if (commission <= 0) {
        return { allowed: false, reason: 'A manual Long Range charge is not configured for this vehicle.' };
      }
      if (Number(longRange.walletBalance || 0) < required) {
        return { allowed: false, reason: `Wallet balance must cover the Long Range charge of Rs ${commission.toLocaleString()}.` };
      }
    } else if (user?.dailyFeeRate) {
      const paidUntil = user.paidUntilDate ? new Date(user.paidUntilDate) : null;
      const feeCurrent = paidUntil && !Number.isNaN(paidUntil.getTime()) && paidUntil >= new Date();
      if (!feeCurrent) {
        return { allowed: false, reason: `Pay today's Daily Fee of Rs ${Number(user.dailyFeeRate).toLocaleString()} before accepting rides.` };
      }
    }
    return { allowed: true, reason: null };
  }, [longRange, user]);

  const refreshRideHistory = useCallback(async () => {
    if (!tokenRef.current) return;
    setRideHistoryLoading(true);
    try {
      const rides = await api('/api/rides/my', tokenRef.current, sessionRef.current || undefined);
      setRideHistory(Array.isArray(rides)
        ? rides.map(ride => normalizeRideRequest(ride as RideRequest & { _id?: string }))
        : []);
    } finally {
      setRideHistoryLoading(false);
    }
  }, []);

  const refreshPayments = useCallback(async () => {
    if (!tokenRef.current) return;
    setPaymentsLoading(true);
    try {
      const [summary, payments] = await Promise.all([
        api('/api/wallet/summary', tokenRef.current, sessionRef.current || undefined),
        api('/api/payments/my', tokenRef.current, sessionRef.current || undefined),
      ]);
      setWalletSummary(summary as DriverWalletSummary);
      setPaymentHistory(Array.isArray(payments) ? payments as DriverPayment[] : []);
    } finally {
      setPaymentsLoading(false);
    }
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
      void hydrateActiveRide().then(rideIsActive => {
        if (rideIsActive && activeRideIdRef.current) nextSocket.emit('ride:join', activeRideIdRef.current);
      });
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
    nextSocket.on('ride:new', handleRideOffer);
    nextSocket.on('ride:taken', ({ rideId }: { rideId: string }) => {
      clearRideAlert(rideId);
      setPendingRide(current => current?.id === rideId ? null : current);
      setSentOffer(current => current?.id === rideId ? null : current);
      if (sentOfferRef.current?.id === rideId) sentOfferRef.current = null;
    });
    nextSocket.on('ride:accepted', ({ rideId }: { rideId: string }) => {
      if (sentOfferRef.current?.id !== rideId) return;
      clearRideAlert(rideId);
      setSentOffer(null);
      sentOfferRef.current = null;
      setPendingRide(current => current?.id === rideId ? null : current);
      // Do not promote the stale requested snapshot into an active ride. The
      // server's accepted snapshot contains the assigned Driver and latest
      // status, so recover it before showing navigation.
      void hydrateActiveRide();
    });
    const clearCancelledRide = ({ rideId, status }: { rideId: string; status?: string }) => {
      if (status && status !== 'cancelled') return;
      const cancelledRideId = String(rideId || '');
      if (!cancelledRideId) return;
      locallyClearedRideIds.current.add(cancelledRideId);
      clearRideAlert(cancelledRideId);
      setPendingRide(current => current?.id === cancelledRideId ? null : current);
      setSentOffer(current => current?.id === cancelledRideId ? null : current);
      if (sentOfferRef.current?.id === cancelledRideId) sentOfferRef.current = null;
      if (activeRideIdRef.current === cancelledRideId) {
        activeRideIdRef.current = null;
        setActiveRide(null);
        setActiveRideId(null);
        void SecureStore.deleteItemAsync(ACTIVE_RIDE_KEY);
      }
    };
    nextSocket.on('ride_cancelled', clearCancelledRide);
    nextSocket.on('ride:status', ({ rideId, status }: { rideId: string; status: string }) => {
      if (status === 'cancelled') {
        clearCancelledRide({ rideId, status });
        return;
      }
      if (status === 'completed') {
        setActiveRideId(current => {
          if (current === rideId) {
            void SecureStore.deleteItemAsync(ACTIVE_RIDE_KEY);
            setActiveRide(null);
            return null;
          }
          return current;
        });
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
  }, [clearRideAlert, handleRideOffer, hydrateActiveRide, hydrateAvailableRides]);

  const sendCurrentLocation = useCallback(async (location: Location.LocationObject) => {
    if (!tokenRef.current || !isOnlineRef.current) return;
    const { latitude, longitude, heading, speed } = location.coords;
    setDriverLocation({
      latitude,
      longitude,
      heading: Number.isFinite(heading) && Number(heading) >= 0 ? Number(heading) : undefined,
      speed: Number.isFinite(speed) && Number(speed) >= 0 ? Number(speed) : undefined,
      timestamp: location.timestamp || Date.now(),
    });
    await api('/api/driver/location', tokenRef.current, sessionRef.current || undefined, {
      method: 'POST', body: JSON.stringify({
        lat: latitude, lng: longitude, rideId: activeRideIdRef.current || undefined,
      }),
    });
  }, []);

  const startLocationService = useCallback(async (activeRideTracking = Boolean(activeRideIdRef.current)) => {
    if (Platform.OS === 'web') {
      throw new Error('Persistent driver service requires the native My Ride Driver app.');
    }
    const foreground = await Location.getForegroundPermissionsAsync();
    if (!foreground.granted) throw new Error('Location permission is required to go online.');
    const background = await Location.getBackgroundPermissionsAsync();
    if (!background.granted) throw new Error('Allow location access all the time to remain online while the screen is off.');
    const notificationState = await configureNotifications(false);
    if (!notificationState.notificationsGranted || !notificationState.alertChannelReady) {
      throw new Error('Ride notifications and lock-screen visibility must be enabled before going online.');
    }
    const androidCapabilities = await getAndroidAlertCapabilities();
    if (
      !androidCapabilities.nativeBridgeAvailable
      || !androidCapabilities.overlayPermissionGranted
      || !androidCapabilities.batteryOptimizationExempt
      || !androidCapabilities.fullScreenIntentAllowed
    ) {
      throw new Error('Enable overlay, battery protection exemption, and full-screen ride alerts before going online.');
    }
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
        if (!await Location.hasStartedLocationUpdatesAsync(BACKGROUND_LOCATION_TASK)) {
          throw new Error('The background Driver service could not be started. Check system permissions and retry.');
        }
        const latest = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Highest });
        await sendCurrentLocation(latest);
      });
    locationServiceTransition.current = transition;
    await transition;
    setAlertReadiness(current => ({ ...current, foregroundServiceReady: true }));
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
    void Promise.all([TOKEN_KEY, SESSION_KEY, USER_KEY, ONLINE_KEY, ACTIVE_RIDE_KEY, LOCK_SCREEN_ACK_KEY, PUSH_TOKEN_KEY]
      .map(key => SecureStore.deleteItemAsync(key)));
    setUser(null);
    setIsOnline(false);
    setPendingRide(null);
    setSentOffer(null);
    sentOfferRef.current = null;
    setActiveRide(null);
    setActiveRideId(null);
    setDriverLocation(null);
    setLongRangeState(null);
    setRideHistory(null);
    setWalletSummary(null);
    setPaymentHistory([]);
    setConnection('offline');
    setAlertReadiness(current => ({ ...current, ready: false, lockScreenConfirmed: false, foregroundServiceReady: false }));
    setError('Your account was signed in on another device. Please sign in again.');
  }, [clearAllRideAlerts, stopLocationService]);

  useEffect(() => {
    sessionRevokedHandler = clearRevokedSession;
    return () => {
      if (sessionRevokedHandler === clearRevokedSession) sessionRevokedHandler = null;
    };
  }, [clearRevokedSession]);

  const registerExpoToken = useCallback(async (tokenOverride?: string) => {
    if (Platform.OS === 'web' || !tokenRef.current) return false;
    try {
      const notificationState = await configureNotifications(false);
      if (!notificationState.notificationsGranted) return false;
      const projectId = process.env.EXPO_PUBLIC_EAS_PROJECT_ID
        || Constants.easConfig?.projectId
        || Constants.expoConfig?.extra?.eas?.projectId;
      const pushToken = tokenOverride
        ? { data: tokenOverride }
        : await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined);
      await api('/api/driver/push-token', tokenRef.current, sessionRef.current || undefined, {
        method: 'POST', body: JSON.stringify({ token: pushToken.data }),
      });
      await SecureStore.setItemAsync(PUSH_TOKEN_KEY, pushToken.data);
      return true;
    } catch {
      return false;
    }
  }, []);

  const refreshAlertReadiness = useCallback(async ({
    requestPermissions = false,
    openSpecialSettings = false,
  } = {}) => {
    if (Platform.OS === 'web') return true;
    setAlertReadiness(current => ({ ...current, checking: true, message: null }));
    try {
      const notificationState = await configureNotifications(requestPermissions);
      const androidCapabilities = await getAndroidAlertCapabilities();
      let foregroundLocation = await Location.getForegroundPermissionsAsync();
      if (requestPermissions && !foregroundLocation.granted) {
        foregroundLocation = await Location.requestForegroundPermissionsAsync();
      }
      let backgroundLocation = await Location.getBackgroundPermissionsAsync();
      if (foregroundLocation.granted && requestPermissions && !backgroundLocation.granted) {
        backgroundLocation = await Location.requestBackgroundPermissionsAsync();
      }
      const lockScreenConfirmed = (await SecureStore.getItemAsync(LOCK_SCREEN_ACK_KEY)) === 'true';
      const pushTokenRegistered = notificationState.notificationsGranted
        ? await registerExpoToken()
        : false;
      let foregroundServiceReady = false;
      if (isOnlineRef.current) {
        foregroundServiceReady = await Location.hasStartedLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
      } else if (
        requestPermissions
        && notificationState.notificationsGranted
        && notificationState.alertChannelReady
        && foregroundLocation.granted
        && backgroundLocation.granted
        && pushTokenRegistered
        && lockScreenConfirmed
      ) {
        try {
          await startLocationService(false);
          foregroundServiceReady = await Location.hasStartedLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
          await stopLocationService();
        } catch {
          foregroundServiceReady = false;
          await stopLocationService().catch(() => undefined);
        }
      }
      const ready = Boolean(
        notificationState.notificationsGranted
        && notificationState.alertChannelReady
        && foregroundLocation.granted
        && backgroundLocation.granted
        && pushTokenRegistered
        && lockScreenConfirmed
        && foregroundServiceReady
        && androidCapabilities.nativeBridgeAvailable
        && androidCapabilities.overlayPermissionGranted
        && androidCapabilities.batteryOptimizationExempt
        && androidCapabilities.fullScreenIntentAllowed
      );
      const missingSpecialSetting: AndroidAlertSetting | null = !androidCapabilities.nativeBridgeAvailable
        ? null
        : !androidCapabilities.overlayPermissionGranted
          ? 'overlay'
          : !androidCapabilities.batteryOptimizationExempt
            ? 'battery'
            : !androidCapabilities.fullScreenIntentAllowed
              ? 'full-screen'
              : null;
      if (!missingSpecialSetting) specialSettingPrompted.current = null;
      if (openSpecialSettings && requestPermissions && missingSpecialSetting
        && specialSettingPrompted.current !== missingSpecialSetting) {
        specialSettingPrompted.current = missingSpecialSetting;
        await openAndroidAlertSetting(missingSpecialSetting);
      }
      const message = ready
        ? null
        : !androidCapabilities.nativeBridgeAvailable
          ? 'Install the native Driver build to enable Android lock-screen capability checks.'
          : !androidCapabilities.overlayPermissionGranted
            ? 'Allow My Ride to display over other apps so an urgent ride can wake the screen.'
            : !androidCapabilities.batteryOptimizationExempt
              ? 'Allow My Ride to run without battery optimization so Android does not suspend ride alerts.'
              : !androidCapabilities.fullScreenIntentAllowed
                ? 'Allow full-screen ride alerts for My Ride in Android notification settings.'
                : !notificationState.notificationsGranted
          ? 'Allow notifications so ride requests can reach the locked screen.'
          : !notificationState.alertChannelReady
            ? 'Enable the Ride requests notification channel and lock-screen visibility in system settings.'
            : !foregroundLocation.granted || !backgroundLocation.granted
              ? 'Allow precise location and background location to keep your Driver availability active.'
              : !pushTokenRegistered
                ? 'Push registration did not complete. Check your network and retry.'
                : !lockScreenConfirmed
                  ? 'Confirm that My Ride ride alerts are enabled on your lock screen.'
                   : 'The native foreground service could not be verified. Check system settings and retry.';
      setAlertReadiness(current => ({
        checking: false,
        ready,
        notificationsGranted: notificationState.notificationsGranted,
        alertChannelReady: notificationState.alertChannelReady,
        foregroundLocationGranted: foregroundLocation.granted,
        backgroundLocationGranted: backgroundLocation.granted,
        pushTokenRegistered,
        lockScreenConfirmed,
        foregroundServiceReady,
        overlayPermissionGranted: androidCapabilities.overlayPermissionGranted,
        batteryOptimizationExempt: androidCapabilities.batteryOptimizationExempt,
        fullScreenIntentAllowed: androidCapabilities.fullScreenIntentAllowed,
        message,
      }));
      return ready;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Alert setup could not be checked.';
      setAlertReadiness(current => ({ ...current, checking: false, ready: false, message }));
      return false;
    }
  }, [registerExpoToken, startLocationService, stopLocationService]);

  const prepareAlertReadiness = useCallback(async () => {
    await refreshAlertReadiness({ requestPermissions: true, openSpecialSettings: true });
  }, [refreshAlertReadiness]);

  const confirmLockScreenAlerts = useCallback(async () => {
    await SecureStore.setItemAsync(LOCK_SCREEN_ACK_KEY, 'true');
    await refreshAlertReadiness({ requestPermissions: true });
  }, [refreshAlertReadiness]);

  const openAlertSetting = useCallback(async (setting: AndroidAlertSetting) => {
    await openAndroidAlertSetting(setting);
  }, []);

  const recoverNotificationRide = useCallback((response: Notifications.NotificationResponse | null) => {
    const data = response?.notification.request.content.data as {
      type?: string; ride?: RideRequest & { _id?: string }; rideId?: string;
    } | undefined;
    if (data?.type !== 'ride:new') return;
    const rideId = String(data.rideId || data.ride?.id || data.ride?._id || '');
    if (!rideId) return;
    pendingNotificationRideId.current = rideId;
    if (response?.actionIdentifier === 'dismiss') {
      clearRideAlert(rideId);
      pendingNotificationRideId.current = null;
      return;
    }
    if (tokenRef.current && isOnlineRef.current) {
      pendingNotificationRideId.current = null;
      void hydrateAvailableRides(rideId);
    }
  }, [clearRideAlert, hydrateAvailableRides]);

  const setOnlineState = useCallback(async (next: boolean) => {
    const token = tokenRef.current;
    if (!token) throw new Error('Sign in is required.');
    try {
      if (next && Platform.OS !== 'web') {
        const alertSetupReady = await refreshAlertReadiness({ requestPermissions: true });
        if (!alertSetupReady) {
          throw new Error('Complete the required notification, lock-screen, and background-location setup before going online.');
        }
      }
      if (next) {
        isOnlineRef.current = true;
        await startLocationService(Boolean(activeRideIdRef.current));
      }
      await api('/api/driver/availability', token, sessionRef.current || undefined, {
        method: 'POST', body: JSON.stringify({ isOnline: next }),
      });
      await SecureStore.setItemAsync(ONLINE_KEY, String(next));
      setIsOnline(next);
      socket.current?.emit('driver:status', { isOnline: next });
      if (!next) {
        isOnlineRef.current = false;
        setPendingRide(null);
      setActiveRide(null);
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
  }, [clearAllRideAlerts, refreshAlertReadiness, startLocationService, stopLocationService]);

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
    if (ready && user && tokenRef.current && Platform.OS !== 'web') {
      void refreshAlertReadiness({ requestPermissions: true, openSpecialSettings: true });
    }
  }, [ready, refreshAlertReadiness, user]);

  useEffect(() => {
    if (!ready || !user || Platform.OS === 'web') return;
    const handleAppState = (state: string) => {
      if (state !== 'active') return;
      void refreshAlertReadiness({ requestPermissions: true, openSpecialSettings: true }).then(isReady => {
        if (!isReady && isOnlineRef.current) {
          void setOnlineState(false).catch(() => undefined);
        }
      });
    };
    const subscription = AppState.addEventListener('change', handleAppState);
    return () => subscription.remove();
  }, [ready, refreshAlertReadiness, setOnlineState, user]);

  useEffect(() => {
    if (!ready || !user || !tokenRef.current) return;
    void hydrateActiveRide();
  }, [hydrateActiveRide, ready, user]);

  useEffect(() => {
    if (!ready || !user || !isOnline || Platform.OS === 'web') return;
    const rideId = pendingNotificationRideId.current;
    if (rideId) {
      pendingNotificationRideId.current = null;
      void hydrateAvailableRides(rideId);
    }
  }, [hydrateAvailableRides, isOnline, ready, user]);

  useEffect(() => {
    const subscription = Notifications.addNotificationResponseReceivedListener(recoverNotificationRide);
    const receivedSubscription = Notifications.addNotificationReceivedListener(notification => {
      const data = notification.request.content.data as {
        type?: string; ride?: RideRequest & { _id?: string }; rideId?: string;
      };
      if (data.type === 'ride:new' && data.ride) handleRideOffer(data.ride, { fromPush: true });
      else if (data.type === 'ride:new' && data.rideId) {
        pendingNotificationRideId.current = String(data.rideId);
        if (tokenRef.current && isOnlineRef.current) {
          pendingNotificationRideId.current = null;
          void hydrateAvailableRides(String(data.rideId));
        }
      }
    });
    void Notifications.getLastNotificationResponseAsync().then(response => {
      recoverNotificationRide(response);
    }).catch(() => undefined);
    const tokenSubscription = Notifications.addPushTokenListener(({ data }) => {
      void registerExpoToken(data);
    });
    return () => {
      subscription.remove();
      receivedSubscription.remove();
      tokenSubscription.remove();
    };
  }, [handleRideOffer, recoverNotificationRide, registerExpoToken]);

  useEffect(() => {
    if (!ready || !tokenRef.current) return;
    connectSocket();
    return () => { socket.current?.disconnect(); socket.current = null; };
  }, [connectSocket, ready, user]);

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
        if (Platform.OS !== 'web') {
           void refreshAlertReadiness().then(isReady => {
            if (!isReady && isOnlineRef.current) void setOnlineState(false).catch(() => undefined);
          });
        }
      }
    });
    return () => { clearInterval(interval); subscription.remove(); };
  }, [hydrateAvailableRides, isOnline, refreshAlertReadiness, registerExpoToken, setOnlineState]);

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
    void refreshAlertReadiness().then(isReady => {
      if (!isReady) throw new Error('Required alert permissions are no longer available.');
      return startLocationService(Boolean(activeRideId));
    }).catch(async cause => {
      setAlertReadiness(current => ({ ...current, ready: false, foregroundServiceReady: false }));
      setError(cause instanceof Error ? cause.message : 'Background location is no longer available.');
      await setOnlineState(false).catch(() => undefined);
    });
  }, [activeRideId, isOnline, ready, refreshAlertReadiness, setOnlineState, startLocationService, user]);

  const requestPhoneOtp = useCallback(async (phone: string, purpose: 'login' | 'signup' = 'login') => {
    const response = await api('/api/auth/phone-otp/request', undefined, undefined, {
      method: 'POST',
      body: JSON.stringify({ phone, role: 'driver', purpose }),
    });
    return String(response.message || 'Verification code requested. Check the development server log.');
  }, []);

  const requestEmergencyRideCancellation = useCallback((rideId: string) => {
    const token = tokenRef.current;
    const session = sessionRef.current || undefined;
    if (!rideId || !token) return;
    const path = `/api/rides/${encodeURIComponent(rideId)}/emergency-cancel`;
    let acknowledged = false;
    const fallback = () => {
      if (acknowledged) return;
      acknowledged = true;
      void api(path, token, session, { method: 'POST' }).catch(() => undefined);
    };
    if (socket.current?.connected) {
      socket.current.emit(
        'ride:emergency-cancel',
        { rideId },
        (response: { ok?: boolean; retryable?: boolean } = {}) => {
          acknowledged = true;
          if (!response.ok && response.retryable) {
            void api(path, token, session, { method: 'POST' }).catch(() => undefined);
          }
        },
      );
      setTimeout(fallback, 2500);
    } else {
      fallback();
    }
  }, []);

  const signIn = useCallback(async (identifier: string, password: string, otp?: string) => {
    const deviceId = await getDriverDeviceId();
    const response = await api('/api/auth/login', undefined, undefined, {
      method: 'POST',
      body: JSON.stringify(otp
        ? { identifier, otp, role: 'driver', deviceId }
        : { identifier, password, role: 'driver', deviceId }),
    });
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
    await Promise.all([TOKEN_KEY, SESSION_KEY, USER_KEY, ONLINE_KEY, ACTIVE_RIDE_KEY, LOCK_SCREEN_ACK_KEY, PUSH_TOKEN_KEY].map(key => SecureStore.deleteItemAsync(key)));
    setUser(null); setPendingRide(null); setSentOffer(null); sentOfferRef.current = null; setActiveRide(null); setActiveRideId(null); setDriverLocation(null); setRideHistory(null); setWalletSummary(null); setPaymentHistory([]); setConnection('offline');
    setAlertReadiness(current => ({ ...current, ready: false, lockScreenConfirmed: false, foregroundServiceReady: false }));
  }, [setOnlineState]);

  const emergencyClearRide = useCallback(() => {
    const rideIds = new Set([
      pendingRide?.id,
      sentOffer?.id,
      activeRide?.id,
      activeRideId,
    ].filter(Boolean).map(String));

    rideIds.forEach(rideId => {
      locallyClearedRideIds.current.add(rideId);
      socket.current?.emit('ride:leave', rideId);
      requestEmergencyRideCancellation(rideId);
    });

    emergencyClearGeneration.current += 1;
    clearAllRideAlerts();
    receivedRideEvents.current.clear();
    pendingNotificationRideId.current = null;
    sentOfferRef.current = null;
    activeRideIdRef.current = null;
    setPendingRide(null);
    setSentOffer(null);
    setActiveRide(null);
    setActiveRideId(null);
    setAcceptingRide(false);
    setError(null);
    void SecureStore.deleteItemAsync(ACTIVE_RIDE_KEY);
    if (isOnlineRef.current && Platform.OS !== 'web') {
      void startLocationService(false).catch(() => undefined);
    }
  }, [activeRide, activeRideId, clearAllRideAlerts, pendingRide, requestEmergencyRideCancellation, sentOffer, startLocationService]);

  const acceptRide = useCallback(async () => {
    if (!pendingRide || !tokenRef.current || acceptingRide) return;
    const offer = pendingRide;
    const eligibility = getRideAcceptability(offer);
    if (!eligibility.allowed) {
      setError(eligibility.reason || 'This ride cannot be accepted yet.');
      return;
    }
    const clearGeneration = emergencyClearGeneration.current;
    if (!isRideOfferLive(offer)) {
      setPendingRide(null);
      throw new Error('This ride request has expired.');
    }
    setAcceptingRide(true);
    try {
      const response = await apiWithTimeout(`/api/rides/${offer.id}/accept`, tokenRef.current, sessionRef.current || undefined, {
        method: 'PATCH', body: JSON.stringify({}),
      });
      if (clearGeneration !== emergencyClearGeneration.current) return;
      const ride = normalizeRideRequest(response as RideRequest & { _id?: string });
      socket.current?.emit('ride:join', offer.id);
      clearRideAlert(offer.id);
      sentOfferRef.current = null;
      setSentOffer(null);
      setPendingRide(null);
      setActiveRide(ride);
      setActiveRideId(ride.id);
      await SecureStore.setItemAsync(ACTIVE_RIDE_KEY, ride.id);
    } catch (error) {
      // A timeout does not tell us whether the server committed the
      // acceptance. Re-read authoritative state before allowing another
      // attempt, avoiding duplicate claims or a stuck Accept button.
      setAcceptingRide(false);
      await hydrateAvailableRides().catch(() => undefined);
      throw error;
    } finally {
      setAcceptingRide(false);
    }
  }, [acceptingRide, clearRideAlert, getRideAcceptability, hydrateAvailableRides, pendingRide]);

  const updateRideStatus = useCallback(async (
    status: 'arrived' | 'in-progress' | 'completed',
    pin?: string,
  ) => {
    const rideId = activeRideIdRef.current;
    if (!rideId || !tokenRef.current || updatingRideStatus) return;
    setUpdatingRideStatus(true);
    try {
      const response = await apiWithTimeout(
        `/api/rides/${encodeURIComponent(rideId)}/status`,
        tokenRef.current,
        sessionRef.current || undefined,
        {
          method: 'PATCH',
          body: JSON.stringify({ status, ...(pin ? { pin } : {}) }),
        },
      );
      const ride = normalizeRideRequest(response as RideRequest & { _id?: string });
      if (status === 'completed') {
        activeRideIdRef.current = null;
        setActiveRide(null);
        setActiveRideId(null);
        await SecureStore.deleteItemAsync(ACTIVE_RIDE_KEY);
        // Refresh the server-authoritative payout and completed-ride count
        // immediately so Home and Payments converge after settlement.
        void refreshPayments().catch(() => undefined);
        if (isOnlineRef.current && Platform.OS !== 'web') {
          void startLocationService(false).catch(() => undefined);
        }
      } else {
        setActiveRide(current => current?.id === ride.id ? { ...current, ...ride } : current);
      }
    } finally {
      setUpdatingRideStatus(false);
    }
  }, [refreshPayments, startLocationService, updatingRideStatus]);

  const setLongRange = useCallback(async (enabled: boolean) => {
    if (!tokenRef.current) throw new Error('Sign in is required.');
    const result = await api('/api/driver/long-range', tokenRef.current, sessionRef.current || undefined, {
      method: 'PATCH', body: JSON.stringify({ enabled }),
    });
    setLongRangeState(current => ({ ...(current || { walletBalance: 0, settings: result.settings || {} }), enabled: result.enabled, settings: result.settings || current?.settings || {} }));
    return String(result.message || '');
  }, []);

  const pendingRideAcceptability = getRideAcceptability(pendingRide);
  const value = useMemo<RuntimeContext>(() => ({
    ready, user, isOnline, connection, pendingRide,
    pendingRideAcceptable: pendingRideAcceptability.allowed,
    pendingRideBlockReason: pendingRideAcceptability.reason || null,
    sentOffer, activeRide, activeRideId, driverLocation, error, longRange, alertReadiness,
    rideHistory, rideHistoryLoading, walletSummary, paymentHistory, paymentsLoading,
    acceptingRide, updateRideStatus, updatingRideStatus, requestPhoneOtp, signIn, signOut, setOnline: setOnlineState, prepareAlertReadiness, confirmLockScreenAlerts, openAlertSetting, setLongRange, refreshRideHistory, refreshPayments, acceptRide,
    dismissRide: () => setPendingRide(null), emergencyClearRide, clearError: () => setError(null),
  }), [acceptRide, acceptingRide, activeRide, activeRideId, alertReadiness, confirmLockScreenAlerts, driverLocation, emergencyClearRide, error, getRideAcceptability, isOnline, openAlertSetting, pendingRide, pendingRideAcceptability.allowed, pendingRideAcceptability.reason, paymentHistory, paymentsLoading, prepareAlertReadiness, ready, refreshPayments, refreshRideHistory, requestPhoneOtp, rideHistory, rideHistoryLoading, sentOffer, setOnlineState, setLongRange, signIn, signOut, updateRideStatus, updatingRideStatus, user, connection, longRange, walletSummary]);
  return <DriverContext.Provider value={value}>{children}</DriverContext.Provider>;
}

export function useDriverRuntime() {
  const context = useContext(DriverContext);
  if (!context) throw new Error('useDriverRuntime must be used inside DriverRuntimeProvider');
  return context;
}