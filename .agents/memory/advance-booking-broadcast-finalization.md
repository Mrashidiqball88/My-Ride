---
name: Advance booking broadcast and finalization
description: State and delivery rules for immediate scheduled-booking matching and Driver offer selection.
---

Immediate scheduled-booking matching must persist the eligible notified Driver set. A Driver's direct Accept atomically assigns and locks that Driver immediately; Counter responses remain pending for Customer selection. Assignment remains in the dedicated scheduled-rides state and must not create an active Ride until the assigned Driver explicitly presses Start Ride at or after the scheduled time.

**Why:** The product flow has two separate actions: accepting reserves the future trip, while starting activates the live trip. Timer-based conversion made the ride appear active before the assigned Driver initiated it.

**How to apply:** Use a dedicated scheduled-booking socket/push event and an Advance Bookings UI state. Restrict mutations to notified eligible Drivers, atomically reject competing assignments, emit a populated assignment event to Customer, Driver, and Admin, keep counter-offers available for Customer selection, and expose one server-authoritative activation endpoint for the assigned Driver.