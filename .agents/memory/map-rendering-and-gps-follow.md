---
name: Map rendering and GPS follow
description: Coverage, fallback, performance, and interaction rules for the Customer, Driver, and Admin Mapbox maps.
---

Use the globally covered Mapbox Streets style for Customer, Driver, and Admin maps. During an active Driver ride, keep the blue marker at the camera center, rotate the camera to GPS heading or movement-derived bearing, and apply a navigation pitch; manual pan, zoom, rotate, or pitch temporarily stops follow until Recenter is selected. Outside active navigation, center on the first valid GPS fix or explicit locate action.

Customer booking selection uses a fixed center pin: while choosing pickup or a drop-off, a map drag commits the map's center coordinate on `moveend`; a pointer click must not create a movable selection pin.

**Why:** A center-anchored selection matches navigation-map behavior, keeps the selected point visually stable while the customer explores nearby streets, and avoids inaccurate pointer offsets on touch devices.

**How to apply:** Keep the center overlay visible only for the active pickup/drop-off mode, suppress programmatic camera moves from being treated as selections, and retain normal map markers for already-confirmed locations.

**Why:** Filtering dense raster tiles caused severe mobile rendering lag and distorted white outlines, while a demo vector style rendered a canvas but left Lahore visually blank. Active navigation needs continuous camera follow and heading rotation, but the map must still allow deliberate inspection gestures.

**How to apply:** Verify actual feature/tile coverage at the app's default cities, not just style HTTP status. Keep active GPS publication serialized to the existing three-second lifecycle, route precise coordinates through the authenticated backend, preserve the selected zoom, and let Recenter restore follow after a manual gesture.