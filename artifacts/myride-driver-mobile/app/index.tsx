import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Linking, Platform, Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors } from '@/hooks/useColors';
import { DriverLocation, RideRequest, useDriverRuntime } from '@/context/DriverRuntime';
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

function DriverHome() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const runtime = useDriverRuntime();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [, setClock] = useState(Date.now());
  const isWeb = Platform.OS === 'web';
  const report = (message: string) => Alert.alert('My Ride Driver', message);
  const longRangeVehicle = runtime.longRange?.vehicleType || runtime.user?.vehicleType || 'Car Mini Non-AC';
  const longRangeMinimum = Number(runtime.longRange?.settings?.minimumWalletBalances?.[longRangeVehicle] || 0);
  const userName = runtime.user?.name || '';
  const remainingOfferSeconds = runtime.pendingRide
    ? Math.max(0, Math.ceil((new Date(runtime.pendingRide.broadcastExpiresAt || 0).getTime() - Date.now()) / 1000))
    : 0;
  useEffect(() => {
    if (!runtime.pendingRide) return;
    const interval = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [runtime.pendingRide]);

  const signIn = async () => {
    setBusy(true);
    try { await runtime.signIn(identifier.trim(), password); }
    catch (error) { report(error instanceof Error ? error.message : 'Unable to sign in'); }
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

  if (!runtime.ready) return <View style={[styles.center, { backgroundColor: colors.background }]}><ActivityIndicator color={colors.primary} /></View>;
  if (!runtime.user) {
    return <View style={[styles.auth, { paddingTop: (isWeb ? 67 : insets.top) + 36, paddingBottom: isWeb ? 34 : insets.bottom, backgroundColor: colors.background }]}>
      <View style={[styles.brandMark, { backgroundColor: colors.primary }]}><Ionicons name="car-sport" size={31} color={colors.primaryForeground} /></View>
      <Text style={[styles.brand, { color: colors.foreground }]}>My Ride <Text style={{ color: colors.primary }}>Driver</Text></Text>
      <Text style={[styles.subtle, { color: colors.mutedForeground }]}>The reliable driver companion</Text>
      <View style={[styles.authCard, { backgroundColor: colors.card, borderColor: colors.border, borderRadius: colors.radius + 10 }]}>
        <Text style={[styles.cardTitle, { color: colors.foreground }]}>Sign in to drive</Text>
        <TextInput testID="driver-identifier" value={identifier} onChangeText={setIdentifier} placeholder="Phone or email" placeholderTextColor={colors.mutedForeground} autoCapitalize="none" style={[styles.input, { color: colors.foreground, borderColor: colors.input }]} />
        <TextInput testID="driver-password" value={password} onChangeText={setPassword} placeholder="Password" placeholderTextColor={colors.mutedForeground} secureTextEntry style={[styles.input, { color: colors.foreground, borderColor: colors.input }]} />
        <Pressable testID="driver-sign-in" disabled={busy} onPress={signIn} style={({ pressed }) => [styles.primaryButton, { backgroundColor: colors.primary, opacity: pressed || busy ? .75 : 1, borderRadius: colors.radius }]}>
          {busy ? <ActivityIndicator color={colors.primaryForeground} /> : <Text style={[styles.buttonText, { color: colors.primaryForeground }]}>Sign in</Text>}
        </Pressable>
      </View>
      <Text style={[styles.legal, { color: colors.mutedForeground }]}>Use the Driver web app to register and upload documents. Admin approval is required before this app can go online.</Text>
    </View>;
  }
  const onlineTone = runtime.isOnline ? colors.primary : colors.mutedForeground;
  return <View style={[styles.app, { backgroundColor: colors.background, paddingTop: isWeb ? 67 : insets.top, paddingBottom: isWeb ? 34 : insets.bottom }]}>
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
    {!isWeb && (runtime.activeRideId || runtime.pendingRide) && <DriverNavigationMap
      ride={runtime.activeRide || runtime.pendingRide}
      driverLocation={runtime.driverLocation}
      colors={colors}
    />}
    {runtime.pendingRide ? <View style={[styles.rideCard, { backgroundColor: colors.card, borderColor: colors.primary, borderRadius: colors.radius + 12 }]}>
      <View style={styles.rideHeader}><Text style={[styles.rideLabel, { color: colors.primary }]}>{runtime.pendingRide.isLongRange ? 'LONG RANGE RIDE' : 'NEW RIDE'}</Text><Text style={[styles.fare, { color: colors.foreground }]}>Rs {Number(runtime.pendingRide.fare).toLocaleString()}</Text></View>
      <View style={[styles.offerTimer, { backgroundColor: colors.secondary, borderColor: colors.border }]}><Ionicons name="time-outline" size={15} color={colors.primary} /><Text style={[styles.offerTimerText, { color: colors.secondaryForeground }]}>Reply within {remainingOfferSeconds}s</Text></View>
       <Text style={[styles.location, { color: colors.foreground }, isRtlText(runtime.pendingRide.pickupLocation?.address) && styles.rtlText]} numberOfLines={1}>{runtime.pendingRide.pickupLocation?.address || 'Pickup location shared'}</Text>
       <Text style={[styles.route, { color: colors.mutedForeground }, isRtlText(runtime.pendingRide.dropoffLocation?.address) && styles.rtlText]} numberOfLines={1}>To {runtime.pendingRide.dropoffLocation?.address || 'Drop-off location'} · {runtime.pendingRide.distance?.toFixed(1) || '—'} km</Text>
       <View style={styles.rideActions}><Pressable onPress={runtime.dismissRide} disabled={runtime.acceptingRide} style={[styles.secondaryButton, { borderColor: colors.border, borderRadius: colors.radius, opacity: runtime.acceptingRide ? .6 : 1 }]}><Text style={{ color: colors.mutedForeground }}>Dismiss</Text></Pressable><Pressable testID="driver-accept-ride" onPress={() => void runtime.acceptRide()} disabled={runtime.acceptingRide} style={[styles.acceptButton, { backgroundColor: colors.primary, borderRadius: colors.radius, opacity: runtime.acceptingRide ? .7 : 1 }]}>{runtime.acceptingRide ? <ActivityIndicator color={colors.primaryForeground} /> : <Text style={[styles.buttonText, { color: colors.primaryForeground }]}>Accept</Text>}</Pressable></View>
     </View> : runtime.sentOffer ? <View style={[styles.waiting, { borderColor: colors.primary, borderRadius: colors.radius + 12 }]}><Ionicons name="paper-plane-outline" size={32} color={colors.primary} /><Text style={[styles.waitingTitle, { color: colors.foreground }]}>Offer sent</Text><Text style={[styles.waitingCopy, { color: colors.mutedForeground }]}>The Customer is reviewing your offer. This screen will switch to the active ride after the Customer confirms you.</Text></View> : <View style={[styles.waiting, { borderColor: colors.border, borderRadius: colors.radius + 12 }]}><Ionicons name={runtime.isOnline ? 'radio-outline' : 'power-outline'} size={32} color={onlineTone} /><Text style={[styles.waitingTitle, { color: colors.foreground }]}>{runtime.isOnline ? 'Waiting for rides' : 'Ready when you are'}</Text><Text style={[styles.waitingCopy, { color: colors.mutedForeground }]}>{runtime.isOnline ? 'Ride alerts will appear here and in your device notifications.' : 'Turn on availability to start receiving ride requests.'}</Text></View>}
     <View style={[styles.info, { backgroundColor: colors.secondary, borderRadius: colors.radius }]}><Ionicons name="information-circle-outline" size={18} color={colors.mutedForeground} /><Text style={[styles.infoText, { color: colors.secondaryForeground }]}>Keep location access set to “Allow all the time.” Android may also ask you to allow the My Ride foreground-service notification. These Android settings are required because OEM battery policies can otherwise stop locked-screen ride alerts.</Text></View>
    {runtime.error && <Pressable onPress={runtime.clearError} style={[styles.error, { backgroundColor: colors.destructive, borderRadius: colors.radius }]}><Text style={{ color: colors.destructiveForeground }}>{runtime.error}</Text></Pressable>}
    {isWeb && <Pressable onPress={() => void Linking.openURL('https://expo.dev')}><Text style={[styles.webNote, { color: colors.mutedForeground }]}>Background tracking is available only in the installed native app.</Text></Pressable>}
  </View>;
}

export default function Index() { return <DriverHome />; }

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  auth: { flex: 1, paddingHorizontal: 24, alignItems: 'center' }, brandMark: { width: 62, height: 62, borderRadius: 21, alignItems: 'center', justifyContent: 'center', marginBottom: 18 },
  brand: { fontSize: 30, fontFamily: 'Inter_700Bold' }, subtle: { fontSize: 15, marginTop: 6 }, authCard: { width: '100%', borderWidth: 1, padding: 20, marginTop: 34, gap: 12 },
  cardTitle: { fontFamily: 'Inter_700Bold', fontSize: 19, marginBottom: 5 }, input: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 14, fontFamily: 'Inter_400Regular', fontSize: 16 },
  primaryButton: { height: 52, justifyContent: 'center', alignItems: 'center', marginTop: 4 }, buttonText: { fontFamily: 'Inter_700Bold', fontSize: 16 }, legal: { fontFamily: 'Inter_400Regular', fontSize: 13, lineHeight: 19, textAlign: 'center', marginTop: 20, paddingHorizontal: 12 },
   app: { flex: 1, paddingHorizontal: 20 }, header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 20 }, eyebrow: { fontFamily: 'Inter_700Bold', fontSize: 11, letterSpacing: 1.2 }, name: { fontFamily: 'Inter_700Bold', fontSize: 24, marginTop: 3 },
  setupCard: { borderWidth: 1, padding: 16, marginBottom: 12 }, setupRow: { flexDirection: 'row', alignItems: 'center', gap: 9, marginTop: 11 }, setupRowText: { flex: 1, fontFamily: 'Inter_500Medium', fontSize: 13 }, setupMessage: { fontFamily: 'Inter_500Medium', fontSize: 12, lineHeight: 18, marginTop: 14 }, setupActions: { gap: 10, marginTop: 16 },
  statusCard: { borderWidth: 1, padding: 18 }, statusRow: { flexDirection: 'row', alignItems: 'center', gap: 12 }, statusDot: { width: 12, height: 12, borderRadius: 6 }, statusTitle: { fontFamily: 'Inter_700Bold', fontSize: 18 }, statusCopy: { fontFamily: 'Inter_400Regular', fontSize: 13, marginTop: 3, lineHeight: 19 },
  longRangeCard: { borderWidth: 1, padding: 16, marginTop: 12 }, longRangeTitle: { fontFamily: 'Inter_700Bold', fontSize: 15 }, longRangeReminder: { flexDirection: 'row', alignItems: 'flex-start', gap: 7, borderWidth: 1, padding: 10, marginTop: 14, borderRadius: 10 }, longRangeReminderText: { flex: 1, fontFamily: 'Inter_600SemiBold', fontSize: 12, lineHeight: 17 },
  serviceLine: { borderTopWidth: 1, flexDirection: 'row', gap: 8, alignItems: 'center', marginTop: 15, paddingTop: 14 }, serviceText: { fontFamily: 'Inter_500Medium', fontSize: 12 },
  vehicleCard: { marginTop: 12, borderWidth: 1, flexDirection: 'row', alignItems: 'center', gap: 10, padding: 13 }, vehicleLabel: { fontFamily: 'Inter_700Bold', fontSize: 10, letterSpacing: .8 }, vehicleName: { fontFamily: 'Inter_600SemiBold', fontSize: 14, marginTop: 2 },
  navigationCard: { marginTop: 18, borderWidth: 1, padding: 12, overflow: 'hidden' }, navigationHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 3, paddingBottom: 10 }, navigationTitle: { fontFamily: 'Inter_700Bold', fontSize: 15 }, navigationSubtitle: { fontFamily: 'Inter_400Regular', fontSize: 11, marginTop: 2 }, recenterButton: { width: 38, height: 38, borderWidth: 1, borderRadius: 19, alignItems: 'center', justifyContent: 'center' }, navigationMapFrame: { height: 310, overflow: 'hidden', borderRadius: 10, position: 'relative' }, navigationMap: { flex: 1 }, fixedDriverMarker: { position: 'absolute', top: '50%', left: '50%', width: 44, height: 54, marginLeft: -22, marginTop: -27, alignItems: 'center', justifyContent: 'center' }, fixedDriverMarkerHalo: { position: 'absolute', width: 38, height: 38, borderRadius: 19, borderWidth: 2, opacity: .28 }, fixedDriverMarkerDot: { width: 18, height: 18, borderRadius: 9, borderWidth: 3, zIndex: 2 }, fixedDriverMarkerArrow: { position: 'absolute', bottom: 3, width: 0, height: 0, borderLeftWidth: 6, borderRightWidth: 6, borderBottomWidth: 11, borderLeftColor: 'transparent', borderRightColor: 'transparent', zIndex: 1 }, gpsStatus: { position: 'absolute', left: 12, bottom: 12, flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 9, paddingVertical: 7, borderRadius: 15, opacity: .95 }, gpsStatusText: { fontFamily: 'Inter_600SemiBold', fontSize: 11 }, pausedBadge: { position: 'absolute', top: 12, left: 12, paddingHorizontal: 9, paddingVertical: 7, borderRadius: 15, opacity: .95 },
  rideCard: { marginTop: 18, borderWidth: 1, padding: 18 }, rideHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' }, rideLabel: { fontFamily: 'Inter_700Bold', letterSpacing: 1.1, fontSize: 12 }, fare: { fontFamily: 'Inter_700Bold', fontSize: 23 },
  offerTimer: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', borderWidth: 1, borderRadius: 9, paddingHorizontal: 9, paddingVertical: 6, marginTop: 11 }, offerTimerText: { fontFamily: 'Inter_700Bold', fontSize: 12 },
  location: { fontFamily: 'Inter_600SemiBold', fontSize: 16, marginTop: 15 }, route: { fontFamily: 'Inter_400Regular', fontSize: 13, marginTop: 6 }, rideActions: { flexDirection: 'row', gap: 10, marginTop: 18 }, secondaryButton: { flex: 1, height: 46, borderWidth: 1, alignItems: 'center', justifyContent: 'center' }, acceptButton: { flex: 1, height: 46, alignItems: 'center', justifyContent: 'center' },
  waiting: { marginTop: 18, borderWidth: 1, borderStyle: 'dashed', padding: 30, alignItems: 'center' }, waitingTitle: { fontFamily: 'Inter_700Bold', fontSize: 18, marginTop: 12 }, waitingCopy: { fontFamily: 'Inter_400Regular', textAlign: 'center', fontSize: 13, lineHeight: 20, marginTop: 7 },
  info: { flexDirection: 'row', gap: 9, padding: 14, marginTop: 18, alignItems: 'flex-start' }, infoText: { flex: 1, fontFamily: 'Inter_400Regular', fontSize: 12, lineHeight: 18 }, error: { padding: 12, marginTop: 14 }, webNote: { textAlign: 'center', fontSize: 12, marginTop: 16 },
  rtlText: { fontFamily: 'NotoNaskhArabic_400Regular', writingDirection: 'rtl', textAlign: 'right' },
});