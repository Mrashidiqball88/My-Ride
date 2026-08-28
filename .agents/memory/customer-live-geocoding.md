---
name: Customer live geocoding
description: Durable source-of-truth and ranking rule for Customer location suggestions
---

Customer typed and voice suggestions must come exclusively from the live Pakistan geocoder. The Customer UI may use the pickup/GPS city to order provider results, but it must never filter, replace, or supplement them with a finite local corpus.

**Why:** A hardcoded location index cannot cover nationwide streets, chowks, universities, landmarks, or newly mapped places, and city filtering can hide valid cross-city destinations.

**How to apply:** Keep provider country restriction, coordinate validation, deduplication, timeout, cancellation, and stale-response handling at the API/UI boundary. Treat aliases and local fuzzy matching as retired for Customer search.