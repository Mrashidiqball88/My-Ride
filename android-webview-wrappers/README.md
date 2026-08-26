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

These are unsigned release APKs suitable for direct device installation. For
Google Play or managed distribution, sign the same release artifacts with the
organization's Android upload key in CI.

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