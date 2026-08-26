---
name: Android WebView APK builds
description: The workspace Android wrapper build requires a standard JDK 17 runtime and uses flavor-specific production URLs.
---

Use a standard OpenJDK 17 runtime for Android Gradle Plugin builds; the available GraalVM runtime can fail while transforming Android SDK 35 system modules with `jlink`.

**Why:** The Android SDK 35 toolchain reached compilation but failed under GraalVM even though Gradle and the project configuration were valid.

**How to apply:** Prefer the supported JDK 17 toolchain before diagnosing Android source or Gradle configuration errors.