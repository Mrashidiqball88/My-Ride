---
name: External production drift
description: How to distinguish a current repository from an old externally hosted My Ride runtime.
---

The public My Ride host can serve an older checkout or static directory even when the local `main` branch and `origin/main` are current. Verify the actual public HTML/API response and runtime process before concluding that a change was reverted.

**Why:** A production `/customer` and `/admin` response was independently observed serving the legacy Leaflet/OpenStreetMap implementation while the synchronized repository and local workflow served Mapbox Streets v12. This was deployment drift, not loss of committed Git history.

**How to apply:** After release, compare the public response for the current provider markers and security UI, confirm the production checkout commit/branch, then restart the process that serves the files. If the public HTML is old, browser cache is not the primary diagnosis.