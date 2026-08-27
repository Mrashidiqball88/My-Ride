---
name: Map rendering and GPS follow
description: Coverage, fallback, performance, and interaction rules for the Customer and Driver MapLibre maps.
---

Use a globally covered MapLibre style for Customer, Driver, and Admin maps; a demo style can return HTTP 200 and still contain no useful feature data for the deployed city. Keep a lightweight OSM raster style as a one-time pre-load fallback. Center on the first valid GPS fix, then follow only from explicit navigation/locate actions; manual pan or zoom must stop forced recentering.

**Why:** Filtering dense raster tiles caused severe mobile rendering lag and distorted white outlines, while the demo vector style rendered a canvas but left Lahore visually blank. Re-centering on every GPS callback also made the map fight user gestures.

**How to apply:** Verify actual feature/tile coverage at the app's default cities, not just style HTTP status. Use the raster fallback only when the vector style fails before loading; do not add recurring camera timers, and never recenter on every geolocation event. Treat zoom gestures as user camera control and preserve the selected zoom.