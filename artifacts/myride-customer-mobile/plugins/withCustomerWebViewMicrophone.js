const fs = require('node:fs');
const path = require('node:path');
const {
  withAndroidManifest,
  withDangerousMod,
} = require('@expo/config-plugins');

const WEBVIEW_ANDROID_SOURCE = path.join(
  'node_modules',
  'react-native-webview',
  'android',
  'src',
  'main',
  'java',
  'com',
  'reactnativecommunity',
  'webview',
);
const MANAGER_FILE = 'RNCWebViewManagerImpl.kt';
const CHROME_CLIENT_FILE = 'CustomerWebChromeClient.java';

const chromeClientSource = `package com.reactnativecommunity.webview;

import android.Manifest;
import android.content.pm.PackageManager;
import android.webkit.PermissionRequest;

import androidx.core.content.ContextCompat;

/**
 * Keeps microphone permission handling explicit for the Customer WebView.
 *
 * React Native WebView still owns the normal file chooser, fullscreen, and
 * geolocation behavior through RNCWebChromeClient. This subclass only makes
 * the already-granted audio path deterministic; denied audio permissions are
 * delegated to the library's runtime permission flow.
 */
public class CustomerWebChromeClient extends RNCWebChromeClient {
    public CustomerWebChromeClient(RNCWebView webView) {
        super(webView);
    }

    @Override
    public void onPermissionRequest(final PermissionRequest request) {
        boolean audioRequested = false;
        boolean unsupportedResourceRequested = false;
        for (String resource : request.getResources()) {
            if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) {
                audioRequested = true;
            } else {
                unsupportedResourceRequested = true;
            }
        }

        if (audioRequested && !unsupportedResourceRequested
                && ContextCompat.checkSelfPermission(
                    mWebView.getThemedReactContext(),
                    Manifest.permission.RECORD_AUDIO
                ) == PackageManager.PERMISSION_GRANTED) {
            request.grant(new String[] { PermissionRequest.RESOURCE_AUDIO_CAPTURE });
            return;
        }

        // RNCWebChromeClient requests RECORD_AUDIO at runtime when needed and
        // grants the WebView resource only after Android allows it.
        super.onPermissionRequest(request);
    }
}
`;

function withMicrophoneManifest(config) {
  return withAndroidManifest(config, config => {
    const permissions = config.modResults.manifest['uses-permission'] || [];
    const permissionName = 'android.permission.RECORD_AUDIO';
    if (!permissions.some(permission => permission.$?.['android:name'] === permissionName)) {
      permissions.push({ $: { 'android:name': permissionName } });
    }
    config.modResults.manifest['uses-permission'] = permissions;
    return config;
  });
}

function withCustomerWebChromeClient(config) {
  return withDangerousMod(config, ['android', async config => {
    const sourceDirectory = path.join(config.modRequest.projectRoot, WEBVIEW_ANDROID_SOURCE);
    const managerPath = path.join(sourceDirectory, MANAGER_FILE);
    const chromeClientPath = path.join(sourceDirectory, CHROME_CLIENT_FILE);

    if (!fs.existsSync(managerPath)) {
      throw new Error(`Customer microphone setup could not find ${managerPath}`);
    }

    let managerSource = fs.readFileSync(managerPath, 'utf8');
    const defaultClient = 'object : RNCWebChromeClient(webView) {';
    const customerClient = 'object : CustomerWebChromeClient(webView) {';
    if (!managerSource.includes(customerClient)) {
      const occurrences = managerSource.split(defaultClient).length - 1;
      if (occurrences !== 2) {
        throw new Error(
          `Customer microphone setup expected two RNCWebChromeClient factories, found ${occurrences}.`,
        );
      }
      managerSource = managerSource.split(defaultClient).join(customerClient);
      fs.writeFileSync(managerPath, managerSource);
    }
    fs.writeFileSync(chromeClientPath, chromeClientSource);
    return config;
  }]);
}

module.exports = config => withCustomerWebChromeClient(withMicrophoneManifest(config));