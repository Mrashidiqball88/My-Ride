---
name: Driver navigation privacy
description: Why the Driver App uses local active-leg navigation rather than a public remote routing endpoint.
---

Active navigation must use road geometry through the authenticated app backend, never by sending precise driver and passenger coordinates directly from the browser to a public routing service. Keep local direct-distance fallback calculations for ETA and graceful degradation.

**Why:** Exact pickup, drop-off, and live location are sensitive trip data. The product has no approved routing-provider agreement or user disclosure for sharing that data with a third party.

**How to apply:** Route requests should go through the controlled backend so authentication, validation, throttling, provider replacement, and privacy review remain centralized. Before production turn-by-turn routing, replace any provisional public provider with an approved provider and document retention/disclosure.