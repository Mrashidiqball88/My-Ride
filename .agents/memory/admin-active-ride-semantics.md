---
name: Admin active ride semantics
description: The meaning and refresh behavior of the Admin Overview Active Rides metric.
---

The Admin Overview “Active Rides” metric counts only assigned ongoing trips: accepted, arrived, and in-progress. Requested rides are open booking offers and are not included.

**Why:** An unassigned request is not yet an ongoing trip; including it makes the dashboard report active rides when no Driver has accepted a ride.

**How to apply:** Keep the server-side status set aligned with the active-ride states used by Customer and Driver surfaces. Refresh the Admin overview after ride lifecycle changes so the header badge and summary card stay authoritative.