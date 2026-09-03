---
name: Customer map generation guards
description: Prevent stale asynchronous Customer map work from restoring removed markers or routes.
---

Customer map updates must invalidate older route and nearby-driver requests before applying a newer pickup, drop-off, or map-clear action. Marker references must be removed before replacement, and a same-point GPS marker must not be shown on top of the pickup marker.

**Why:** Reverse geocoding, nearby-driver polling, and road routing resolve independently. A slower response from an earlier coordinate can otherwise repaint an old route or marker after the user has selected a new point; stop removal can also orphan a marker reference.

**How to apply:** Keep generation counters for each asynchronous map surface, remove the owned Mapbox marker/source/layers before replacement, and apply a response only when its generation still matches the current selection.