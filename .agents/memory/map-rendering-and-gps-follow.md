---
name: Map rendering and GPS follow
description: Performance and interaction rules for the Customer and Driver Leaflet maps.
---

Use lightweight native basemap tiles for the Driver map; never apply SVG inversion, high-contrast filters, retina tile overfetching, or expensive fallback-tile work to create the charcoal look. Center on the first valid GPS fix, then follow only from explicit navigation/locate actions; manual pan or zoom must stop forced recentering.

**Why:** Filtering dense raster tiles caused severe mobile rendering lag and distorted white outlines, while recentering on every GPS callback made the map fight user gestures.

**How to apply:** Restore the known-fast Leaflet tile configuration before trying visual experiments. Recenter on first fix or an explicit locate/follow action; do not add recurring camera timers, and never recenter on every geolocation event. Treat zoom gestures as user camera control and preserve the selected zoom.