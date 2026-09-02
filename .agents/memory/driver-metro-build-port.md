---
name: Driver Metro build port
description: Workspace port constraint for native Driver static builds
---

The Driver static build should use a dedicated configurable Metro port rather than the shared preview port; retain an environment override for CI or another workspace layout.

**Why:** The mockup preview server occupies 8081, and Expo prompts interactively to move ports when the build runs non-interactively.

**How to apply:** Keep METRO_PORT supported and choose a separate default for the Driver build script; verify both platform bundles and manifests after starting Metro.