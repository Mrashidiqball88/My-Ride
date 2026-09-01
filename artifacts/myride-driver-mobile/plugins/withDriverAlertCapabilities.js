const fs = require('node:fs');
const path = require('node:path');
const { withAndroidManifest, withDangerousMod, withMainApplication } = require('@expo/config-plugins');

const JAVA_PACKAGE = 'com.myride.driver';
const JAVA_PATH = JAVA_PACKAGE.replace(/\./g, '/');

const moduleSource = `package ${JAVA_PACKAGE};

import android.app.NotificationManager;
import android.content.Context;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;

import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.WritableMap;

public class DriverAlertCapabilitiesModule extends ReactContextBaseJavaModule {
  public static final String NAME = "DriverAlertCapabilities";

  public DriverAlertCapabilitiesModule(ReactApplicationContext reactContext) {
    super(reactContext);
  }

  @Override
  public String getName() {
    return NAME;
  }

  @ReactMethod
  public void getStatus(Promise promise) {
    try {
      Context context = getReactApplicationContext();
      WritableMap status = Arguments.createMap();
      status.putBoolean("overlayPermissionGranted", canDrawOverlays(context));
      status.putBoolean("batteryOptimizationExempt", isIgnoringBatteryOptimizations(context));
      status.putBoolean("fullScreenIntentAllowed", canUseFullScreenIntent(context));
      promise.resolve(status);
    } catch (Exception error) {
      promise.reject("DRIVER_ALERT_CAPABILITIES_UNAVAILABLE", error);
    }
  }

  private boolean canDrawOverlays(Context context) {
    return Build.VERSION.SDK_INT < Build.VERSION_CODES.M
      || Settings.canDrawOverlays(context);
  }

  private boolean isIgnoringBatteryOptimizations(Context context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true;
    PowerManager powerManager = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
    return powerManager != null && powerManager.isIgnoringBatteryOptimizations(context.getPackageName());
  }

  private boolean canUseFullScreenIntent(Context context) {
    if (Build.VERSION.SDK_INT < 34) return true;
    NotificationManager notificationManager =
      (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
    return notificationManager != null && notificationManager.canUseFullScreenIntent();
  }
}
`;

const packageSource = `package ${JAVA_PACKAGE};

import com.facebook.react.ReactPackage;
import com.facebook.react.bridge.NativeModule;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.uimanager.ViewManager;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

public class DriverAlertCapabilitiesPackage implements ReactPackage {
  @Override
  public List<NativeModule> createNativeModules(ReactApplicationContext reactContext) {
    List<NativeModule> modules = new ArrayList<>();
    modules.add(new DriverAlertCapabilitiesModule(reactContext));
    return modules;
  }

  @Override
  public List<ViewManager> createViewManagers(ReactApplicationContext reactContext) {
    return Collections.emptyList();
  }
}
`;

function withDriverNativeFiles(config) {
  return withDangerousMod(config, ['android', async (config) => {
    const javaDirectory = path.join(
      config.modRequest.platformProjectRoot,
      'app',
      'src',
      'main',
      'java',
      JAVA_PATH,
    );
    fs.mkdirSync(javaDirectory, { recursive: true });
    fs.writeFileSync(path.join(javaDirectory, 'DriverAlertCapabilitiesModule.java'), moduleSource);
    fs.writeFileSync(path.join(javaDirectory, 'DriverAlertCapabilitiesPackage.java'), packageSource);
    return config;
  }]);
}

function withDriverMainApplication(config) {
  return withMainApplication(config, (config) => {
    const { language, contents } = config.modResults;
    if (language !== 'kt') {
      throw new Error('My Ride Driver alert capabilities require the Kotlin Expo Android template.');
    }
    const importMarker = 'import expo.modules.ApplicationLifecycleDispatcher';
    const packageImport = `import ${JAVA_PACKAGE}.DriverAlertCapabilitiesPackage`;
    const nextContents = contents.includes(packageImport)
      ? contents
      : contents.replace(importMarker, `${importMarker}\n${packageImport}`);
    const modernPackagesMarker = 'PackageList(this).packages.apply {';
    const legacyPackagesMarker = 'val packages = PackageList(this).packages';
    if (!nextContents.includes(modernPackagesMarker) && !nextContents.includes(legacyPackagesMarker)) {
      throw new Error('Could not register DriverAlertCapabilitiesPackage in MainApplication.kt.');
    }
    const registeredContents = nextContents.includes('DriverAlertCapabilitiesPackage()')
      ? nextContents
      : nextContents.includes(modernPackagesMarker)
        ? nextContents.replace(
          modernPackagesMarker,
          `${modernPackagesMarker}\n              add(DriverAlertCapabilitiesPackage())`,
        )
        : nextContents.replace(
          legacyPackagesMarker,
          `${legacyPackagesMarker}\n          packages.add(DriverAlertCapabilitiesPackage())`,
        );
    return {
      ...config,
      modResults: {
        ...config.modResults,
        contents: registeredContents,
      },
    };
  });
}

function withDriverAlertCapabilities(config) {
  config = withAndroidManifest(config, (config) => {
    const permissions = config.modResults.manifest['uses-permission'] || [];
    for (const name of ['android.permission.SYSTEM_ALERT_WINDOW', 'android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS']) {
      if (!permissions.some(permission => permission.$?.['android:name'] === name)) {
        permissions.push({ $: { 'android:name': name } });
      }
    }
    config.modResults.manifest['uses-permission'] = permissions;
    return config;
  });
  config = withDriverNativeFiles(config);
  return withDriverMainApplication(config);
}

module.exports = withDriverAlertCapabilities;