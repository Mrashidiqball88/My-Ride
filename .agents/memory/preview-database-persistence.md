---
name: Preview database persistence
description: The ride-hailing preview falls back to an in-memory MongoDB when no MONGO_URI is configured.
---

The ride-hailing service is process-local only when demo/testing mode is explicitly enabled without `MONGO_URI`; the canonical production workflow disables persistence and reports `unconfigured` instead.

**Why:** Production must never silently substitute an ephemeral database for the durable MongoDB connection required by booking, account, and financial flows.

**How to apply:** Seed fixtures only in non-production demo mode, and verify `/api/health` reports `connected` before claiming a real end-to-end flow works.