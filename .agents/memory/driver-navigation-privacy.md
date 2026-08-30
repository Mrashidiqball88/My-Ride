---
name: Driver navigation privacy
description: Why the Driver App uses authenticated-backend Mapbox routing for local active-leg navigation.
---

Active navigation must use Mapbox road geometry through the authenticated app backend, never by sending precise driver and passenger coordinates directly from the browser to a public routing service. Keep local direct-distance fallback calculations for ETA and graceful degradation.

**Why:** Exact pickup, drop-off, and live location are sensitive trip data. Keeping Mapbox behind the authenticated backend preserves request validation and prevents the browser from directly disclosing trip coordinates to an uncontrolled endpoint.

**How to apply:** Route requests should go through the controlled backend so authentication, validation, throttling, provider replacement, and privacy review remain centralized. Keep Mapbox access tokens out of source and document provider retention/disclosure before production turn-by-turn routing.