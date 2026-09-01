---
name: Android Driver alert capabilities
description: Why the native Driver alert flow uses a generated Android bridge for special settings.
---

The native Driver readiness gate must use a small generated Android bridge to read display-over-other-apps, battery-optimization exemption, and Android 14 full-screen-intent state. Expo permission APIs and manifest declarations alone cannot verify these user-controlled settings.

**Why:** Android OEMs can suspend background work or suppress urgent presentation even when notification and location permissions are granted. Treating manifest declarations as proof would allow a Driver online without a reliable locked-screen recovery path.

**How to apply:** Keep the bridge registered through the Expo prebuild config plugin, version urgent notification channels when their importance behavior changes, and fail closed until the live native status plus Expo notification/location checks all pass. Physical locked-device testing is still required before claiming delivery reliability.