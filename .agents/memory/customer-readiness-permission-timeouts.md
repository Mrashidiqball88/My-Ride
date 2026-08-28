---
name: Customer readiness permission timeouts
description: Reliability rule for the Customer booking-tools onboarding modal and browser capability prompts
---

Every Customer onboarding capability check or permission request must have a bounded timeout and a non-blocking fallback. Continue and Skip must always clear the modal's busy state and acknowledge the readiness step, even when geolocation, microphone, notification, or audio APIs hang or are denied.

**Why:** Browser permission prompts can remain pending indefinitely on mobile browsers, leaving a disabled Continue button and making the onboarding surface blink or trap the user before the map.

**How to apply:** Keep capability requests isolated from map/search state, clean up late microphone streams, invalidate stale readiness runs when Skip is pressed, and use manual map pinning when location access is unavailable.