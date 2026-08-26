---
name: Ride cancellation events
description: Realtime cancellation delivery must reach pending Driver offers and active rides without duplicate UI effects.
---

Customer cancellation uses a dedicated `ride_cancelled` event alongside the generic lifecycle status event; Driver cleanup must be idempotent because both events may arrive.

**Why:** Pending Drivers may not have joined the ride room yet, while existing clients still depend on the generic status channel.

**How to apply:** Fan out to the ride, passenger, assigned-driver, notified-driver, and vehicle rooms, then match by ride ID before clearing timers, alerts, offers, or active navigation.