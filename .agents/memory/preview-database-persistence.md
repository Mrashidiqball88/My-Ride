---
name: Preview database persistence
description: The ride-hailing preview falls back to an in-memory MongoDB when no MONGO_URI is configured.
---

The ride-hailing preview database is process-local when `MONGO_URI` is absent; records survive normal requests but are recreated when the workflow restarts.

**Why:** The preview intentionally uses `mongodb-memory-server` for demo/testing mode rather than a durable external MongoDB connection.

**How to apply:** Seed any required preview accounts or fixtures during startup, and clearly distinguish current-preview availability from durable production persistence.