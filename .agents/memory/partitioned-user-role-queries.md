---
name: Partitioned user role queries
description: Compatibility rule for role-scoped queries after Customer and Driver records move into separate collections
---

When the shared User facade resolves a query to one concrete Customer or Driver collection, strip the redundant role predicate before sending the query to MongoDB; validate the resolved model or role in application code where authorization requires it.

**Why:** Mongoose model defaults can expose a role on a hydrated document even when older split-collection records do not physically contain the legacy role field. Requiring that field in a collection query causes valid Drivers to disappear from dispatch and selection flows.

**How to apply:** Keep role-based collection selection in the facade, remove only a single-role discriminator from the concrete collection filter, and retain explicit authorization/availability checks at sensitive route boundaries.

Realtime Driver audience reads must search both the dedicated Driver collection and legacy Driver-role records still stored in the Customer collection; keep the fallback scoped to dispatch, recovery, presence, and live fleet reads.

**Why:** A partial Customer/Driver collection migration can make single-role Driver queries return zero candidates even while authentication, map-search, and map-location resolve the same online Driver.

**How to apply:** Prefer current Driver records, include only explicitly role-marked legacy Driver records from the other partition, deduplicate by ID, and preserve the no-database User facade seam used by tests.