---
name: Legacy Admin shell refresh
description: Verifying static Admin HTML changes in the legacy Ride Hailing workflow.
---

For the legacy single-server Admin surface, a browser test can continue receiving an older static HTML shell after source edits until the Ride Hailing workflow is restarted.

**Why:** A MapLibre migration initially appeared broken because the running process still served the previous Leaflet Admin shell even though the workspace source had already changed.

**How to apply:** After Admin HTML or server changes, restart the configured Ride Hailing workflow before judging browser behavior; confirm the served `/admin` shell contains the expected dependency markers.