---
name: Advance booking broadcast and finalization
description: State and delivery rules for immediate scheduled-booking matching and Driver offer selection.
---

Immediate scheduled-booking matching must persist the eligible notified Driver set and keep the booking pending while Driver accept/counter responses are collected. Only the Customer's atomic offer selection changes the booking to assigned; that assignment remains scheduled and must not create an active Ride until the dispatcher converts it.

**Why:** Treating a Driver's initial response as an assignment prevented the Customer from choosing among offers and allowed scheduled reservations to enter the live-ride lifecycle too early.

**How to apply:** Use a dedicated scheduled-booking socket/push event and an Advance Bookings UI state. Restrict offer mutations to notified eligible Drivers, expose each Driver's own offer for reconnect rehydration, and emit a populated assignment event only after finalization.