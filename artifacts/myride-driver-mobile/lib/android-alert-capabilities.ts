import * as IntentLauncher from 'expo-intent-launcher';
import * as Application from 'expo-application';
import { NativeModules, Platform } from 'react-native';

export type AndroidAlertCapabilities = {
  nativeBridgeAvailable: boolean;
  overlayPermissionGranted: boolean;
  batteryOptimizationExempt: boolean;
  fullScreenIntentAllowed: boolean;
};

type DriverAlertCapabilitiesModule = {
  getStatus(): Promise<Omit<AndroidAlertCapabilities, 'nativeBridgeAvailable'>>;
};

const nativeModule = NativeModules.DriverAlertCapabilities as DriverAlertCapabilitiesModule | undefined;

const unavailable: AndroidAlertCapabilities = {
  nativeBridgeAvailable: false,
  overlayPermissionGranted: false,
  batteryOptimizationExempt: false,
  fullScreenIntentAllowed: false,
};

export async function getAndroidAlertCapabilities(): Promise<AndroidAlertCapabilities> {
  if (Platform.OS !== 'android') {
    return {
      nativeBridgeAvailable: true,
      overlayPermissionGranted: true,
      batteryOptimizationExempt: true,
      fullScreenIntentAllowed: true,
    };
  }
  if (!nativeModule) return unavailable;
  try {
    return { nativeBridgeAvailable: true, ...(await nativeModule.getStatus()) };
  } catch {
    return unavailable;
  }
}

export type AndroidAlertSetting = 'overlay' | 'battery' | 'full-screen';

export async function openAndroidAlertSetting(setting: AndroidAlertSetting) {
  if (Platform.OS !== 'android') return;
  const packageName = Application.applicationId;
  const actions: Record<AndroidAlertSetting, string> = {
    overlay: 'android.settings.action.MANAGE_OVERLAY_PERMISSION',
    battery: 'android.settings.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS',
    'full-screen': 'android.settings.MANAGE_APP_USE_FULL_SCREEN_INTENT',
  };
  try {
    await IntentLauncher.startActivityAsync(actions[setting] as IntentLauncher.ActivityAction, {
      data: `package:${packageName}`,
    });
  } catch {
    await IntentLauncher.startActivityAsync(
      IntentLauncher.ActivityAction.APPLICATION_DETAILS_SETTINGS,
      { data: `package:${packageName}` },
    );
  }
}