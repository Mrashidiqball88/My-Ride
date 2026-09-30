package com.myride.wrapper;

import android.Manifest;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.provider.MediaStore;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.GeolocationPermissions;
import android.webkit.MimeTypeMap;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import androidx.core.content.FileProvider;

import java.io.File;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;

public final class MainActivity extends Activity {
    private static final int LOCATION_PERMISSION_REQUEST = 7001;
    private static final int FILE_CHOOSER_REQUEST = 7002;
    private static final int CAMERA_PERMISSION_REQUEST = 7003;
    private static final int CAMERA_CAPTURE_REQUEST = 7004;
    private static final String PRODUCTION_HOST = "myride.duckdns.org";

    private WebView webView;
    private GeolocationPermissions.Callback pendingLocationCallback;
    private String pendingLocationOrigin;
    private ValueCallback<Uri[]> pendingFileCallback;
    private FileChooserPolicy pendingFilePolicy;
    private File pendingCameraFile;
    private Uri pendingCameraUri;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        pruneOldCameraFiles();

        webView = new WebView(this);
        webView.setLayoutParams(new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
        ));
        configureWebView(webView);
        setContentView(webView);

        if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState);
        } else {
            webView.loadUrl(getString(R.string.production_url));
        }
    }

    private void configureWebView(WebView view) {
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setGeolocationEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setSupportMultipleWindows(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
            settings.setSafeBrowsingEnabled(true);
        }

        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(view, true);

        view.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView webView, WebResourceRequest request) {
                return !isAllowedProductionUrl(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView webView, String url) {
                return !isAllowedProductionUrl(Uri.parse(url));
            }

            @Override
            public void onReceivedError(
                    WebView view,
                    WebResourceRequest request,
                    WebResourceError error
            ) {
                if (request.isForMainFrame()) {
                    Toast.makeText(
                            MainActivity.this,
                            "Unable to load My Ride. Check your internet connection.",
                            Toast.LENGTH_LONG
                    ).show();
                }
            }
        });

        view.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onGeolocationPermissionsShowPrompt(
                    String origin,
                    GeolocationPermissions.Callback callback
            ) {
                if (!isAllowedProductionUrl(Uri.parse(origin))) {
                    callback.invoke(origin, false, false);
                    return;
                }

                if (hasLocationPermission()) {
                    callback.invoke(origin, true, false);
                    return;
                }

                pendingLocationOrigin = origin;
                pendingLocationCallback = callback;
                requestPermissions(
                        new String[]{
                                Manifest.permission.ACCESS_FINE_LOCATION,
                                Manifest.permission.ACCESS_COARSE_LOCATION
                        },
                        LOCATION_PERMISSION_REQUEST
                );
            }

            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                // The remote app only receives location through the WebView geolocation
                // API. Do not grant arbitrary WebView-originated resources.
                request.deny();
            }

            @Override
            public boolean onShowFileChooser(
                    WebView webView,
                    ValueCallback<Uri[]> filePathCallback,
                    FileChooserParams fileChooserParams
            ) {
                // Do not replace an in-flight request: its eventual result/permission
                // response must never be delivered to a different HTML input.
                if (pendingFileCallback != null) {
                    filePathCallback.onReceiveValue(null);
                    return true;
                }
                pendingFileCallback = filePathCallback;
                pendingFilePolicy = new FileChooserPolicy(
                        fileChooserParams.getAcceptTypes(),
                        fileChooserParams.isCaptureEnabled(),
                        fileChooserParams.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE,
                        extension -> MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension)
                );
                if (pendingFilePolicy.captureImage) {
                    if (checkSelfPermission(Manifest.permission.CAMERA)
                            == PackageManager.PERMISSION_GRANTED) {
                        launchCamera();
                    } else {
                        requestPermissions(new String[]{Manifest.permission.CAMERA},
                                CAMERA_PERMISSION_REQUEST);
                    }
                } else {
                    launchGallery();
                }
                return true;
            }
        });
    }

    private void launchGallery() {
        Intent chooser = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        chooser.addCategory(Intent.CATEGORY_OPENABLE);
        chooser.setType(pendingFilePolicy.pickerType);
        chooser.putExtra(Intent.EXTRA_MIME_TYPES, pendingFilePolicy.mimeTypes);
        chooser.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, pendingFilePolicy.allowMultiple);
        try {
            startActivityForResult(chooser, FILE_CHOOSER_REQUEST);
        } catch (ActivityNotFoundException | SecurityException error) {
            failFileChooser("No file picker is available on this device.");
        }
    }

    private void launchCamera() {
        try {
            File directory = new File(getCacheDir(), "camera");
            if (!directory.exists() && !directory.mkdirs()) {
                throw new IOException("Unable to create camera cache");
            }
            pendingCameraFile = File.createTempFile("capture-", ".jpg", directory);
            pendingCameraUri = FileProvider.getUriForFile(
                    this, getPackageName() + ".fileprovider", pendingCameraFile);
            Intent camera = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
            camera.putExtra(MediaStore.EXTRA_OUTPUT, pendingCameraUri);
            camera.setClipData(ClipData.newRawUri("Camera output", pendingCameraUri));
            camera.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                    | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            // EXTRA_OUTPUT, not the result Intent thumbnail, is the full-resolution image.
            startActivityForResult(camera, CAMERA_CAPTURE_REQUEST);
        } catch (ActivityNotFoundException error) {
            failFileChooser("No camera app is available on this device.");
        } catch (IOException | SecurityException | IllegalArgumentException error) {
            failFileChooser("Unable to open the camera. Please try again.");
        }
    }

    private void failFileChooser(String message) {
        completeFileChooser(null);
        Toast.makeText(this, message, Toast.LENGTH_LONG).show();
    }

    private void completeFileChooser(Uri[] results) {
        ValueCallback<Uri[]> callback = pendingFileCallback;
        pendingFileCallback = null;
        pendingFilePolicy = null;
        if (pendingCameraUri != null) {
            revokeUriPermission(pendingCameraUri, Intent.FLAG_GRANT_READ_URI_PERMISSION
                    | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        }
        // A successful output must stay available for the WebView's asynchronous upload.
        if (results == null && pendingCameraFile != null) {
            pendingCameraFile.delete();
        }
        pendingCameraUri = null;
        pendingCameraFile = null;
        if (callback != null) {
            callback.onReceiveValue(results);
        }
    }

    private void pruneOldCameraFiles() {
        File[] files = new File(getCacheDir(), "camera").listFiles();
        if (files == null) {
            return;
        }
        long cutoff = System.currentTimeMillis() - 24L * 60 * 60 * 1000;
        for (File file : files) {
            if (file.getName().startsWith("capture-") && file.lastModified() < cutoff) {
                file.delete();
            }
        }
    }

    private boolean isAllowedProductionUrl(Uri uri) {
        if (uri == null || !"https".equalsIgnoreCase(uri.getScheme())) {
            return false;
        }
        return PRODUCTION_HOST.equalsIgnoreCase(uri.getHost());
    }

    private boolean hasLocationPermission() {
        return checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION)
                == PackageManager.PERMISSION_GRANTED
                || checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION)
                == PackageManager.PERMISSION_GRANTED;
    }

    @Override
    public void onRequestPermissionsResult(
            int requestCode,
            String[] permissions,
            int[] grantResults
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == CAMERA_PERMISSION_REQUEST) {
            if (pendingFileCallback == null || pendingFilePolicy == null
                    || !pendingFilePolicy.captureImage) {
                return;
            }
            if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED
                    && checkSelfPermission(Manifest.permission.CAMERA)
                    == PackageManager.PERMISSION_GRANTED) {
                launchCamera();
            } else {
                // Denial (including dismissed / permanently denied prompts) is cancellation,
                // never a gallery fallback for an explicit camera input.
                failFileChooser("Camera permission is needed to take a photo.");
            }
            return;
        }
        if (requestCode != LOCATION_PERMISSION_REQUEST) {
            return;
        }

        boolean granted = hasLocationPermission();
        if (pendingLocationCallback != null && pendingLocationOrigin != null) {
            pendingLocationCallback.invoke(pendingLocationOrigin, granted, false);
        }
        pendingLocationCallback = null;
        pendingLocationOrigin = null;

        if (!granted) {
            Toast.makeText(
                    this,
                    "Location permission is needed for live ride tracking.",
                    Toast.LENGTH_LONG
            ).show();
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == CAMERA_CAPTURE_REQUEST) {
            if (pendingFileCallback == null) {
                return;
            }
            if (resultCode == RESULT_OK && pendingCameraUri != null
                    && pendingCameraFile != null && pendingCameraFile.length() > 0) {
                completeFileChooser(new Uri[]{pendingCameraUri});
            } else if (resultCode == RESULT_OK) {
                failFileChooser("The camera did not save a photo. Please try again.");
            } else {
                completeFileChooser(null);
            }
            return;
        }
        if (requestCode != FILE_CHOOSER_REQUEST || pendingFileCallback == null) {
            return;
        }

        List<Uri> selected = new ArrayList<>();
        if (resultCode == RESULT_OK && data != null) {
            if (data.getClipData() != null) {
                int count = pendingFilePolicy.allowMultiple
                        ? data.getClipData().getItemCount()
                        : Math.min(1, data.getClipData().getItemCount());
                for (int i = 0; i < count; i++) {
                    Uri uri = data.getClipData().getItemAt(i).getUri();
                    if (uri != null && "content".equals(uri.getScheme())) {
                        selected.add(uri);
                    }
                }
            } else if (data.getData() != null && "content".equals(data.getData().getScheme())) {
                selected.add(data.getData());
            }
        }
        completeFileChooser(selected.isEmpty() ? null : selected.toArray(new Uri[0]));
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        if (webView != null) {
            webView.saveState(outState);
        }
        super.onSaveInstanceState(outState);
    }

    @Override
    protected void onDestroy() {
        completeFileChooser(null);
        if (webView != null) {
            webView.stopLoading();
            webView.setWebChromeClient(null);
            webView.setWebViewClient(null);
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}