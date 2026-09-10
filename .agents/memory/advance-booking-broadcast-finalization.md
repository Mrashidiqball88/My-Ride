---
name: Advance booking broadcast and finalization
description: State and delivery rules for immediate scheduled-booking matching and Driver offer selection.
---

Immediate scheduled-booking matching must persist the eligible notified Driver set. A Driver's direct Accept atomically assigns and locks that Driver immediately; Counter responses remain pending for Customer selection. Assignment remains scheduled and must not create an active Ride until the dispatcher converts it.

**Why:** The product flow treats direct Driver Accept as the assignment action; leaving it as an unassigned offer made valid bookings appear stuck in Admin and hid them from the expected scheduled-ride state.

**How to apply:** Use a dedicated scheduled-booking socket/push event and an Advance Bookings UI state. Restrict mutations to notified eligible Drivers, atomically reject competing assignments, emit a populated assignment event to Customer, Driver, and Admin, and keep counter-offers available for Customer selection.