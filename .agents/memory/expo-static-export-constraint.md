---
name: Expo static export constraint
description: A workspace-specific Expo Router static export failure that is separate from app source validation.
---

The native Driver app can pass TypeScript checks and serve through the development Metro workflow while the standalone static export fails before evaluating application code because Expo Router receives `process.env.EXPO_ROUTER_APP_ROOT` as a non-literal `require.context` root.

**Why:** The export failure appeared in the existing Expo Router bundling path, while the restarted dev workflow served normally and no application-source error was reported.

**How to apply:** Treat this as a build-tooling/export-path issue until the Expo Router configuration or build script is corrected; do not attribute it to ordinary feature source changes without a new Metro source error.