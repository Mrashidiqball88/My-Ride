import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Animated, Linking, PanResponder, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors } from '@/hooks/useColors';
import { DriverLocation, DriverPayment, DriverWalletSummary, RideRequest, useDriverRuntime } from '@/context/DriverRuntime';
import { DriverMapboxWebView } from '@/components/DriverMapboxWebView';

const RTL_TEXT_PATTERN = /[\u0590-\u08ff]/;

function isRtlText(value: unknown) {
  return RTL_TEXT_PATTERN.test(String(value ?? ''));
}

type Coordinate = { latitude: number; longitude: number };

function coordinateFromLocation(location?: { lat: number; lng: number } | null): Coordinate | null {
  if (!location) return null;
  const latitude = Number(location.lat);
  const longitude = Number(location.lng);
  return Number.isFinite(latitude) && Number.isFinite(longitude)
    && latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180
    ? { latitude, longitude }
    : null;
}

function coordinateFromDriver(location: DriverLocation | null): Coordinate | null {
  if (!location || !Number.isFinite(location.latitude) || !Number.isFinite(location.longitude)) return null;
  return { latitude: location.latitude, longitude: location.longitude };
}

function bearingBetween(from: Coordinate, to: Coordinate) {
  const lat1 = from.latitude * Math.PI / 180;
  const lat2 = to.latitude * Math.PI / 180;
  const deltaLongitude = (to.longitude - from.longitude) * Math.PI / 180;
  const y = Math.sin(deltaLongitude) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2)
    - Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLongitude);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function smoothBearing(previous: number | null, next: number) {
  if (previous === null) return next;
  const delta = ((next - previous + 540) % 360) - 180;
  return (previous + delta * 0.35 + 360) % 360;
}

function DriverNavigationMap({ ride, driverLocation, colors }: {
  ride: RideRequest | null;
  driverLocation: DriverLocation | null;
  colors: ReturnType<typeof useColors>;
}) {
  return <DriverMapboxWebView ride={ride} driverLocation={driverLocation} colors={colors} />;
}

type ActiveRideStatus = 'accepted' | 'arrived' | 'in-progress';
type SheetState = 'expanded' | 'compact' | 'collapsed';

function ActiveRideSheet({
  ride,
  driverLocation,
  colors,
  updating,
  onStatusChange,
  onEmergencyClear,
}: {
  ride: RideRequest;
  driverLocation: DriverLocation | null;
  colors: ReturnType<typeof useColors>;
  updating: boolean;
  onStatusChange: (status: 'arrived' | 'in-progress' | 'completed', pin?: string) => void;
  onEmergencyClear: () => void;
}) {
  const [stageHeight, setStageHeight] = useState(520);
  const [sheetState, setSheetState] = useState<SheetState>('compact');
  const [pin, setPin] = useState('');
  const sheetOffset = useRef(new Animated.Value(0)).current;
  const offsetRef = useRef(0);
  const dragStartRef = useRef(0);
  const sheetStateRef = useRef<SheetState>('compact');

  const sheetHeight = Math.max(340, Math.min(500, stageHeight * 0.82));
  const compactOffset = Math.max(0, sheetHeight - 224);
  const collapsedOffset = Math.max(0, sheetHeight - 92);
  const status: ActiveRideStatus = ride.status === 'arrived' || ride.status === 'in-progress'
    ? ride.status
    : 'accepted';
  const passengerName = ride.passenger?.name || 'Passenger';

  const snapTo = (next: SheetState) => {
    const target = next === 'expanded' ? 0 : next === 'compact' ? compactOffset : collapsedOffset;
    sheetStateRef.current = next;
    setSheetState(next);
    offsetRef.current = target;
    Animated.spring(sheetOffset, {
      toValue: target,
      useNativeDriver: true,
      damping: 22,
      stiffness: 220,
      mass: 0.8,
    }).start();
  };

  useEffect(() => {
    sheetStateRef.current = 'compact';
    setSheetState('compact');
    setPin('');
    const target = compactOffset;
    offsetRef.current = target;
    sheetOffset.setValue(target);
  }, [compactOffset, ride.id, sheetOffset]);

  useEffect(() => {
    const target = sheetStateRef.current === 'expanded'
      ? 0
      : sheetStateRef.current === 'compact'
        ? compactOffset
        : collapsedOffset;
    offsetRef.current = target;
    sheetOffset.setValue(target);
  }, [collapsedOffset, compactOffset, sheetOffset]);

  const panResponder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: (_, gestureState) => (
      Math.abs(gestureState.dy) > 5
      && Math.abs(gestureState.dy) >= Math.abs(gestureState.dx)
    ),
    onPanResponderGrant: () => {
      sheetOffset.stopAnimation(value => {
        dragStartRef.current = value;
        offsetRef.current = value;
      });
    },
    onPanResponderMove: (_, gestureState) => {
      const next = Math.max(0, Math.min(collapsedOffset, dragStartRef.current + gestureState.dy));
      offsetRef.current = next;
      sheetOffset.setValue(next);
    },
    onPanResponderRelease: (_, gestureState) => {
      const projected = offsetRef.current + gestureState.vy * 90;
      const next = projected > (compactOffset + collapsedOffset) / 2
        ? 'collapsed'
        : projected > compactOffset / 2
          ? 'compact'
          : 'expanded';
      snapTo(next);
    },
    onPanResponderTerminate: () => snapTo(sheetState),
    onPanResponderTerminationRequest: () => false,
  }), [collapsedOffset, compactOffset, sheetOffset, sheetState]);

  return <View
    style={styles.activeRideStage}
    onLayout={event => setStageHeight(event.nativeEvent.layout.height)}
  >
    <DriverNavigationMap ride={ride} driverLocation={driverLocation} colors={colors} />
    <Animated.View
      style={[
        styles.activeRideSheet,
        {
          height: sheetHeight,
          backgroundColor: colors.card,
          borderColor: colors.primary,
          transform: [{ translateY: sheetOffset }],
        },
      ]}
    >
      <View
        {...panResponder.panHandlers}
        accessibilityRole="adjustable"
        accessibilityLabel="Active ride details panel"
        accessibilityHint="Swipe up to expand ride details or down to minimize them"
        style={styles.sheetHandleArea}
        hitSlop={{ top: 10, bottom: 10, left: 18, right: 18 }}
      >
        <View style={[styles.sheetHandle, { backgroundColor: colors.mutedForeground }]} />
      </View>
      <View style={[styles.sheetHeader, { borderBottomColor: colors.border }]}>
        <View style={styles.sheetStatusRow}>
          <View style={[styles.statusDot, { backgroundColor: colors.primary }]} />
          <View style={{ flex: 1 }}>
            <Text style={[styles.sheetTitle, { color: colors.foreground }]}>
              {status === 'accepted' ? 'On the way to pickup' : status === 'arrived' ? 'At pickup' : 'Ride in progress'}
            </Text>
            <Text style={[styles.sheetSubtitle, { color: colors.mutedForeground }]}>
              {passengerName} · {ride.distance ? `${ride.distance.toFixed(1)} km` : 'Active ride'}
            </Text>
          </View>
          <Pressable
            accessibilityLabel={sheetState === 'expanded' ? 'Minimize ride details' : 'Expand ride details'}
            onPress={() => snapTo(sheetState === 'expanded' ? 'compact' : 'expanded')}
            style={[styles.sheetToggle, { borderColor: colors.border }]}
          >
            <Ionicons name={sheetState === 'expanded' ? 'chevron-down' : 'chevron-up'} size={18} color={colors.primary} />
          </Pressable>
        </View>
      </View>
      <ScrollView
        style={styles.sheetScroll}
        contentContainerStyle={styles.sheetContent}
        nestedScrollEnabled
        showsVerticalScrollIndicator={false}
      >
        <View style={[styles.sheetRouteCard, { backgroundColor: colors.secondary, borderColor: colors.border }]}>
          <Text style={[styles.sheetLabel, { color: colors.primary }]}>PICKUP</Text>
          <Text style={[styles.sheetAddress, { color: colors.foreground }]} numberOfLines={2}>{ride.pickupLocation?.address || 'Pickup location shared'}</Text>
          <View style={[styles.sheetDivider, { backgroundColor: colors.border }]} />
          <Text style={[styles.sheetLabel, { color: colors.destructive }]}>DROP-OFF</Text>
          <Text style={[styles.sheetAddress, { color: colors.foreground }]} numberOfLines={2}>{ride.dropoffLocation?.address || 'Drop-off location'}</Text>
        </View>

        {status === 'accepted' && <Pressable
          disabled={updating}
          onPress={() => onStatusChange('arrived')}
          style={({ pressed }) => [styles.sheetPrimaryButton, { backgroundColor: colors.primary, borderRadius: colors.radius, opacity: updating || pressed ? .7 : 1 }]}
        >
          {updating ? <ActivityIndicator color={colors.primaryForeground} /> : <Text style={[styles.buttonText, { color: colors.primaryForeground }]}>Arrived at pickup</Text>}
        </Pressable>}

        {status === 'arrived' && <View style={[styles.pinCard, { backgroundColor: colors.secondary, borderColor: colors.primary }]}>
          <Text style={[styles.sheetLabel, { color: colors.primary }]}>PASSENGER VERIFICATION</Text>
          <Text style={[styles.pinHint, { color: colors.mutedForeground }]}>Ask the passenger for their 4-digit PIN before starting.</Text>
          <TextInput
            accessibilityLabel="Passenger verification PIN"
            value={pin}
            onChangeText={value => setPin(value.replace(/\D/g, '').slice(0, 4))}
            keyboardType="number-pad"
            maxLength={4}
            placeholder="4-digit PIN"
            placeholderTextColor={colors.mutedForeground}
            style={[styles.pinInput, { color: colors.foreground, borderColor: colors.input, backgroundColor: colors.card }]}
          />
          <Pressable
            disabled={updating || pin.length !== 4}
            onPress={() => onStatusChange('in-progress', pin)}
            style={({ pressed }) => [styles.sheetPrimaryButton, { backgroundColor: colors.primary, borderRadius: colors.radius, opacity: updating || pin.length !== 4 || pressed ? .55 : 1 }]}
          >
            {updating ? <ActivityIndicator color={colors.primaryForeground} /> : <Text style={[styles.buttonText, { color: colors.primaryForeground }]}>Start ride</Text>}
          </Pressable>
        </View>}

        {status === 'in-progress' && <Pressable
          disabled={updating}
          onPress={() => onStatusChange('completed')}
          style={({ pressed }) => [styles.sheetPrimaryButton, { backgroundColor: colors.primary, borderRadius: colors.radius, opacity: updating || pressed ? .7 : 1 }]}
        >
          {updating ? <ActivityIndicator color={colors.primaryForeground} /> : <Text style={[styles.buttonText, { color: colors.primaryForeground }]}>Complete ride</Text>}
        </Pressable>}

        <Pressable
          onLongPress={onEmergencyClear}
          delayLongPress={5000}
          accessibilityHint="Hold for 5 seconds to emergency-cancel this active ride"
          style={[styles.sheetCancelButton, { borderColor: colors.destructive }]}
        >
          <Text style={{ color: colors.destructive }}>Hold 5s to emergency-cancel</Text>
        </Pressable>
      </ScrollView>
    </Animated.View>
  </View>;
}

type DriverTab = 'history' | 'home' | 'payments';
type DriverColors = ReturnType<typeof useColors>;

function formatDriverDate(value?: string | Date) {
  const date = new Date(value || 0);
  if (Number.isNaN(date.getTime())) return 'Date unavailable';
  return date.toLocaleDateString('en-PK', { day: 'numeric', month: 'short', year: 'numeric' });
}

function driverHistoryStatus(status?: string) {
  const labels: Record<string, string> = {
    requested: 'Requested',
    accepted: 'Accepted',
    arrived: 'Arrived',
    'in-progress': 'In progress',
    completed: 'Completed',
    cancelled: 'Cancelled',
  };
  return labels[status || ''] || 'Requested';
}

function DriverStats({
  colors,
  ridesToday,
  earnings,
  rating,
}: {
  colors: DriverColors;
  ridesToday: number;
  earnings: number;
  rating: number;
}) {
  return <View style={[styles.statsStrip, { backgroundColor: colors.card, borderColor: colors.border }]}>
    <View style={[styles.statCard, { backgroundColor: colors.secondary, borderColor: colors.border }]}>
      <Text style={[styles.statValue, { color: colors.primary }]}>{ridesToday}</Text>
      <Text style={[styles.statLabel, { color: colors.mutedForeground }]}>RIDES TODAY</Text>
    </View>
    <View style={[styles.statCard, { backgroundColor: colors.secondary, borderColor: colors.border }]}>
      <Text style={[styles.statValue, { color: colors.primary }]}>Rs {earnings.toLocaleString('en-PK', { maximumFractionDigits: 0 })}</Text>
      <Text style={[styles.statLabel, { color: colors.mutedForeground }]}>EARNINGS</Text>
    </View>
    <View style={[styles.statCard, { backgroundColor: colors.secondary, borderColor: colors.border }]}>
      <Text style={[styles.statValue, { color: colors.primary }]}>{rating.toFixed(1)} ★</Text>
      <Text style={[styles.statLabel, { color: colors.mutedForeground }]}>RATING</Text>
    </View>
  </View>;
}

function DriverHistoryPanel({
  colors,
  rides,
  loading,
  onRefresh,
}: {
  colors: DriverColors;
  rides: RideRequest[] | null;
  loading: boolean;
  onRefresh: () => void;
}) {
  return <View style={styles.destinationPanel}>
    <View style={styles.destinationHeader}>
      <View style={{ flex: 1 }}>
        <Text style={[styles.destinationTitle, { color: colors.foreground }]}>Total Ride History</Text>
        <Text style={[styles.destinationSubtitle, { color: colors.mutedForeground }]}>Your completed, active, and cancelled rides</Text>
      </View>
      <Pressable
        accessibilityLabel="Refresh total ride history"
        disabled={loading}
        onPress={onRefresh}
        style={[styles.refreshButton, { backgroundColor: colors.secondary, borderColor: colors.border, opacity: loading ? .6 : 1 }]}
      >
        <Ionicons name="refresh-outline" size={17} color={colors.primary} />
      </Pressable>
    </View>
    {loading && !rides
      ? <View style={styles.destinationEmpty}><ActivityIndicator color={colors.primary} /><Text style={[styles.destinationEmptyText, { color: colors.mutedForeground }]}>Loading your ride history…</Text></View>
      : !rides?.length
        ? <View style={styles.destinationEmpty}><Ionicons name="receipt-outline" size={28} color={colors.mutedForeground} /><Text style={[styles.destinationEmptyText, { color: colors.mutedForeground }]}>No rides yet. Accepted rides will appear here.</Text></View>
        : <View style={styles.historyList}>
          {rides.map(ride => {
            const status = ride.status || 'requested';
            const fare = Number.isFinite(Number(ride.fare)) ? Number(ride.fare) : 0;
            return <View key={ride.id} style={[styles.historyItem, { backgroundColor: colors.card, borderColor: colors.border, borderLeftColor: status === 'cancelled' ? colors.destructive : colors.primary }]}>
              <View style={styles.historyRoute}>
                <Text numberOfLines={2} style={[styles.historyLocation, { color: colors.foreground }, isRtlText(ride.pickupLocation?.address) && styles.rtlText]}>{ride.pickupLocation?.address || 'Pickup'}</Text>
                <Ionicons name="arrow-forward" size={15} color={colors.primary} />
                <Text numberOfLines={2} style={[styles.historyLocation, styles.historyDropoff, { color: colors.foreground }, isRtlText(ride.dropoffLocation?.address) && styles.rtlText]}>{ride.dropoffLocation?.address || 'Drop-off'}</Text>
              </View>
              <View style={styles.historyMeta}>
                <Text style={[styles.historyStatus, { color: status === 'cancelled' ? colors.destructive : colors.primary, backgroundColor: colors.secondary }]}>{driverHistoryStatus(status)}</Text>
                <Text numberOfLines={1} style={[styles.historyPassenger, { color: colors.mutedForeground }]}>{ride.passenger?.name || 'Customer'}</Text>
                <Text style={[styles.historyDate, { color: colors.mutedForeground }]}>{formatDriverDate(ride.createdAt)}</Text>
                <Text style={[styles.historyFare, { color: colors.primary }]}>Rs {fare.toLocaleString('en-PK', { maximumFractionDigits: 0 })}</Text>
              </View>
            </View>;
          })}
        </View>}
  </View>;
}

function DriverPaymentsPanel({
  colors,
  summary,
  payments,
  loading,
  onRefresh,
}: {
  colors: DriverColors;
  summary: DriverWalletSummary | null;
  payments: DriverPayment[];
  loading: boolean;
  onRefresh: () => void;
}) {
  const balance = Number(summary?.balance ?? 0);
  const currentWallet = Number(summary?.currentWalletBalance ?? summary?.realCashWallet ?? 0);
  const bonus = Number(summary?.bonusAvailable ?? summary?.bonusWallet ?? 0);
  return <View style={styles.destinationPanel}>
    <View style={styles.destinationHeader}>
      <View style={{ flex: 1 }}>
        <Text style={[styles.destinationTitle, { color: colors.foreground }]}>Payments</Text>
        <Text style={[styles.destinationSubtitle, { color: colors.mutedForeground }]}>Wallet balance and recharge submissions</Text>
      </View>
      <Pressable
        accessibilityLabel="Refresh payments"
        disabled={loading}
        onPress={onRefresh}
        style={[styles.refreshButton, { backgroundColor: colors.secondary, borderColor: colors.border, opacity: loading ? .6 : 1 }]}
      >
        <Ionicons name="refresh-outline" size={17} color={colors.primary} />
      </Pressable>
    </View>
    {loading && !summary
      ? <View style={styles.destinationEmpty}><ActivityIndicator color={colors.primary} /><Text style={[styles.destinationEmptyText, { color: colors.mutedForeground }]}>Loading payments…</Text></View>
      : <>
        <View style={[styles.walletCard, { backgroundColor: colors.secondary, borderColor: colors.border }]}>
          <Text style={[styles.walletLabel, { color: colors.mutedForeground }]}>CURRENT WALLET BALANCE</Text>
          <Text style={[styles.walletBalance, { color: colors.primary }]}>Rs {balance.toLocaleString('en-PK', { maximumFractionDigits: 0 })}</Text>
          <View style={styles.walletBreakdown}>
            <Text style={[styles.walletBreakdownText, { color: colors.mutedForeground }]}>Current wallet Rs {currentWallet.toLocaleString('en-PK', { maximumFractionDigits: 0 })}</Text>
            <Text style={[styles.walletBreakdownText, { color: colors.primary }]}>Bonus Rs {bonus.toLocaleString('en-PK', { maximumFractionDigits: 0 })}</Text>
          </View>
        </View>
        <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>PAYMENT SUBMISSIONS</Text>
        {!payments.length
          ? <Text style={[styles.destinationEmptyText, { color: colors.mutedForeground }]}>No payment submissions yet.</Text>
          : <View style={styles.historyList}>{payments.slice(0, 20).map(payment => (
            <View key={payment._id || `${payment.trxId}-${payment.createdAt}`} style={[styles.paymentItem, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <View style={styles.paymentItemTop}>
                <Text style={[styles.paymentTrx, { color: colors.foreground }]}>{payment.trxId || 'Reference unavailable'}</Text>
                <Text style={[styles.historyFare, { color: colors.primary }]}>Rs {Number(payment.amount || 0).toLocaleString('en-PK', { maximumFractionDigits: 0 })}</Text>
              </View>
              <View style={styles.paymentItemTop}>
                <Text style={[styles.historyDate, { color: colors.mutedForeground }]}>{formatDriverDate(payment.createdAt)}</Text>
                <Text style={[styles.paymentStatus, { color: colors.mutedForeground }]}>{payment.status || 'Pending'}</Text>
              </View>
            </View>
          ))}</View>}
      </>}
  </View>;
}

function DriverBottomNavigation({
  colors,
  activeTab,
  bottomInset,
  onSelect,
}: {
  colors: DriverColors;
  activeTab: DriverTab;
  bottomInset: number;
  onSelect: (tab: DriverTab) => void;
}) {
  const items: Array<{ tab: DriverTab; label: string; icon: keyof typeof Ionicons.glyphMap }> = [
    { tab: 'history', label: 'Total Ride History', icon: 'receipt-outline' },
    { tab: 'home', label: 'Home', icon: 'home-outline' },
    { tab: 'payments', label: 'Payments', icon: 'card-outline' },
  ];
  return <View style={[styles.bottomNavigation, { backgroundColor: colors.card, borderTopColor: colors.border, paddingBottom: Math.max(7, bottomInset) }]}>
    {items.map(item => {
      const active = activeTab === item.tab;
      return <Pressable
        key={item.tab}
        accessibilityRole="tab"
        accessibilityState={{ selected: active }}
        accessibilityLabel={item.label}
        onPress={() => onSelect(item.tab)}
        style={({ pressed }) => [styles.bottomNavigationItem, { backgroundColor: active ? colors.secondary : 'transparent', opacity: pressed ? .7 : 1 }]}
      >
        <Ionicons name={item.icon} size={21} color={active ? colors.primary : colors.mutedForeground} />
        <Text style={[styles.bottomNavigationLabel, { color: active ? colors.primary : colors.mutedForeground }]}>{item.label}</Text>
      </Pressable>;
    })}
  </View>;
}

function DriverHome() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const runtime = useDriverRuntime();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [otp, setOtp] = useState('');
  const [authMode, setAuthMode] = useState<'password' | 'otp'>('password');
  const [otpMessage, setOtpMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [activeTab, setActiveTab] = useState<DriverTab>('home');
  const [, setClock] = useState(Date.now());
  const isWeb = Platform.OS === 'web';
  const report = (message: string) => Alert.alert('My Ride Driver', message);
  const longRangeVehicle = runtime.longRange?.vehicleType || runtime.user?.vehicleType || 'Car Mini Non-AC';
  const longRangeMinimum = Number(runtime.longRange?.settings?.minimumWalletBalances?.[longRangeVehicle] || 0);
  const userName = runtime.user?.name || '';
  const todayStats = useMemo(() => {
    const today = new Date().toDateString();
    const completedToday = (runtime.rideHistory || []).filter(ride => (
      ride.status === 'completed' && new Date(ride.createdAt || 0).toDateString() === today
    ));
    return {
      rides: completedToday.length,
      earnings: completedToday.reduce((total, ride) => total + Number(ride.fare || 0) * .85, 0),
      rating: Number.isFinite(Number(runtime.user?.rating)) ? Number(runtime.user?.rating) : 5,
    };
  }, [runtime.rideHistory, runtime.user?.rating]);
  const remainingOfferSeconds = runtime.pendingRide
    ? Math.max(0, Math.ceil((new Date(runtime.pendingRide.broadcastExpiresAt || 0).getTime() - Date.now()) / 1000))
    : 0;
  useEffect(() => {
    if (!runtime.pendingRide) return;
    const interval = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [runtime.pendingRide]);
  useEffect(() => {
    if (runtime.user && runtime.rideHistory === null) void runtime.refreshRideHistory().catch(() => undefined);
  }, [runtime.refreshRideHistory, runtime.rideHistory, runtime.user]);

  const signIn = async () => {
    setBusy(true);
    try { await runtime.signIn(identifier.trim(), authMode === 'password' ? password : '', authMode === 'otp' ? otp.trim() : undefined); }
    catch (error) { report(error instanceof Error ? error.message : 'Unable to sign in'); }
    finally { setBusy(false); }
  };
  const requestOtp = async () => {
    setBusy(true);
    setOtpMessage('');
    try { setOtpMessage(await runtime.requestPhoneOtp(identifier.trim(), 'login')); }
    catch (error) { report(error instanceof Error ? error.message : 'Unable to request phone OTP'); }
    finally { setBusy(false); }
  };
  const toggle = async (value: boolean) => {
    setBusy(true);
    try { await runtime.setOnline(value); }
    catch (error) { report(error instanceof Error ? error.message : 'Unable to change availability'); }
    finally { setBusy(false); }
  };
  const toggleLongRange = async (value: boolean) => {
    if (value) {
      Alert.alert(
        'Long Range Ride Responsibility',
        'NOTICE: All toll plaza payments, motor/highway taxes, and traffic challans during long-range/intercity trips are the sole responsibility of the driver. Customers are not liable for these expenses.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'I Agree & Activate', onPress: () => void activateLongRange() },
        ],
        { cancelable: true },
      );
      return;
    }
    await activateLongRange(false);
  };
  const activateLongRange = async (value = true) => {
    setBusy(true);
    try { report(await runtime.setLongRange(value)); }
    catch (error) { report(error instanceof Error ? error.message : 'Unable to change Long Range mode'); }
    finally { setBusy(false); }
  };
  const prepareAlerts = async () => {
    setBusy(true);
    try { await runtime.prepareAlertReadiness(); }
    catch (error) { report(error instanceof Error ? error.message : 'Unable to check alert permissions'); }
    finally { setBusy(false); }
  };
  const confirmLockScreen = async () => {
    setBusy(true);
    try { await runtime.confirmLockScreenAlerts(); }
    catch (error) { report(error instanceof Error ? error.message : 'Unable to save lock-screen confirmation'); }
    finally { setBusy(false); }
  };
  const openSettings = () => {
    void Linking.openSettings().catch(() => report('Open your device Settings and enable My Ride notifications and lock-screen alerts.'));
  };
  const updateRideStatus = async (status: 'arrived' | 'in-progress' | 'completed', pin?: string) => {
    try { await runtime.updateRideStatus(status, pin); }
    catch (error) { report(error instanceof Error ? error.message : 'Unable to update ride status'); }
  };
  const selectTab = (tab: DriverTab) => {
    setActiveTab(tab);
    if (tab === 'history') void runtime.refreshRideHistory().catch(() => undefined);
    if (tab === 'payments') void runtime.refreshPayments().catch(() => undefined);
  };

  if (!runtime.ready) return <View style={[styles.center, { backgroundColor: colors.background }]}><ActivityIndicator color={colors.primary} /></View>;
  if (!runtime.user) {
    return <View style={[styles.auth, { paddingTop: (isWeb ? 67 : insets.top) + 36, paddingBottom: isWeb ? 34 : insets.bottom, backgroundColor: colors.background }]}>
      <View style={[styles.brandMark, { backgroundColor: colors.primary }]}><Ionicons name="car-sport" size={31} color={colors.primaryForeground} /></View>
      <Text style={[styles.brand, { color: colors.foreground }]}>My Ride <Text style={{ color: colors.primary }}>Driver</Text></Text>
      <Text style={[styles.subtle, { color: colors.mutedForeground }]}>The reliable driver companion</Text>
      <View style={[styles.authCard, { backgroundColor: colors.card, borderColor: colors.border, borderRadius: colors.radius + 10 }]}>
        <Text style={[styles.cardTitle, { color: colors.foreground }]}>Sign in to drive</Text>
        <TextInput testID="driver-identifier" value={identifier} onChangeText={setIdentifier} placeholder="Phone or email" placeholderTextColor={colors.mutedForeground} autoCapitalize="none" style={[styles.input, { color: colors.foreground, borderColor: colors.input }]} />
         <View style={styles.authModes}>
           <Pressable testID="driver-password-mode" onPress={() => setAuthMode('password')} style={[styles.modeButton, { borderColor: authMode === 'password' ? colors.primary : colors.border, backgroundColor: authMode === 'password' ? colors.secondary : colors.card }]}><Text style={{ color: colors.foreground }}>Password</Text></Pressable>
           <Pressable testID="driver-otp-mode" onPress={() => setAuthMode('otp')} style={[styles.modeButton, { borderColor: authMode === 'otp' ? colors.primary : colors.border, backgroundColor: authMode === 'otp' ? colors.secondary : colors.card }]}><Text style={{ color: colors.foreground }}>Phone OTP</Text></Pressable>
         </View>
         {authMode === 'password'
           ? <TextInput testID="driver-password" value={password} onChangeText={setPassword} placeholder="Password" placeholderTextColor={colors.mutedForeground} secureTextEntry style={[styles.input, { color: colors.foreground, borderColor: colors.input }]} />
           : <View style={styles.otpBlock}>
             <TextInput testID="driver-otp" value={otp} onChangeText={setOtp} placeholder="Phone verification code" placeholderTextColor={colors.mutedForeground} keyboardType="number-pad" autoComplete="sms-otp" style={[styles.input, { color: colors.foreground, borderColor: colors.input }]} />
             <Pressable testID="driver-request-otp" onPress={() => void requestOtp()} disabled={busy} style={styles.otpLink}><Text style={{ color: colors.primary }}>Request phone OTP</Text></Pressable>
             {!!otpMessage && <Text style={[styles.otpMessage, { color: colors.mutedForeground }]}>{otpMessage}</Text>}
           </View>}
        <Pressable testID="driver-sign-in" disabled={busy} onPress={signIn} style={({ pressed }) => [styles.primaryButton, { backgroundColor: colors.primary, opacity: pressed || busy ? .75 : 1, borderRadius: colors.radius }]}>
           {busy ? <ActivityIndicator color={colors.primaryForeground} /> : <Text style={[styles.buttonText, { color: colors.primaryForeground }]}>{authMode === 'password' ? 'Sign in' : 'Verify & sign in'}</Text>}
        </Pressable>
      </View>
      <Text style={[styles.legal, { color: colors.mutedForeground }]}>Use the Driver web app to register and upload documents. Admin approval is required before this app can go online.</Text>
    </View>;
  }
  const onlineTone = runtime.isOnline ? colors.primary : colors.mutedForeground;
  return <View style={[styles.appShell, { backgroundColor: colors.background }]}>
   <ScrollView
    style={[styles.app, { backgroundColor: colors.background }]}
    contentContainerStyle={{ paddingTop: isWeb ? 67 : insets.top, paddingBottom: (isWeb ? 34 : insets.bottom) + 112 }}
    nestedScrollEnabled
    keyboardShouldPersistTaps="handled"
   >
    {activeTab === 'home' ? <>
    <View style={styles.header}>
      <View><Text style={[styles.eyebrow, { color: colors.mutedForeground }]}>MY RIDE DRIVER</Text><Text style={[styles.name, { color: colors.foreground }, isRtlText(userName) && styles.rtlText]}>{userName}</Text></View>
      <Pressable testID="driver-sign-out" onPress={() => void runtime.signOut()}><Ionicons name="log-out-outline" size={25} color={colors.mutedForeground} /></Pressable>
    </View>
    {!isWeb && !runtime.alertReadiness.ready && <View testID="driver-alert-readiness" style={[styles.setupCard, { backgroundColor: colors.card, borderColor: colors.primary, borderRadius: colors.radius + 12 }]}>
      <View style={styles.statusRow}><Ionicons name="shield-checkmark-outline" size={22} color={colors.primary} /><View style={{ flex: 1 }}><Text style={[styles.cardTitle, { color: colors.foreground }]}>Required alert setup</Text><Text style={[styles.statusCopy, { color: colors.mutedForeground }]}>Complete these checks before going online. Ride requests must be able to reach you with the screen locked.</Text></View></View>
       {[
        ['Push notifications', runtime.alertReadiness.notificationsGranted],
        ['Ride-alert channel and lock-screen visibility', runtime.alertReadiness.alertChannelReady],
        ['Precise foreground location', runtime.alertReadiness.foregroundLocationGranted],
        ['Background location / screen-off service', runtime.alertReadiness.backgroundLocationGranted],
        ['Expo Push registration', runtime.alertReadiness.pushTokenRegistered],
        ['Lock-screen alerts confirmed', runtime.alertReadiness.lockScreenConfirmed],
        ['Foreground service verified', runtime.alertReadiness.foregroundServiceReady],
        ['Display over other apps', runtime.alertReadiness.overlayPermissionGranted],
        ['Battery optimization exemption', runtime.alertReadiness.batteryOptimizationExempt],
        ['Full-screen wake alerts', runtime.alertReadiness.fullScreenIntentAllowed],
      ].map(([label, passed]) => <View key={String(label)} style={styles.setupRow}><Ionicons name={passed ? 'checkmark-circle' : 'ellipse-outline'} size={17} color={passed ? colors.primary : colors.mutedForeground} /><Text style={[styles.setupRowText, { color: passed ? colors.foreground : colors.mutedForeground }]}>{label}</Text></View>)}
      {runtime.alertReadiness.message && <Text style={[styles.setupMessage, { color: colors.destructive }]}>{runtime.alertReadiness.message}</Text>}
      <View style={styles.setupActions}>
        <Pressable testID="driver-alert-setup" onPress={() => void prepareAlerts()} disabled={busy || runtime.alertReadiness.checking} style={[styles.primaryButton, { backgroundColor: colors.primary, borderRadius: colors.radius, opacity: busy ? .7 : 1 }]}><Text style={[styles.buttonText, { color: colors.primaryForeground }]}>{runtime.alertReadiness.checking ? 'Checking…' : 'Check & enable permissions'}</Text></Pressable>
        <Pressable onPress={openSettings} style={[styles.secondaryButton, { borderColor: colors.border, borderRadius: colors.radius }]}><Text style={{ color: colors.mutedForeground }}>Open device settings</Text></Pressable>
       {!runtime.alertReadiness.overlayPermissionGranted && <Pressable testID="driver-overlay-settings" onPress={() => void runtime.openAlertSetting('overlay')} style={[styles.secondaryButton, { borderColor: colors.border, borderRadius: colors.radius }]}><Text style={{ color: colors.mutedForeground }}>Allow display over other apps</Text></Pressable>}
       {!runtime.alertReadiness.batteryOptimizationExempt && <Pressable testID="driver-battery-settings" onPress={() => void runtime.openAlertSetting('battery')} style={[styles.secondaryButton, { borderColor: colors.border, borderRadius: colors.radius }]}><Text style={{ color: colors.mutedForeground }}>Disable battery optimization</Text></Pressable>}
       {!runtime.alertReadiness.fullScreenIntentAllowed && <Pressable testID="driver-full-screen-settings" onPress={() => void runtime.openAlertSetting('full-screen')} style={[styles.secondaryButton, { borderColor: colors.border, borderRadius: colors.radius }]}><Text style={{ color: colors.mutedForeground }}>Allow full-screen wake alerts</Text></Pressable>}
        {runtime.alertReadiness.notificationsGranted && runtime.alertReadiness.alertChannelReady && runtime.alertReadiness.backgroundLocationGranted && runtime.alertReadiness.pushTokenRegistered && !runtime.alertReadiness.lockScreenConfirmed && <Pressable testID="driver-confirm-lock-screen" onPress={() => void confirmLockScreen()} style={[styles.secondaryButton, { borderColor: colors.primary, borderRadius: colors.radius }]}><Text style={{ color: colors.primary }}>I enabled lock-screen alerts</Text></Pressable>}
      </View>
    </View>}
    <View style={[styles.statusCard, { backgroundColor: colors.card, borderColor: runtime.isOnline ? colors.primary : colors.border, borderRadius: colors.radius + 12 }]}>
      <View style={styles.statusRow}><View style={[styles.statusDot, { backgroundColor: onlineTone }]} /><View style={{ flex: 1 }}><Text style={[styles.statusTitle, { color: colors.foreground }]}>{runtime.isOnline ? 'You are online' : 'You are offline'}</Text><Text style={[styles.statusCopy, { color: colors.mutedForeground }]}>{runtime.isOnline ? 'Foreground service is keeping location and ride alerts active.' : 'Go online when you are ready for trips.'}</Text></View>
       <Switch testID="driver-online-toggle" value={runtime.isOnline} onValueChange={toggle} disabled={busy || (!isWeb && !runtime.alertReadiness.ready)} trackColor={{ false: colors.muted, true: colors.primary }} thumbColor={colors.primaryForeground} /></View>
      {runtime.isOnline && <View style={[styles.serviceLine, { borderTopColor: colors.border }]}><Ionicons name="shield-checkmark-outline" size={17} color={colors.primary} /><Text style={[styles.serviceText, { color: colors.mutedForeground }]}>Background service active · {runtime.connection === 'connected' ? 'Connected' : 'Reconnecting…'}</Text></View>}
    </View>
    <View testID="driver-vehicle-category" style={[styles.vehicleCard, { backgroundColor: colors.secondary, borderColor: colors.border, borderRadius: colors.radius }]}>
      <Ionicons name="car-sport-outline" size={19} color={colors.primary} />
       <View style={{ flex: 1 }}><Text style={[styles.vehicleLabel, { color: colors.mutedForeground }]}>YOUR VEHICLE CATEGORY</Text><Text style={[styles.vehicleName, { color: colors.foreground }, isRtlText(runtime.user.vehicleType) && styles.rtlText]}>{runtime.user.vehicleType || 'Vehicle category not set'}</Text></View>
    </View>
    {runtime.longRange && <View style={[styles.longRangeCard, { backgroundColor: colors.card, borderColor: runtime.longRange.settings?.enabled ? colors.border : colors.input, borderRadius: colors.radius + 12 }]}>
      <View style={styles.statusRow}><Ionicons name="map-outline" size={20} color={colors.primary} /><View style={{ flex: 1 }}><Text style={[styles.longRangeTitle, { color: colors.foreground }]}>Long Range Rides</Text><Text style={[styles.statusCopy, { color: colors.mutedForeground }]}>{runtime.longRange.settings?.enabled ? `Receive trips from ${Number(runtime.longRange.settings.distanceCutoffKm || 0).toLocaleString()} km+ · ${longRangeVehicle} wallet minimum Rs ${longRangeMinimum.toLocaleString()}` : 'Long Range rides are currently disabled by Admin.'}</Text></View><Switch testID="driver-long-range-toggle" value={runtime.longRange.enabled} onValueChange={toggleLongRange} disabled={busy || !runtime.longRange.settings?.enabled} trackColor={{ false: colors.muted, true: colors.primary }} thumbColor={colors.primaryForeground} /></View>
       {runtime.longRange.enabled && <View testID="long-range-responsibility-banner" style={[styles.longRangeReminder, { backgroundColor: colors.secondary, borderColor: colors.border }]}><Ionicons name="warning-outline" size={16} color={colors.primary} /><Text style={[styles.longRangeReminderText, { color: colors.secondaryForeground }]}>Reminder: Tolls, taxes, and challans are driver responsibility.</Text></View>}
    </View>}
     {!isWeb && runtime.activeRide && <ActiveRideSheet
       ride={runtime.activeRide}
       driverLocation={runtime.driverLocation}
       colors={colors}
       updating={runtime.updatingRideStatus}
       onStatusChange={updateRideStatus}
       onEmergencyClear={runtime.emergencyClearRide}
     />}
     {!isWeb && !runtime.activeRide && runtime.pendingRide && <DriverNavigationMap
       ride={runtime.pendingRide}
       driverLocation={runtime.driverLocation}
       colors={colors}
     />}
    {runtime.pendingRide ? <View style={[styles.rideCard, { backgroundColor: colors.card, borderColor: colors.primary, borderRadius: colors.radius + 12 }]}>
      <View style={styles.rideHeader}><Text style={[styles.rideLabel, { color: colors.primary }]}>{runtime.pendingRide.isLongRange ? 'LONG RANGE RIDE' : 'NEW RIDE'}</Text><Text style={[styles.fare, { color: colors.foreground }]}>Rs {Number(runtime.pendingRide.fare).toLocaleString()}</Text></View>
      <View style={[styles.offerTimer, { backgroundColor: colors.secondary, borderColor: colors.border }]}><Ionicons name="time-outline" size={15} color={colors.primary} /><Text style={[styles.offerTimerText, { color: colors.secondaryForeground }]}>Reply within {remainingOfferSeconds}s</Text></View>
       <Text style={[styles.location, { color: colors.foreground }, isRtlText(runtime.pendingRide.pickupLocation?.address) && styles.rtlText]} numberOfLines={1}>{runtime.pendingRide.pickupLocation?.address || 'Pickup location shared'}</Text>
       <Text style={[styles.route, { color: colors.mutedForeground }, isRtlText(runtime.pendingRide.dropoffLocation?.address) && styles.rtlText]} numberOfLines={1}>To {runtime.pendingRide.dropoffLocation?.address || 'Drop-off location'} · {runtime.pendingRide.distance?.toFixed(1) || '—'} km</Text>
        <View style={styles.rideActions}><Pressable onPress={runtime.dismissRide} onLongPress={runtime.emergencyClearRide} delayLongPress={5000} accessibilityHint="Hold for 5 seconds to clear a stuck ride locally" disabled={runtime.acceptingRide} style={[styles.secondaryButton, { borderColor: colors.border, borderRadius: colors.radius, opacity: runtime.acceptingRide ? .6 : 1 }]}><Text style={{ color: colors.mutedForeground }}>Dismiss</Text></Pressable><Pressable testID="driver-accept-ride" onPress={() => void runtime.acceptRide()} disabled={runtime.acceptingRide} style={[styles.acceptButton, { backgroundColor: colors.primary, borderRadius: colors.radius, opacity: runtime.acceptingRide ? .7 : 1 }]}>{runtime.acceptingRide ? <ActivityIndicator color={colors.primaryForeground} /> : <Text style={[styles.buttonText, { color: colors.primaryForeground }]}>Accept</Text>}</Pressable></View>
     </View> : runtime.sentOffer ? <View style={[styles.waiting, { borderColor: colors.primary, borderRadius: colors.radius + 12 }]}><Ionicons name="paper-plane-outline" size={32} color={colors.primary} /><Text style={[styles.waitingTitle, { color: colors.foreground }]}>Offer sent</Text><Text style={[styles.waitingCopy, { color: colors.mutedForeground }]}>The Customer is reviewing your offer. This screen will switch to the active ride after the Customer confirms you.</Text></View> : <View style={[styles.waiting, { borderColor: colors.border, borderRadius: colors.radius + 12 }]}><Ionicons name={runtime.isOnline ? 'radio-outline' : 'power-outline'} size={32} color={onlineTone} /><Text style={[styles.waitingTitle, { color: colors.foreground }]}>{runtime.isOnline ? 'Waiting for rides' : 'Ready when you are'}</Text><Text style={[styles.waitingCopy, { color: colors.mutedForeground }]}>{runtime.isOnline ? 'Ride alerts will appear here and in your device notifications.' : 'Turn on availability to start receiving ride requests.'}</Text></View>}
     <DriverStats colors={colors} ridesToday={todayStats.rides} earnings={todayStats.earnings} rating={todayStats.rating} />
     <View style={[styles.info, { backgroundColor: colors.secondary, borderRadius: colors.radius }]}><Ionicons name="information-circle-outline" size={18} color={colors.mutedForeground} /><Text style={[styles.infoText, { color: colors.secondaryForeground }]}>Keep location access set to “Allow all the time.” Android may also ask you to allow the My Ride foreground-service notification. These Android settings are required because OEM battery policies can otherwise stop locked-screen ride alerts.</Text></View>
    {runtime.error && <Pressable onPress={runtime.clearError} style={[styles.error, { backgroundColor: colors.destructive, borderRadius: colors.radius }]}><Text style={{ color: colors.destructiveForeground }}>{runtime.error}</Text></Pressable>}
    {isWeb && <Pressable onPress={() => void Linking.openURL('https://expo.dev')}><Text style={[styles.webNote, { color: colors.mutedForeground }]}>Background tracking is available only in the installed native app.</Text></Pressable>}
    </> : activeTab === 'history'
      ? <DriverHistoryPanel
        colors={colors}
        rides={runtime.rideHistory}
        loading={runtime.rideHistoryLoading}
        onRefresh={() => void runtime.refreshRideHistory().catch(() => undefined)}
      />
      : <DriverPaymentsPanel
        colors={colors}
        summary={runtime.walletSummary}
        payments={runtime.paymentHistory}
        loading={runtime.paymentsLoading}
        onRefresh={() => void runtime.refreshPayments().catch(() => undefined)}
      />}
   </ScrollView>
   <DriverBottomNavigation colors={colors} activeTab={activeTab} bottomInset={isWeb ? 0 : insets.bottom} onSelect={selectTab} />
  </View>;
}

export default function Index() { return <DriverHome />; }

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  appShell: { flex: 1 },
  auth: { flex: 1, paddingHorizontal: 24, alignItems: 'center' }, brandMark: { width: 62, height: 62, borderRadius: 21, alignItems: 'center', justifyContent: 'center', marginBottom: 18 },
  brand: { fontSize: 30, fontFamily: 'Inter_700Bold' }, subtle: { fontSize: 15, marginTop: 6 }, authCard: { width: '100%', borderWidth: 1, padding: 20, marginTop: 34, gap: 12 },
  cardTitle: { fontFamily: 'Inter_700Bold', fontSize: 19, marginBottom: 5 }, input: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 14, fontFamily: 'Inter_400Regular', fontSize: 16 },
   primaryButton: { height: 52, justifyContent: 'center', alignItems: 'center', marginTop: 4 }, buttonText: { fontFamily: 'Inter_700Bold', fontSize: 16 }, authModes: { flexDirection: 'row', gap: 8 }, modeButton: { flex: 1, minHeight: 42, borderWidth: 1, borderRadius: 10, justifyContent: 'center', alignItems: 'center' }, otpBlock: { gap: 6 }, otpLink: { alignSelf: 'flex-start', paddingVertical: 2 }, otpMessage: { fontSize: 12, lineHeight: 17 }, legal: { fontFamily: 'Inter_400Regular', fontSize: 13, lineHeight: 19, textAlign: 'center', marginTop: 20, paddingHorizontal: 12 },
   app: { flex: 1, paddingHorizontal: 20 }, header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 20 }, eyebrow: { fontFamily: 'Inter_700Bold', fontSize: 11, letterSpacing: 1.2 }, name: { fontFamily: 'Inter_700Bold', fontSize: 24, marginTop: 3 },
  setupCard: { borderWidth: 1, padding: 16, marginBottom: 12 }, setupRow: { flexDirection: 'row', alignItems: 'center', gap: 9, marginTop: 11 }, setupRowText: { flex: 1, fontFamily: 'Inter_500Medium', fontSize: 13 }, setupMessage: { fontFamily: 'Inter_500Medium', fontSize: 12, lineHeight: 18, marginTop: 14 }, setupActions: { gap: 10, marginTop: 16 },
  statusCard: { borderWidth: 1, padding: 18 }, statusRow: { flexDirection: 'row', alignItems: 'center', gap: 12 }, statusDot: { width: 12, height: 12, borderRadius: 6 }, statusTitle: { fontFamily: 'Inter_700Bold', fontSize: 18 }, statusCopy: { fontFamily: 'Inter_400Regular', fontSize: 13, marginTop: 3, lineHeight: 19 },
  longRangeCard: { borderWidth: 1, padding: 16, marginTop: 12 }, longRangeTitle: { fontFamily: 'Inter_700Bold', fontSize: 15 }, longRangeReminder: { flexDirection: 'row', alignItems: 'flex-start', gap: 7, borderWidth: 1, padding: 10, marginTop: 14, borderRadius: 10 }, longRangeReminderText: { flex: 1, fontFamily: 'Inter_600SemiBold', fontSize: 12, lineHeight: 17 },
  serviceLine: { borderTopWidth: 1, flexDirection: 'row', gap: 8, alignItems: 'center', marginTop: 15, paddingTop: 14 }, serviceText: { fontFamily: 'Inter_500Medium', fontSize: 12 },
  vehicleCard: { marginTop: 12, borderWidth: 1, flexDirection: 'row', alignItems: 'center', gap: 10, padding: 13 }, vehicleLabel: { fontFamily: 'Inter_700Bold', fontSize: 10, letterSpacing: .8 }, vehicleName: { fontFamily: 'Inter_600SemiBold', fontSize: 14, marginTop: 2 },
   navigationCard: { marginTop: 18, borderWidth: 1, padding: 12, overflow: 'hidden' }, navigationHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 3, paddingBottom: 10 }, navigationTitle: { fontFamily: 'Inter_700Bold', fontSize: 15 }, navigationSubtitle: { fontFamily: 'Inter_400Regular', fontSize: 11, marginTop: 2 }, recenterButton: { width: 38, height: 38, borderWidth: 1, borderRadius: 19, alignItems: 'center', justifyContent: 'center' }, navigationMapFrame: { height: 310, overflow: 'hidden', borderRadius: 10, position: 'relative' }, navigationMap: { flex: 1 }, fixedDriverMarker: { position: 'absolute', top: '50%', left: '50%', width: 44, height: 54, marginLeft: -22, marginTop: -27, alignItems: 'center', justifyContent: 'center' }, fixedDriverMarkerHalo: { position: 'absolute', width: 38, height: 38, borderRadius: 19, borderWidth: 2, opacity: .28 }, fixedDriverMarkerDot: { width: 18, height: 18, borderRadius: 9, borderWidth: 3, zIndex: 2 }, fixedDriverMarkerArrow: { position: 'absolute', bottom: 3, width: 0, height: 0, borderLeftWidth: 6, borderRightWidth: 6, borderBottomWidth: 11, borderLeftColor: 'transparent', borderRightColor: 'transparent', zIndex: 1 }, gpsStatus: { position: 'absolute', left: 12, bottom: 12, flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 9, paddingVertical: 7, borderRadius: 15, opacity: .95 }, gpsStatusText: { fontFamily: 'Inter_600SemiBold', fontSize: 11 }, pausedBadge: { position: 'absolute', top: 12, left: 12, paddingHorizontal: 9, paddingVertical: 7, borderRadius: 15, opacity: .95 },
   activeRideStage: { height: 520, marginTop: 18, position: 'relative' }, activeRideSheet: { position: 'absolute', left: 0, right: 0, bottom: 0, borderWidth: 1, borderRadius: 24, overflow: 'hidden', elevation: 12, shadowColor: '#000', shadowOpacity: .3, shadowRadius: 18, shadowOffset: { width: 0, height: -6 } }, sheetHandleArea: { height: 42, alignItems: 'center', justifyContent: 'center' }, sheetHandle: { width: 48, height: 5, borderRadius: 3, opacity: .7 }, sheetHeader: { paddingHorizontal: 15, paddingBottom: 12, borderBottomWidth: 1 }, sheetStatusRow: { flexDirection: 'row', alignItems: 'center', gap: 10 }, sheetTitle: { fontFamily: 'Inter_700Bold', fontSize: 15 }, sheetSubtitle: { fontFamily: 'Inter_400Regular', fontSize: 12, marginTop: 3 }, sheetToggle: { width: 36, height: 36, borderWidth: 1, borderRadius: 18, alignItems: 'center', justifyContent: 'center' }, sheetScroll: { flex: 1 }, sheetContent: { padding: 14, gap: 12, paddingBottom: 24 }, sheetRouteCard: { borderWidth: 1, borderRadius: 13, padding: 12 }, sheetLabel: { fontFamily: 'Inter_700Bold', fontSize: 10, letterSpacing: 1 }, sheetAddress: { fontFamily: 'Inter_500Medium', fontSize: 14, lineHeight: 19, marginTop: 4 }, sheetDivider: { height: 1, marginVertical: 11 }, sheetPrimaryButton: { minHeight: 50, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 }, pinCard: { borderWidth: 1, borderRadius: 13, padding: 12, gap: 9 }, pinHint: { fontFamily: 'Inter_400Regular', fontSize: 12, lineHeight: 17 }, pinInput: { height: 50, borderWidth: 1, borderRadius: 11, paddingHorizontal: 14, fontFamily: 'Inter_700Bold', fontSize: 20, letterSpacing: 5 }, sheetCancelButton: { minHeight: 46, borderWidth: 1, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  rideCard: { marginTop: 18, borderWidth: 1, padding: 18 }, rideHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' }, rideLabel: { fontFamily: 'Inter_700Bold', letterSpacing: 1.1, fontSize: 12 }, fare: { fontFamily: 'Inter_700Bold', fontSize: 23 },
  offerTimer: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', borderWidth: 1, borderRadius: 9, paddingHorizontal: 9, paddingVertical: 6, marginTop: 11 }, offerTimerText: { fontFamily: 'Inter_700Bold', fontSize: 12 },
  location: { fontFamily: 'Inter_600SemiBold', fontSize: 16, marginTop: 15 }, route: { fontFamily: 'Inter_400Regular', fontSize: 13, marginTop: 6 }, rideActions: { flexDirection: 'row', gap: 10, marginTop: 18 }, secondaryButton: { flex: 1, height: 46, borderWidth: 1, alignItems: 'center', justifyContent: 'center' }, acceptButton: { flex: 1, height: 46, alignItems: 'center', justifyContent: 'center' },
  waiting: { marginTop: 18, borderWidth: 1, borderStyle: 'dashed', padding: 30, alignItems: 'center' }, waitingTitle: { fontFamily: 'Inter_700Bold', fontSize: 18, marginTop: 12 }, waitingCopy: { fontFamily: 'Inter_400Regular', textAlign: 'center', fontSize: 13, lineHeight: 20, marginTop: 7 },
  info: { flexDirection: 'row', gap: 9, padding: 14, marginTop: 18, alignItems: 'flex-start' }, infoText: { flex: 1, fontFamily: 'Inter_400Regular', fontSize: 12, lineHeight: 18 }, error: { padding: 12, marginTop: 14 }, webNote: { textAlign: 'center', fontSize: 12, marginTop: 16 },
  statsStrip: { flexDirection: 'row', gap: 6, padding: 6, marginTop: 18, borderWidth: 1, borderRadius: 17 },
  statCard: { flex: 1, minHeight: 56, borderWidth: 1, borderRadius: 12, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 3, paddingVertical: 7 },
  statValue: { fontFamily: 'Inter_700Bold', fontSize: 13, lineHeight: 17, textAlign: 'center' },
  statLabel: { fontFamily: 'Inter_700Bold', fontSize: 8, letterSpacing: .45, marginTop: 3, textAlign: 'center' },
  destinationPanel: { flex: 1, padding: 14 },
  destinationHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, marginBottom: 14 },
  destinationTitle: { fontFamily: 'Inter_700Bold', fontSize: 21 },
  destinationSubtitle: { fontFamily: 'Inter_400Regular', fontSize: 12, lineHeight: 17, marginTop: 4 },
  refreshButton: { width: 42, height: 42, borderWidth: 1, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  destinationEmpty: { alignItems: 'center', justifyContent: 'center', paddingVertical: 54, gap: 10 },
  destinationEmptyText: { fontFamily: 'Inter_400Regular', fontSize: 13, lineHeight: 19, textAlign: 'center' },
  historyList: { gap: 8 },
  historyItem: { borderWidth: 1, borderLeftWidth: 3, borderRadius: 14, padding: 11 },
  historyRoute: { flexDirection: 'row', alignItems: 'flex-start', gap: 7 },
  historyLocation: { flex: 1, fontFamily: 'Inter_600SemiBold', fontSize: 13, lineHeight: 18 },
  historyDropoff: { textAlign: 'right' },
  historyMeta: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 7, marginTop: 9 },
  historyStatus: { fontFamily: 'Inter_700Bold', fontSize: 10, borderRadius: 999, paddingHorizontal: 7, paddingVertical: 4 },
  historyPassenger: { flexShrink: 1, fontFamily: 'Inter_400Regular', fontSize: 11 },
  historyDate: { fontFamily: 'Inter_400Regular', fontSize: 10 },
  historyFare: { marginLeft: 'auto', fontFamily: 'Inter_700Bold', fontSize: 11 },
  walletCard: { borderWidth: 1, borderRadius: 14, padding: 14, marginBottom: 20 },
  walletLabel: { fontFamily: 'Inter_700Bold', fontSize: 10, letterSpacing: .75 },
  walletBalance: { fontFamily: 'Inter_700Bold', fontSize: 27, marginTop: 4 },
  walletBreakdown: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 10 },
  walletBreakdownText: { fontFamily: 'Inter_400Regular', fontSize: 11 },
  sectionLabel: { fontFamily: 'Inter_700Bold', fontSize: 10, letterSpacing: .8, marginBottom: 9 },
  paymentItem: { borderWidth: 1, borderRadius: 13, padding: 11 },
  paymentItemTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  paymentTrx: { flex: 1, fontFamily: 'Inter_600SemiBold', fontSize: 12 },
  paymentStatus: { fontFamily: 'Inter_600SemiBold', fontSize: 11, textTransform: 'capitalize' },
  bottomNavigation: { flexDirection: 'row', alignItems: 'stretch', gap: 6, borderTopWidth: 1, paddingHorizontal: 6, paddingTop: 7 },
  bottomNavigationItem: { flex: 1, minHeight: 58, borderRadius: 13, alignItems: 'center', justifyContent: 'center', gap: 3, paddingHorizontal: 3 },
  bottomNavigationLabel: { fontFamily: 'Inter_700Bold', fontSize: 9, lineHeight: 12, textAlign: 'center' },
  rtlText: { fontFamily: 'NotoNaskhArabic_400Regular', writingDirection: 'rtl', textAlign: 'right' },
});