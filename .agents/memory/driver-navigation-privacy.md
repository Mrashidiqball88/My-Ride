---
name: Driver navigation privacy
description: Why the Driver App uses local active-leg navigation rather than a public remote routing endpoint.
---

Active navigation must calculate its visual pickup/drop-off leg locally from the driver's current location and persisted ride coordinates. Do not send precise driver and passenger coordinates to an unauthenticated public routing service from the browser.

**Why:** Exact pickup, drop-off, and live location are sensitive trip data. The product has no approved routing-provider agreement or user disclosure for sharing that data with a third party.

**How to apply:** Keep the current direct-leg distance, ETA, camera-following, and marker behavior local. Before adding road-following directions or turn-by-turn routing, use an approved provider behind a controlled backend and document the privacy/retention approach.