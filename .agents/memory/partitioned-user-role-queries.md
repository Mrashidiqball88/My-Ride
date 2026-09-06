---
name: Partitioned user role queries
description: Compatibility rule for role-scoped queries after Customer and Driver records move into separate collections
---

When the shared User facade resolves a query to one concrete Customer or Driver collection, strip the redundant role predicate before sending the query to MongoDB; validate the resolved model or role in application code where authorization requires it.

**Why:** Mongoose model defaults can expose a role on a hydrated document even when older split-collection records do not physically contain the legacy role field. Requiring that field in a collection query causes valid Drivers to disappear from dispatch and selection flows.

**How to apply:** Keep role-based collection selection in the facade, remove only a single-role discriminator from the concrete collection filter, and retain explicit authorization/availability checks at sensitive route boundaries.

The Admin live-location snapshot must use the proven multi-role facade query shape and filter Drivers after the merge; its single-role snapshot query can otherwise return an empty fleet even while map-search and map-location resolve the same Driver.

**Why:** The live fleet view is a high-frequency read path, and a query-shape mismatch can make every fresh heartbeat appear missing without affecting the Driver heartbeat or persisted coordinates.

**How to apply:** Keep this workaround scoped to the fleet snapshot, and verify the result against the authoritative map-location endpoint before changing heartbeat writes or Socket.io publishing.