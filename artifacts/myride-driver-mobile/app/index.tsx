import React, { useState } from 'react';
import { ActivityIndicator, Alert, Linking, Platform, Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors } from '@/hooks/useColors';
import { useDriverRuntime } from '@/context/DriverRuntime';

function DriverHome() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const runtime = useDriverRuntime();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const isWeb = Platform.OS === 'web';
  const report = (message: string) => Alert.alert('My Ride Driver', message);

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
      <View><Text style={[styles.eyebrow, { color: colors.mutedForeground }]}>MY RIDE DRIVER</Text><Text style={[styles.name, { color: colors.foreground }]}>{runtime.user.name}</Text></View>
      <Pressable testID="driver-sign-out" onPress={() => void runtime.signOut()}><Ionicons name="log-out-outline" size={25} color={colors.mutedForeground} /></Pressable>
    </View>
    <View style={[styles.statusCard, { backgroundColor: colors.card, borderColor: runtime.isOnline ? colors.primary : colors.border, borderRadius: colors.radius + 12 }]}>
      <View style={styles.statusRow}><View style={[styles.statusDot, { backgroundColor: onlineTone }]} /><View style={{ flex: 1 }}><Text style={[styles.statusTitle, { color: colors.foreground }]}>{runtime.isOnline ? 'You are online' : 'You are offline'}</Text><Text style={[styles.statusCopy, { color: colors.mutedForeground }]}>{runtime.isOnline ? 'Foreground service is keeping location and ride alerts active.' : 'Go online when you are ready for trips.'}</Text></View>
      <Switch testID="driver-online-toggle" value={runtime.isOnline} onValueChange={toggle} disabled={busy} trackColor={{ false: colors.muted, true: colors.primary }} thumbColor={colors.primaryForeground} /></View>
      {runtime.isOnline && <View style={[styles.serviceLine, { borderTopColor: colors.border }]}><Ionicons name="shield-checkmark-outline" size={17} color={colors.primary} /><Text style={[styles.serviceText, { color: colors.mutedForeground }]}>Background service active · {runtime.connection === 'connected' ? 'Connected' : 'Reconnecting…'}</Text></View>}
    </View>
    <View testID="driver-vehicle-category" style={[styles.vehicleCard, { backgroundColor: colors.secondary, borderColor: colors.border, borderRadius: colors.radius }]}>
      <Ionicons name="car-sport-outline" size={19} color={colors.primary} />
      <View style={{ flex: 1 }}><Text style={[styles.vehicleLabel, { color: colors.mutedForeground }]}>YOUR VEHICLE CATEGORY</Text><Text style={[styles.vehicleName, { color: colors.foreground }]}>{runtime.user.vehicleType || 'Vehicle category not set'}</Text></View>
    </View>
    {runtime.longRange && <View style={[styles.longRangeCard, { backgroundColor: colors.card, borderColor: runtime.longRange.settings?.enabled ? colors.border : colors.input, borderRadius: colors.radius + 12 }]}>
      <View style={styles.statusRow}><Ionicons name="map-outline" size={20} color={colors.primary} /><View style={{ flex: 1 }}><Text style={[styles.longRangeTitle, { color: colors.foreground }]}>Long Range Rides</Text><Text style={[styles.statusCopy, { color: colors.mutedForeground }]}>{runtime.longRange.settings?.enabled ? `Receive trips from ${Number(runtime.longRange.settings.distanceCutoffKm || 0).toLocaleString()} km+ · Wallet minimum Rs ${Number(runtime.longRange.settings.minimumWalletBalance || 0).toLocaleString()}` : 'Long Range rides are currently disabled by Admin.'}</Text></View><Switch testID="driver-long-range-toggle" value={runtime.longRange.enabled} onValueChange={toggleLongRange} disabled={busy || !runtime.longRange.settings?.enabled} trackColor={{ false: colors.muted, true: colors.primary }} thumbColor={colors.primaryForeground} /></View>
       {runtime.longRange.enabled && <View testID="long-range-responsibility-banner" style={[styles.longRangeReminder, { backgroundColor: colors.secondary, borderColor: colors.border }]}><Ionicons name="warning-outline" size={16} color={colors.primary} /><Text style={[styles.longRangeReminderText, { color: colors.secondaryForeground }]}>Reminder: Tolls, taxes, and challans are driver responsibility.</Text></View>}
    </View>}
    {runtime.pendingRide ? <View style={[styles.rideCard, { backgroundColor: colors.card, borderColor: colors.primary, borderRadius: colors.radius + 12 }]}>
      <View style={styles.rideHeader}><Text style={[styles.rideLabel, { color: colors.primary }]}>{runtime.pendingRide.isLongRange ? 'LONG RANGE RIDE' : 'NEW RIDE'}</Text><Text style={[styles.fare, { color: colors.foreground }]}>Rs {Number(runtime.pendingRide.fare).toLocaleString()}</Text></View>
      <Text style={[styles.location, { color: colors.foreground }]} numberOfLines={1}>{runtime.pendingRide.pickupLocation?.address || 'Pickup location shared'}</Text>
      <Text style={[styles.route, { color: colors.mutedForeground }]} numberOfLines={1}>To {runtime.pendingRide.dropoffLocation?.address || 'Drop-off location'} · {runtime.pendingRide.distance?.toFixed(1) || '—'} km</Text>
      <View style={styles.rideActions}><Pressable onPress={runtime.dismissRide} style={[styles.secondaryButton, { borderColor: colors.border, borderRadius: colors.radius }]}><Text style={{ color: colors.mutedForeground }}>Dismiss</Text></Pressable><Pressable testID="driver-accept-ride" onPress={() => void runtime.acceptRide()} style={[styles.acceptButton, { backgroundColor: colors.primary, borderRadius: colors.radius }]}><Text style={[styles.buttonText, { color: colors.primaryForeground }]}>Accept</Text></Pressable></View>
    </View> : <View style={[styles.waiting, { borderColor: colors.border, borderRadius: colors.radius + 12 }]}><Ionicons name={runtime.isOnline ? 'radio-outline' : 'power-outline'} size={32} color={onlineTone} /><Text style={[styles.waitingTitle, { color: colors.foreground }]}>{runtime.isOnline ? 'Waiting for rides' : 'Ready when you are'}</Text><Text style={[styles.waitingCopy, { color: colors.mutedForeground }]}>{runtime.isOnline ? 'Ride alerts will appear here and in your device notifications.' : 'Turn on availability to start receiving ride requests.'}</Text></View>}
    <View style={[styles.info, { backgroundColor: colors.secondary, borderRadius: colors.radius }]}><Ionicons name="information-circle-outline" size={18} color={colors.mutedForeground} /><Text style={[styles.infoText, { color: colors.secondaryForeground }]}>Keep location access set to “Allow all the time.” Android may also ask you to allow the My Ride foreground-service notification.</Text></View>
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
  statusCard: { borderWidth: 1, padding: 18 }, statusRow: { flexDirection: 'row', alignItems: 'center', gap: 12 }, statusDot: { width: 12, height: 12, borderRadius: 6 }, statusTitle: { fontFamily: 'Inter_700Bold', fontSize: 18 }, statusCopy: { fontFamily: 'Inter_400Regular', fontSize: 13, marginTop: 3, lineHeight: 19 },
  longRangeCard: { borderWidth: 1, padding: 16, marginTop: 12 }, longRangeTitle: { fontFamily: 'Inter_700Bold', fontSize: 15 }, longRangeReminder: { flexDirection: 'row', alignItems: 'flex-start', gap: 7, borderWidth: 1, padding: 10, marginTop: 14, borderRadius: 10 }, longRangeReminderText: { flex: 1, fontFamily: 'Inter_600SemiBold', fontSize: 12, lineHeight: 17 },
  serviceLine: { borderTopWidth: 1, flexDirection: 'row', gap: 8, alignItems: 'center', marginTop: 15, paddingTop: 14 }, serviceText: { fontFamily: 'Inter_500Medium', fontSize: 12 },
  vehicleCard: { marginTop: 12, borderWidth: 1, flexDirection: 'row', alignItems: 'center', gap: 10, padding: 13 }, vehicleLabel: { fontFamily: 'Inter_700Bold', fontSize: 10, letterSpacing: .8 }, vehicleName: { fontFamily: 'Inter_600SemiBold', fontSize: 14, marginTop: 2 },
  rideCard: { marginTop: 18, borderWidth: 1, padding: 18 }, rideHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' }, rideLabel: { fontFamily: 'Inter_700Bold', letterSpacing: 1.1, fontSize: 12 }, fare: { fontFamily: 'Inter_700Bold', fontSize: 23 },
  location: { fontFamily: 'Inter_600SemiBold', fontSize: 16, marginTop: 15 }, route: { fontFamily: 'Inter_400Regular', fontSize: 13, marginTop: 6 }, rideActions: { flexDirection: 'row', gap: 10, marginTop: 18 }, secondaryButton: { flex: 1, height: 46, borderWidth: 1, alignItems: 'center', justifyContent: 'center' }, acceptButton: { flex: 1, height: 46, alignItems: 'center', justifyContent: 'center' },
  waiting: { marginTop: 18, borderWidth: 1, borderStyle: 'dashed', padding: 30, alignItems: 'center' }, waitingTitle: { fontFamily: 'Inter_700Bold', fontSize: 18, marginTop: 12 }, waitingCopy: { fontFamily: 'Inter_400Regular', textAlign: 'center', fontSize: 13, lineHeight: 20, marginTop: 7 },
  info: { flexDirection: 'row', gap: 9, padding: 14, marginTop: 18, alignItems: 'flex-start' }, infoText: { flex: 1, fontFamily: 'Inter_400Regular', fontSize: 12, lineHeight: 18 }, error: { padding: 12, marginTop: 14 }, webNote: { textAlign: 'center', fontSize: 12, marginTop: 16 },
});