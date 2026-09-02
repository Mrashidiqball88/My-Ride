---
name: Customer live geocoding
description: Durable source-of-truth and ranking rule for Customer location suggestions
---

Customer typed and voice suggestions must always retain the unchanged live Pakistan geocoder lookup. Runtime-managed aliases may augment that lookup with canonical provider searches or safe direct candidates, but they must never replace it with a finite local corpus.

**Why:** A hardcoded location index cannot cover nationwide streets, chowks, universities, landmarks, or newly mapped places, while vetted aliases are necessary for local colloquialisms and speech variants that providers do not understand without a city.

**How to apply:** Keep provider country restriction, coordinate validation, deduplication, timeout, cancellation, and stale-response handling at the API/UI boundary. Alias matching must be bounded; only exact high-confidence records with valid Pakistan coordinates may inject direct locations, and all ordinary provider results remain visible. For Mapbox Geocoding v5, use only its accepted feature types (not `street`, which returns HTTP 422), prefer `MAPBOX_ACCESS_TOKEN` with the configured public-token fallback, and keep the raw query unchanged for Urdu/Roman Urdu input even when the response language is English. For reverse geocoding, prefer detailed address/area features over city-level results and never persist a city-only label into a ride payload.