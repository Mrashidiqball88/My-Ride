---
name: Map rendering and GPS follow
description: Performance and interaction rules for the Customer and Driver Leaflet maps.
---

Use native dark basemap tiles for the Driver map; never apply SVG inversion, high-contrast filters, or retina tile overfetching to create the charcoal look. Center on the first valid GPS fix, then only follow live movement while follow mode is active; a manual drag must stop forced recentering.

**Why:** Filtering dense raster tiles caused severe mobile rendering lag and distorted white outlines, while recentering on every GPS callback made the map fight user gestures.

**How to apply:** Keep tile loading lightweight with a bounded buffer and idle updates. Recenter on first fix or an explicit locate/follow action, and throttle later camera updates by meaningful movement rather than every geolocation event.