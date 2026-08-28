---
name: Deferred map marker selection
description: Customer location cards can be selected before the MapLibre instance has finished initializing.
---

Customer pickup and drop-off selection must commit coordinates and booking mode even when the map is not ready; marker creation is deferred until a map instance exists.

**Why:** A location sheet can become interactive before MapLibre finishes creating the map. Calling `Marker.addTo(undefined)` aborts the selection handler after coordinates are stored, leaving the UI in the old map mode.

**How to apply:** Guard marker and camera operations on map readiness, keep selected coordinates authoritative in state, and synchronize any state-owned markers during map initialization.