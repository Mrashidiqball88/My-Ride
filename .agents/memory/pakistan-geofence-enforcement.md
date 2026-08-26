---
name: Pakistan geofence enforcement
description: Pakistan-only locations require a shared polygon and server enforcement across every coordinate ingress.
---

All Customer and Driver location coordinates must be inside the national Pakistan polygon. Browser checks provide immediate feedback, but REST and Socket.io checks are the authority; never rely on a client-only map restriction.

**Why:** Coordinates can arrive from search results, GPS, API calls, realtime events, native background updates, and legacy clients. A latitude/longitude rectangle would also admit neighboring countries.

**How to apply:** Use the reusable polygon helper for every new coordinate-bearing route, event, or persisted location. Reject failures with `OUTSIDE_PAKISTAN` and the exact user message “Please select a location inside Pakistan.”