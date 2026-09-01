import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

// Channel settings are immutable after Android creates a channel. Versioning
// this ID is required so a previously demoted channel cannot stay silent.
export const RIDE_ALERT_CHANNEL_ID = 'ride-alerts-critical-v2';
export const RIDE_ALERT_CATEGORY_ID = 'ride-request';

export type NativeRideAlert = {
  id?: string;
  _id?: string;
  fare?: number;
  distance?: number;
  pickupLocation?: { address?: string };
  dropoffLocation?: { address?: string };
  dropoffLocations?: Array<{ address?: string }>;
  broadcastExpiresAt?: string | Date;
  [key: string]: unknown;
};

export function rideAlertId(ride: NativeRideAlert | null | undefined) {
  return String(ride?.id || ride?._id || '');
}

export async function ensureRideAlertChannel() {
  if (Platform.OS !== 'android') return null;
  return Notifications.setNotificationChannelAsync(RIDE_ALERT_CHANNEL_ID, {
    name: 'Ride requests',
    description: 'Urgent ride requests for Drivers who are online.',
    importance: Notifications.AndroidImportance.MAX,
    bypassDnd: false,
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
    sound: 'default',
    vibrationPattern: [0, 450, 180, 450, 180, 450],
    enableVibrate: true,
    enableLights: true,
    lightColor: '#38BDF8',
    showBadge: true,
    audioAttributes: {
      usage: Notifications.AndroidAudioUsage.NOTIFICATION_RINGTONE,
      contentType: Notifications.AndroidAudioContentType.SONIFICATION,
      flags: { enforceAudibility: true, requestHardwareAudioVideoSynchronization: false },
    },
  });
}

export function nativeRideAlertContent(ride: NativeRideAlert) {
  const pickup = ride.pickupLocation?.address || 'Nearby pickup';
  const fare = Number(ride.fare || 0).toLocaleString();
  const distance = ride.distance ? ` · ${Number(ride.distance).toFixed(1)} km` : '';
  return {
    title: 'New ride request',
    body: `${pickup} · Rs ${fare}${distance}`,
    sound: 'default' as const,
    vibrate: [0, 450, 180, 450, 180, 450],
    priority: Notifications.AndroidNotificationPriority.MAX,
    channelId: RIDE_ALERT_CHANNEL_ID,
    categoryIdentifier: RIDE_ALERT_CATEGORY_ID,
    sticky: true,
    autoDismiss: false,
    interruptionLevel: 'timeSensitive' as const,
    data: {
      type: 'ride:new',
      ride,
      rideId: rideAlertId(ride),
    },
  };
}

export async function scheduleNativeRideAlert(ride: NativeRideAlert) {
  await ensureRideAlertChannel();
  return Notifications.scheduleNotificationAsync({
    content: nativeRideAlertContent(ride),
    trigger: null,
  });
}