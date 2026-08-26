# My Ride Android production wrappers

This project produces two standalone Android APKs:

- `My Ride - Customer` → `https://myride.duckdns.org/customer`
- `My Ride - Driver` → `https://myride.duckdns.org/driver`

The URLs are compiled into the customer and driver product flavors. The WebView
only permits HTTPS navigation on `myride.duckdns.org`; it rejects cleartext
traffic and does not contain any Replit, preview, localhost, or development URL.

## Build the APKs

From this directory:

```bash
./scripts/build-apks.sh
```

The script installs/validates the Android SDK locally when needed, then builds:

- `dist/myride-customer-release.apk`
- `dist/myride-driver-release.apk`

When no signing variables are present, the script uses a short-lived local
install key so the generated APKs can be installed immediately on test devices.
That key is created outside the repository and deleted after the build, so those
APKs are not suitable for future updates or Google Play distribution.

For production releases, provide the organization's signing key without placing
it in the repository:

```bash
export MYRIDE_RELEASE_KEYSTORE=/secure/path/myride-upload.jks
export MYRIDE_RELEASE_KEYSTORE_PASSWORD='...'
export MYRIDE_RELEASE_KEY_ALIAS='myride'
export MYRIDE_RELEASE_KEY_PASSWORD='...'
./scripts/build-apks.sh
```

The resulting `dist` files are then signed production release APKs.

## Runtime capabilities

- HTTPS-only JavaScript WebView
- JavaScript, cookies, DOM storage, and WebSocket support
- Runtime fine/coarse location permission for browser geolocation and live maps
- File picker support for identity/document uploads
- Android media and legacy storage compatibility declarations
- Back navigation and rotation/process state restoration

The wrapper intentionally does not request background location. The production
web apps use foreground geolocation while the active ride screen is open; a
background tracking service would require a separate native product decision
and Play policy review.