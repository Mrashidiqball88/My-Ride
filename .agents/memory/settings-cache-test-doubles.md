---
name: Settings cache test doubles
description: How settings-cache readiness checks should behave when unit tests replace Mongoose loaders.
---

Settings loaders may treat a deliberately replaced model method as a readable test double even when the real Mongoose connection is disconnected; production requests must still use the safe fallback while the database is not ready.

**Why:** Unit tests for route behavior commonly stub Settings queries without opening MongoDB. A strict connection-state gate makes those tests receive defaults instead of the configured fixture, while removing the gate can make production startup requests wait on buffered database queries.

**How to apply:** Preserve the production readiness check and add a narrowly scoped, explicit seam for replaced model methods whenever settings are cached or loaded through a database-readiness helper.