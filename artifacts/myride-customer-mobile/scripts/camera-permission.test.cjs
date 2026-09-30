const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');

// Run prebuild mods on isolated installed-source copies, never node_modules.
const appRoot = path.resolve(__dirname, '..');
const webviewRoot = path.join(appRoot, 'node_modules/react-native-webview');
const nativeRelative = 'android/src/main/java/com/reactnativecommunity/webview';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'customer-camera-test-'));
const project = path.join(tmp, 'project');
const fixtureRoot = path.join(project, 'node_modules/react-native-webview');
const nativeRoot = path.join(fixtureRoot, nativeRelative);
function write(root, filename, content) {
  const target = path.join(root, filename);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}
function between(source, start, end) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first);
  assert(first >= 0 && last > first, `Native test extraction failed: ${start}`);
  return source.slice(first, last);
}

async function main() {
  assert.equal(JSON.parse(fs.readFileSync(path.join(webviewRoot, 'package.json'))).version, '13.15.0');
  const moduleSource = fs.readFileSync(path.join(webviewRoot, nativeRelative, 'RNCWebViewModuleImpl.java'), 'utf8');
  assert.match(moduleSource, /if \(!needsCameraPermission\(\)\) \{/);
  assert.match(moduleSource, /if \(isCaptureEnabled\) \{\s*chooserIntent = photoIntent;/);
  for (const filename of ['RNCWebViewManagerImpl.kt', 'RNCWebChromeClient.java', 'RNCWebViewModuleImpl.java']) {
    write(nativeRoot, filename, fs.readFileSync(path.join(webviewRoot, nativeRelative, filename)));
  }
  write(fixtureRoot, 'package.json', JSON.stringify({ version: '13.15.0' }));
  let manifestMod;
  let androidMod;
  const scope = {
    module: { exports: {} },
    require(name) {
      if (name === '@expo/config-plugins') return {
        withAndroidManifest(config, mod) { manifestMod = mod; return config; },
        withDangerousMod(config, [, mod]) { androidMod = mod; return config; },
      };
      return require(name);
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(appRoot, 'plugins/withCustomerWebViewMicrophone.js'), 'utf8'), scope);
  scope.module.exports({});
  const manifest = { modResults: { manifest: {} } };
  manifestMod(manifest);
  manifestMod(manifest);
  assert.equal(manifest.modResults.manifest['uses-permission'].length, 1);
  const config = { modRequest: { projectRoot: project } };
  await androidMod(config);
  const patchedBase = fs.readFileSync(path.join(nativeRoot, 'RNCWebChromeClient.java'), 'utf8');
  const patchedModule = fs.readFileSync(path.join(nativeRoot, 'RNCWebViewModuleImpl.java'), 'utf8');
  const manager = fs.readFileSync(path.join(nativeRoot, 'RNCWebViewManagerImpl.kt'), 'utf8');
  assert.equal(manager.split('object : CustomerWebChromeClient(webView) {').length, 3);
  assert.equal(patchedBase.split('onCameraPermissionResult(granted);').length, 2);
  const fileListener = between(patchedBase, 'private final PermissionListener capturePermissionsListener', '    private synchronized void requestPermissions');
  assert.doesNotMatch(fileListener, /permissionRequest\.grant|grantedPermissions|shouldAnswerToPermissionRequest/);
  await androidMod(config);
  assert.equal(fs.readFileSync(path.join(nativeRoot, 'RNCWebChromeClient.java'), 'utf8'), patchedBase);
  assert.equal(fs.readFileSync(path.join(nativeRoot, 'RNCWebViewModuleImpl.java'), 'utf8'), patchedModule);
  assert.equal(fs.readFileSync(path.join(nativeRoot, 'RNCWebViewManagerImpl.kt'), 'utf8'), manager);
  write(fixtureRoot, 'package.json', JSON.stringify({ version: '13.16.0' }));
  await assert.rejects(androidMod(config), /requires reviewed react-native-webview/);
  write(fixtureRoot, 'package.json', JSON.stringify({ version: '13.15.0' }));
  write(nativeRoot, 'RNCWebChromeClient.java', patchedBase.replace('onCameraPermissionResult(granted);', ''));
  await assert.rejects(androidMod(config), /partially patched capture queue/);
  write(nativeRoot, 'RNCWebChromeClient.java', patchedBase);
  write(nativeRoot, 'RNCWebViewModuleImpl.java', patchedModule.replace('if (activity == null) return failFileChooser(null);', ''));
  await assert.rejects(androidMod(config), /partially patched chooser/);
  write(nativeRoot, 'RNCWebViewModuleImpl.java', patchedModule);

  // Check migration from the first version of this patch too.
  const originalBase = fs.readFileSync(path.join(webviewRoot, nativeRelative, 'RNCWebChromeClient.java'), 'utf8');
  const previousBase = originalBase
    .replace('private synchronized void requestPermissions(List<String> permissions) {',
      'protected void onCameraPermissionResult(boolean granted) {}\n\n    protected synchronized void requestPermissions(List<String> permissions) {')
    .replace('if (permission.equals(Manifest.permission.CAMERA)) {',
      'if (permission.equals(Manifest.permission.CAMERA)) {\n                onCameraPermissionResult(granted);');
  write(nativeRoot, 'RNCWebChromeClient.java', previousBase);
  await androidMod(config);
  assert.equal(fs.readFileSync(path.join(nativeRoot, 'RNCWebChromeClient.java'), 'utf8'), patchedBase);

  // Execute the REAL patched stock listener, request queue, media/geolocation
  // methods, chooser and getPhotoIntent. Only unrelated UI and Android APIs
  // are doubles. This catches cross-owner queue errors hidden by hook-only tests.
  const permissionMethods = between(patchedBase, '    public void onPermissionRequest(', '    protected void openFileChooser(');
  const stockChooser = between(patchedBase, '    public boolean onShowFileChooser(', '    @Override\n    public void onHostResume(');
  const moduleChooser = between(patchedModule, '    // MY_RIDE_CHOOSER_SETTLEMENT_V2', '    public void setDownloadRequest(');
  const photoIntent = between(patchedModule, '    public Intent getPhotoIntent()', '    public Intent getVideoIntent()');
  const javaRoot = path.join(tmp, 'java');
  const stubs = {
    'android/Manifest.java': `package android; public class Manifest { public static class permission {
      public static final String CAMERA="camera", RECORD_AUDIO="audio", ACCESS_FINE_LOCATION="location";
    } }`,
    'android/content/pm/PackageManager.java': 'package android.content.pm; public class PackageManager { public static final int PERMISSION_GRANTED=0; }',
    'android/net/Uri.java': 'package android.net; public class Uri { public static Uri parse(String value) { return new Uri(); } }',
    'android/os/Parcelable.java': 'package android.os; public interface Parcelable {}',
    'android/content/Intent.java': `package android.content; import android.net.Uri; import android.content.pm.PackageManager;
      public class Intent implements android.os.Parcelable {
        public static final String ACTION_CHOOSER="chooser", EXTRA_INTENT="intent", EXTRA_INITIAL_INTENTS="initial";
        public static boolean handler=true;
        public Intent(String action) {} public Intent(String action, Uri uri) {}
        public void putExtra(String key,Object value) {}
        public Object resolveActivity(PackageManager manager) { return handler ? new Object() : null; }
      }`,
    'android/content/DialogInterface.java': 'package android.content; public interface DialogInterface { interface OnClickListener { void onClick(DialogInterface dialog, int which); } }',
    'android/provider/Settings.java': 'package android.provider; public class Settings { public static final String ACTION_APPLICATION_DETAILS_SETTINGS="settings"; }',
    'android/provider/MediaStore.java': 'package android.provider; public class MediaStore { public static final String ACTION_IMAGE_CAPTURE="image", EXTRA_OUTPUT="output"; }',
    'android/app/Activity.java': `package android.app;
      import android.content.Intent; import android.content.pm.PackageManager;
      import com.facebook.react.modules.core.*;
      public class Activity implements PermissionAwareActivity {
        public int requests, launches, code; public String[] asked; public PermissionListener listener;
        public boolean launchFails;
        public String getPackageName() { return "customer"; }
        public boolean isFinishing() { return false; } public boolean isDestroyed() { return false; }
        public PackageManager getPackageManager() { return new PackageManager(); }
        public void startActivity(Intent intent) {}
        public void startActivityForResult(Intent intent, int picker) {
          if (launchFails) throw new SecurityException("camera launch blocked"); launches++;
        }
        public void requestPermissions(String[] permissions,int requestCode,PermissionListener callback) {
          if (listener!=null) throw new AssertionError("Competing permission listeners");
          requests++; asked=permissions; code=requestCode; listener=callback;
        }
        public void finish(String[] permissions,int[] results) {
          PermissionListener active=listener; listener=null;
          for (int i=0;i<permissions.length && i<results.length;i++) {
            androidx.core.content.ContextCompat.results.put(permissions[i],results[i]);
          }
          boolean complete=active.onRequestPermissionsResult(code,permissions,results);
          // ReactActivity keeps its current listener when callback returns false.
          // A successor was installed in that callback; don't erase it.
          if (complete) listener=null;
        }
      }`,
    'android/app/AlertDialog.java': `package android.app; import android.content.DialogInterface;
      public class AlertDialog { public static int shown;
        public static class Builder {
          public Builder(Activity activity) {}
          public Builder setTitle(String value) { return this; }
          public Builder setMessage(String value) { return this; }
          public Builder setNegativeButton(String value, DialogInterface.OnClickListener listener) { return this; }
          public Builder setPositiveButton(String value, DialogInterface.OnClickListener listener) { return this; }
          public void show() { shown++; }
        }
      }`,
    'android/util/Log.java': 'package android.util; public class Log { public static void w(String tag,String text,Throwable error) {} public static void e(String tag,String text,Throwable error) {} }',
    'android/widget/Toast.java': 'package android.widget; public class Toast { public static final int LENGTH_LONG=1; public static int shown; public static Toast makeText(Object context,String text,int time) { return new Toast(); } public void show() { shown++; } }',
    'android/webkit/ValueCallback.java': 'package android.webkit; public interface ValueCallback<T> { void onReceiveValue(T value); }',
    'android/webkit/WebView.java': 'package android.webkit; public class WebView {}',
    'android/webkit/GeolocationPermissions.java': 'package android.webkit; public class GeolocationPermissions { public interface Callback { void invoke(String origin,boolean granted,boolean retain); } }',
    'android/webkit/PermissionRequest.java': `package android.webkit; public class PermissionRequest {
      public static final String RESOURCE_AUDIO_CAPTURE="audio-resource", RESOURCE_VIDEO_CAPTURE="video-resource", RESOURCE_PROTECTED_MEDIA_ID="protected";
      public int calls; public String[] granted;
      public String[] getResources() { return new String[]{RESOURCE_AUDIO_CAPTURE}; }
      public void grant(String[] resources) { calls++; granted=resources; }
    }`,
    'android/webkit/WebChromeClient.java': `package android.webkit; import android.net.Uri;
      public class WebChromeClient {
        public static class FileChooserParams {
          public static final int MODE_OPEN_MULTIPLE=1; public boolean capture;
          public boolean isCaptureEnabled() { return capture; }
          public String[] getAcceptTypes() { return new String[]{"image/*"}; }
          public int getMode() { return 0; }
        }
        public boolean onShowFileChooser(WebView view,ValueCallback<Uri[]> callback,FileChooserParams params) { return true; }
        public void onPermissionRequest(PermissionRequest request) {}
        public void onGeolocationPermissionsShowPrompt(String origin,GeolocationPermissions.Callback callback) {}
      }`,
    'androidx/core/content/ContextCompat.java': `package androidx.core.content; public class ContextCompat {
      public static java.util.Map<String,Integer> results=new java.util.HashMap<>();
      public static int checkSelfPermission(Object context,String permission) { return results.getOrDefault(permission,1); }
    }`,
    'com/facebook/react/modules/core/PermissionListener.java': 'package com.facebook.react.modules.core; public interface PermissionListener { boolean onRequestPermissionsResult(int requestCode,String[] permissions,int[] grantResults); }',
    'com/facebook/react/modules/core/PermissionAwareActivity.java': 'package com.facebook.react.modules.core; public interface PermissionAwareActivity { void requestPermissions(String[] permissions,int requestCode,PermissionListener listener); }',
    'com/reactnativecommunity/webview/RNCWebView.java': `package com.reactnativecommunity.webview; import android.app.Activity;
      public class RNCWebView extends android.webkit.WebView {
        public final Context context=new Context();
        public Context getThemedReactContext() { return context; }
        public static class Context {
          public Activity activity=new Activity();
          public RNCWebViewModule module=new RNCWebViewModule(this);
          public Activity getCurrentActivity() { return activity; }
          public <T> T getNativeModule(Class<T> type) { return type.cast(module); }
        }
      }`,
    'com/reactnativecommunity/webview/RNCWebChromeClient.java': `package com.reactnativecommunity.webview;
      import java.util.*; import android.Manifest; import android.app.Activity; import android.content.pm.PackageManager;
      import android.webkit.*; import android.net.Uri; import androidx.core.content.ContextCompat;
      import com.facebook.react.modules.core.*;
      public class RNCWebChromeClient extends WebChromeClient {
        protected static final int COMMON_PERMISSION_REQUEST=3;
        protected RNCWebView mWebView;
        protected PermissionRequest permissionRequest; protected List<String> grantedPermissions;
        protected GeolocationPermissions.Callback geolocationPermissionCallback; protected String geolocationPermissionOrigin;
        protected boolean permissionsRequestShown=false, mAllowsProtectedMedia=false;
        protected List<String> pendingPermissions=new ArrayList<>();
        public RNCWebChromeClient(RNCWebView view) { mWebView=view; }
        ${permissionMethods}
        ${stockChooser}
      }`,
    'com/reactnativecommunity/webview/RNCWebViewModule.java': `package com.reactnativecommunity.webview;
      import java.util.*; import java.io.*; import android.app.Activity; import android.content.Intent;
      import android.net.Uri; import android.os.Parcelable; import android.provider.MediaStore;
      import android.webkit.ValueCallback; import android.widget.Toast; import android.util.Log;
      public class RNCWebViewModule {
        private final RNCWebView.Context mContext; private ValueCallback<Uri[]> mFilePathCallback;
        private File mOutputImage, mOutputVideo; private static final int PICKER=1;
        public boolean outputFails, uriFails; private enum MimeType { IMAGE }
        public RNCWebViewModule(RNCWebView.Context context) { mContext=context; }
        public boolean startPhotoPickerIntent(ValueCallback<Uri[]> callback,String[] acceptTypes,boolean multiple,boolean capture) {
          return startPhotoPickerIntent(acceptTypes,multiple,callback,capture);
        }
        public boolean hasPendingCallback() { return mFilePathCallback!=null; }
        private boolean needsCameraPermission() { return androidx.core.content.ContextCompat.checkSelfPermission(mContext,"camera")!=0; }
        private boolean acceptsImages(String[] types) { return true; } private boolean acceptsVideo(String[] types) { return false; }
        private Intent getVideoIntent() { return null; }
        private Intent getFileChooserIntent(String[] types,boolean multiple) { return new Intent("gallery"); }
        private File getCapturedFile(MimeType type) throws IOException {
          if (outputFails) throw new IOException("output creation failed"); return new File("unused-test-output");
        }
        private Uri getOutputUri(File file) {
          if (uriFails) throw new IllegalArgumentException("FileProvider URI failed"); return new Uri();
        }
        ${moduleChooser}
        ${photoIntent}
      }`,
    'com/reactnativecommunity/webview/CameraTest.java': `package com.reactnativecommunity.webview;
      import android.Manifest; import android.webkit.*; import android.net.Uri; import android.app.*;
      import android.content.Intent; import android.widget.Toast; import androidx.core.content.ContextCompat;
      public class CameraTest {
        static class Callback implements ValueCallback<Uri[]> {
          int calls; public void onReceiveValue(Uri[] value) { check(value==null,"cancel result"); calls++; }
        }
        static void check(boolean value,String name) { if (!value) throw new AssertionError(name); }
        static class Fixture {
          final RNCWebView view=new RNCWebView(); final CustomerWebChromeClient client=new CustomerWebChromeClient(view);
          final Activity activity=view.context.activity; final RNCWebViewModule module=view.context.module;
          final WebChromeClient.FileChooserParams camera=new WebChromeClient.FileChooserParams();
          final WebChromeClient.FileChooserParams gallery=new WebChromeClient.FileChooserParams();
          Fixture() { ContextCompat.results.clear(); camera.capture=true; Intent.handler=true; }
          void grantCamera() { activity.finish(new String[]{"camera"},new int[]{0}); }
          void grantMic() { activity.finish(new String[]{"audio"},new int[]{0}); }
        }
        public static void main(String[] args) {
          // Camera file dialog active; mic media request queues behind it.
          Fixture f=new Fixture(); Callback capture=new Callback(); f.client.onShowFileChooser(f.view,capture,f.camera);
          PermissionRequest mic=new PermissionRequest(); f.client.onPermissionRequest(mic);
          check(f.activity.requests==1 && mic.calls==0,"mic queued behind file");
          f.grantCamera();
          check(mic.calls==0 && f.activity.requests==2,"file CAMERA must not grant queued mic");
          check(f.activity.asked[0].equals("audio") && f.activity.launches==1,"separate next transaction");
          f.grantMic();
          check(mic.calls==1 && mic.granted.length==1 && mic.granted[0].equals(PermissionRequest.RESOURCE_AUDIO_CAPTURE),"mic receives only audio result");
          check(f.activity.listener==null,"queue drained");

          // Reverse overlap: mic active; file waits without overwriting listener.
          f=new Fixture(); mic=new PermissionRequest(); f.client.onPermissionRequest(mic);
          capture=new Callback(); f.client.onShowFileChooser(f.view,capture,f.camera);
          check(f.activity.requests==1 && f.activity.asked[0].equals("audio"),"file waits behind mic");
          f.grantMic(); check(mic.calls==1 && f.activity.requests==2 && f.activity.launches==0,"mic result starts camera transaction");
          f.grantCamera(); check(mic.calls==1 && f.activity.launches==1,"camera cannot re-answer mic");

          // Replacement settles the first file callback, no second dialog.
          f=new Fixture(); Callback first=new Callback(),second=new Callback();
          f.client.onShowFileChooser(f.view,first,f.camera); f.client.onShowFileChooser(f.view,second,f.camera);
          check(first.calls==1 && f.activity.requests==1,"replacement cancels old file");
          f.grantCamera(); check(second.calls==0 && f.activity.launches==1,"replacement owns result");

          // Empty canceled file result must settle, drain microphone, reset and retry.
          f=new Fixture(); capture=new Callback(); f.client.onShowFileChooser(f.view,capture,f.camera);
          mic=new PermissionRequest(); f.client.onPermissionRequest(mic);
          f.activity.finish(new String[]{},new int[]{});
          check(capture.calls==1 && mic.calls==0 && f.activity.requests==2,"empty result cancels only file");
          f.grantMic(); check(mic.calls==1 && f.activity.listener==null,"mic survives canceled file");
          Callback retry=new Callback(); f.client.onShowFileChooser(f.view,retry,f.camera); f.grantCamera();
          check(f.activity.requests==3 && retry.calls==0 && f.activity.launches==1,"retry after cancellation");
          f=new Fixture(); capture=new Callback(); f.client.onShowFileChooser(f.view,capture,f.camera);
          f.activity.finish(new String[]{"camera"},new int[]{});
          check(capture.calls==1 && f.activity.listener==null,"mismatched result is cancellation");
          f=new Fixture(); capture=new Callback(); f.client.onShowFileChooser(f.view,capture,f.camera);
          f.activity.finish(new String[]{"camera"},new int[]{1});
          check(capture.calls==1 && f.activity.launches==0,"denial cancels without gallery fallback");

          // Actual stock getPhotoIntent output errors -> null -> explicit settlement.
          for (int failure=0;failure<4;failure++) {
            f=new Fixture(); ContextCompat.results.put("camera",0); capture=new Callback();
            if (failure==0) Intent.handler=false;
            if (failure==1) f.module.outputFails=true;
            if (failure==2) f.module.uriFails=true;
            if (failure==3) f.activity.launchFails=true;
            int errors=Toast.shown; f.client.onShowFileChooser(f.view,capture,f.camera);
            check(capture.calls==1 && !f.module.hasPendingCallback(),"unlaunchable camera settles "+failure);
            check(Toast.shown==errors+1 && f.activity.launches==0,"camera failure visible "+failure);
            Intent.handler=true; f.module.outputFails=false; f.module.uriFails=false; f.activity.launchFails=false;
            Callback recovered=new Callback(); f.client.onShowFileChooser(f.view,recovered,f.camera);
            check(recovered.calls==0 && f.activity.launches==1,"chooser retries after error "+failure);
          }
          // A permission grant followed by missing camera handler settles too.
          f=new Fixture(); Intent.handler=false; capture=new Callback();
          f.client.onShowFileChooser(f.view,capture,f.camera); f.grantCamera();
          check(capture.calls==1 && !f.module.hasPendingCallback(),"deferred chooser failure settled");

          f=new Fixture(); capture=new Callback(); f.client.onShowFileChooser(f.view,capture,f.gallery);
          check(f.activity.requests==0 && f.activity.launches==1,"gallery unchanged");
          f=new Fixture(); f.view.context.activity=null; capture=new Callback();
          f.client.onShowFileChooser(f.view,capture,f.camera); check(capture.calls==1,"detached denied camera");
          ContextCompat.results.put("camera",0); capture=new Callback();
          f.client.onShowFileChooser(f.view,capture,f.camera); check(capture.calls==1 && !f.module.hasPendingCallback(),"detached allowed camera");
          f=new Fixture(); capture=new Callback(); f.client.onShowFileChooser(f.view,capture,f.camera);
          f.view.context.activity=null; f.grantCamera(); check(capture.calls==1,"detached permission result");
          System.out.println("REAL patched permission listener/queue and stock chooser regression tests passed");
        }
      }`,
  };
  for (const [filename, content] of Object.entries(stubs)) write(javaRoot, filename, content);
  write(javaRoot, 'com/reactnativecommunity/webview/CustomerWebChromeClient.java',
    fs.readFileSync(path.join(nativeRoot, 'CustomerWebChromeClient.java'), 'utf8'));
  const javaFiles = [...Object.keys(stubs), 'com/reactnativecommunity/webview/CustomerWebChromeClient.java']
    .map(filename => path.join(javaRoot, filename));
  execFileSync('javac', ['-d', path.join(tmp, 'classes'), ...javaFiles], { stdio: 'inherit' });
  execFileSync('java', ['-cp', path.join(tmp, 'classes'), 'com.reactnativecommunity.webview.CameraTest'], { stdio: 'inherit' });
  console.log('Customer camera config patch passed (idempotence, migration/version guards, native regressions)');
}
main().catch(error => { console.error(error); process.exitCode = 1; })
  .finally(() => fs.rmSync(tmp, { recursive: true, force: true }));