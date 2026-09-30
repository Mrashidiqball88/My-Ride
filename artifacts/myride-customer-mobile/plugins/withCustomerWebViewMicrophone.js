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
const BASE_CHROME_CLIENT_FILE = 'RNCWebChromeClient.java';

const chromeClientSource = `package com.reactnativecommunity.webview;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebView;

import androidx.core.content.ContextCompat;

/**
 * Keeps microphone and document-capture permissions explicit for Customer.
 *
 * RNCWebView owns file selection and camera intents. Its 13.15.0 file chooser
 * checks CAMERA but never requests it (unlike getUserMedia). Capture inputs
 * must wait for a file-owned transaction serialized with WebChromeClient's
 * existing media/geolocation transactions. File results never answer a
 * queued getUserMedia PermissionRequest.
 */
public class CustomerWebChromeClient extends RNCWebChromeClient {
    private WebView pendingCaptureView;
    private ValueCallback<Uri[]> pendingCaptureCallback;
    private FileChooserParams pendingCaptureParams;

    public CustomerWebChromeClient(RNCWebView webView) {
        super(webView);
    }

    @Override
    public boolean onShowFileChooser(WebView webView, ValueCallback<Uri[]> callback,
                                     FileChooserParams params) {
        if (!params.isCaptureEnabled()
                || ContextCompat.checkSelfPermission(
                    mWebView.getThemedReactContext(), Manifest.permission.CAMERA
                ) == PackageManager.PERMISSION_GRANTED) {
            return super.onShowFileChooser(webView, callback, params);
        }

        Activity activity = mWebView.getThemedReactContext().getCurrentActivity();
        if (activity == null) {
            callback.onReceiveValue(null);
            return true;
        }
        // A newer request replaces the older one; every callback is settled.
        boolean alreadyWaiting = pendingCaptureCallback != null;
        if (alreadyWaiting) pendingCaptureCallback.onReceiveValue(null);
        pendingCaptureView = webView;
        pendingCaptureCallback = callback;
        pendingCaptureParams = params;
        if (!alreadyWaiting) {
            requestCapturePermission();
        }
        return true;
    }

    @Override
    protected void onCameraPermissionResult(boolean granted) {
        if (pendingCaptureCallback == null) return;
        WebView view = pendingCaptureView;
        ValueCallback<Uri[]> callback = pendingCaptureCallback;
        FileChooserParams params = pendingCaptureParams;
        pendingCaptureView = null;
        pendingCaptureCallback = null;
        pendingCaptureParams = null;
        Activity activity = mWebView.getThemedReactContext().getCurrentActivity();
        if (granted && activity != null) {
            // Preserve accept types, multiplicity and capture. Do not substitute
            // a gallery intent or turn a URI into a custom JS upload.
            super.onShowFileChooser(view, callback, params);
            return;
        }
        callback.onReceiveValue(null);
        if (activity != null && !activity.isFinishing() && !activity.isDestroyed()) {
            new AlertDialog.Builder(activity)
                .setTitle("Camera permission required")
                .setMessage("Allow Camera in My Ride app settings to take a photo, or choose Gallery on the verification form.")
                .setNegativeButton("Cancel", null)
                .setPositiveButton("Settings", (dialog, which) -> {
                    Intent intent = new Intent(
                        android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                        Uri.parse("package:" + activity.getPackageName())
                    );
                    activity.startActivity(intent);
                })
                .show();
        }
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

// Separate callback ownership is essential: routing file CAMERA through the
// stock media listener can grant a queued microphone request before its own
// Android permission result arrives.
const capturePermissionQueueSource = `    // MY_RIDE_CAPTURE_QUEUE_V2
    private boolean capturePermissionPending = false;

    protected void onCameraPermissionResult(boolean granted) {}

    protected synchronized void requestCapturePermission() {
        capturePermissionPending = true;
        if (permissionsRequestShown) return;
        capturePermissionPending = false;
        permissionsRequestShown = true;
        try {
            getPermissionAwareActivity().requestPermissions(
                new String[] { Manifest.permission.CAMERA },
                7401,
                capturePermissionsListener
            );
        } catch (RuntimeException error) {
            permissionsRequestShown = false;
            onCameraPermissionResult(false);
        }
    }

    private boolean drainCapturePermissionQueue() {
        if (!pendingPermissions.isEmpty()) {
            requestPermissions(pendingPermissions);
            return false;
        }
        if (capturePermissionPending) {
            requestCapturePermission();
            return false;
        }
        return true;
    }

    private final PermissionListener capturePermissionsListener = (requestCode, permissions, grantResults) -> {
        permissionsRequestShown = false;
        boolean granted = false;
        // Empty/mismatched arrays mean cancellation, not an indefinitely
        // pending camera callback. Never touch media/geolocation fields here.
        for (int i = 0; i < permissions.length && i < grantResults.length; i++) {
            if (Manifest.permission.CAMERA.equals(permissions[i])) {
                granted = grantResults[i] == PackageManager.PERMISSION_GRANTED;
            }
        }
        boolean drained;
        try {
            onCameraPermissionResult(granted);
        } finally {
            drained = drainCapturePermissionQueue();
        }
        return drained;
    };

`;

const chooserFailureSource = `    // MY_RIDE_CHOOSER_SETTLEMENT_V2
    private boolean failFileChooser(Activity activity) {
        ValueCallback<Uri[]> callback = mFilePathCallback;
        mFilePathCallback = null;
        if (mOutputImage != null) mOutputImage.delete();
        if (mOutputVideo != null) mOutputVideo.delete();
        mOutputImage = null;
        mOutputVideo = null;
        if (callback != null) callback.onReceiveValue(null);
        if (activity != null) {
            Toast.makeText(activity,
                "Camera or file picker unavailable. Try Gallery or check device camera access.",
                Toast.LENGTH_LONG).show();
        }
        return true;
    }

`;

function replaceOnce(source, oldText, newText, description) {
  if (source.split(oldText).length !== 2) {
    throw new Error(`Customer camera permission patch: ${description} changed; reinstall dependencies and review before building.`);
  }
  return source.replace(oldText, newText);
}

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
    const baseChromeClientPath = path.join(sourceDirectory, BASE_CHROME_CLIENT_FILE);
    const modulePath = path.join(sourceDirectory, 'RNCWebViewModuleImpl.java');
    const packagePath = path.join(config.modRequest.projectRoot, 'node_modules', 'react-native-webview', 'package.json');
    const version = JSON.parse(fs.readFileSync(packagePath, 'utf8')).version;
    if (version !== '13.15.0') {
      throw new Error(`Customer camera permission patch requires reviewed react-native-webview 13.15.0, found ${version}.`);
    }

    if (!fs.existsSync(managerPath)) {
      throw new Error(`Customer microphone setup could not find ${managerPath}`);
    }

    let managerSource = fs.readFileSync(managerPath, 'utf8');
    let baseChromeSource = fs.readFileSync(baseChromeClientPath, 'utf8');
    let moduleSource = fs.readFileSync(modulePath, 'utf8');
    // Reuse RNC's serialization, but never its media callback for file CAMERA.
    const privateRequest = 'private synchronized void requestPermissions(List<String> permissions) {';
    const protectedRequest = 'protected synchronized void requestPermissions(List<String> permissions) {';
    const cameraBranch = 'if (permission.equals(Manifest.permission.CAMERA)) {';
    const hookedCameraBranch = `${cameraBranch}\n                onCameraPermissionResult(granted);`;
    // Upgrade the previous patch in-place during prebuild; never retain its
    // camera -> getUserMedia callback ownership bug.
    if (baseChromeSource.includes(protectedRequest)) {
      baseChromeSource = replaceOnce(baseChromeSource,
        `protected void onCameraPermissionResult(boolean granted) {}\n\n    ${protectedRequest}`,
        privateRequest, 'previous permission hook');
      baseChromeSource = replaceOnce(baseChromeSource, hookedCameraBranch, cameraBranch, 'previous camera branch');
    }
    const stockQueueTail = `        if (!pendingPermissions.isEmpty()) {
            requestPermissions(pendingPermissions);
            return false;
        }

        return true;
    };`;
    if (!baseChromeSource.includes('// MY_RIDE_CAPTURE_QUEUE_V2')) {
      baseChromeSource = replaceOnce(baseChromeSource, `    ${privateRequest}`,
        capturePermissionQueueSource + `    ${privateRequest}`, 'permission request method');
      baseChromeSource = replaceOnce(baseChromeSource, stockQueueTail,
        '        return drainCapturePermissionQueue();\n    };', 'stock listener queue tail');
    } else if (!baseChromeSource.includes(capturePermissionQueueSource)
        || baseChromeSource.includes(hookedCameraBranch)
        || baseChromeSource.includes(stockQueueTail)
        || baseChromeSource.split('return drainCapturePermissionQueue();').length !== 2) {
      throw new Error('Customer camera permission patch: partially patched capture queue; reinstall dependencies before building.');
    }

    const chooserSignature = '    public boolean startPhotoPickerIntent(final String[] acceptTypes, final boolean allowMultiple, final ValueCallback<Uri[]> callback, final boolean isCaptureEnabled) {';
    const nextMethod = '    public void setDownloadRequest(DownloadManager.Request request) {';
    if (!moduleSource.includes('// MY_RIDE_CHOOSER_SETTLEMENT_V2')) {
      const chooserStart = moduleSource.indexOf(chooserSignature);
      const chooserEnd = moduleSource.indexOf(nextMethod, chooserStart);
      if (chooserStart < 0 || chooserEnd < 0) {
        throw new Error('Customer camera permission patch: stock chooser method changed; review before building.');
      }
      let chooser = moduleSource.slice(chooserStart, chooserEnd);
      chooser = replaceOnce(chooser, '        ArrayList<Parcelable> extraIntents = new ArrayList<>();',
        `        if (activity == null) return failFileChooser(null);
        try {
        ArrayList<Parcelable> extraIntents = new ArrayList<>();`, 'chooser activity guard');
      chooser = replaceOnce(chooser, '                Log.w("RNCWebViewModule", "there is no Activity to handle this Intent");',
        '                return failFileChooser(activity);', 'chooser resolve failure');
      chooser = replaceOnce(chooser, '            Log.w("RNCWebViewModule", "there is no Camera permission");',
        '            return failFileChooser(activity);', 'chooser output failure');
      chooser = replaceOnce(chooser, '        return true;\n    }',
        `        return true;
        } catch (RuntimeException error) {
            Log.w("RNCWebViewModule", "Unable to launch file chooser", error);
            return failFileChooser(activity);
        }
    }`, 'chooser launch exception guard');
      moduleSource = moduleSource.slice(0, chooserStart) + chooserFailureSource + chooser + moduleSource.slice(chooserEnd);
    } else if (!moduleSource.includes(chooserFailureSource)
        || !moduleSource.includes('if (activity == null) return failFileChooser(null);')
        || !moduleSource.includes('return failFileChooser(activity);')) {
      throw new Error('Customer camera permission patch: partially patched chooser; reinstall dependencies before building.');
    }
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
    fs.writeFileSync(baseChromeClientPath, baseChromeSource);
    fs.writeFileSync(modulePath, moduleSource);
    fs.writeFileSync(chromeClientPath, chromeClientSource);
    return config;
  }]);
}

module.exports = config => withCustomerWebChromeClient(withMicrophoneManifest(config));