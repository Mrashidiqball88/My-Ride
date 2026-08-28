---
name: Pickup city search context
description: The Customer pickup pin controls local geocoding context and must replace stale GPS or previous-city state.
---

The Customer search anchor is the first pickup pin. Before its reverse lookup completes, search may use the pickup coordinates for proximity ranking without inheriting the previous city; once resolved, the detected city is used for local prioritization. GPS and the map's nationwide default are fallbacks only when no pickup exists.

**Why:** A stale or hardcoded city can make ambiguous searches such as “DHA” return the wrong city's locations, while a bounded geocoder can hide valid named locations.

**How to apply:** Clear the old city context whenever pickup changes or is cleared, invalidate older reverse-lookups, and keep search city filtering/ranking derived from the current pickup rather than from a Lahore default.