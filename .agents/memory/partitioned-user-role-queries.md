---
name: Partitioned user role queries
description: Compatibility rule for role-scoped queries after Customer and Driver records move into separate collections
---

When the shared User facade resolves a query to one concrete Customer or Driver collection, strip the redundant role predicate before sending the query to MongoDB; validate the resolved model or role in application code where authorization requires it.

**Why:** Mongoose model defaults can expose a role on a hydrated document even when older split-collection records do not physically contain the legacy role field. Requiring that field in a collection query causes valid Drivers to disappear from dispatch and selection flows.

**How to apply:** Keep role-based collection selection in the facade, remove only a single-role discriminator from the concrete collection filter, and retain explicit authorization/availability checks at sensitive route boundaries.