---
name: MongoDB Atlas connection retry
description: Production database startup behavior during Atlas latency or transient network outages.
---

When a real MongoDB URI is configured, the server must keep retrying the initial connection with bounded backoff and must never silently reinterpret the deployment as testing/demo mode.

**Why:** A single short server-selection window can make a healthy DigitalOcean-to-Atlas deployment appear unavailable during ordinary network latency, while demo-mode messaging hides the actual configuration problem.

**How to apply:** Use a configurable selection timeout with a production-safe default, distinguish `connecting` from `testing-mode` in health responses, and serialize post-reconnect Admin credential reconciliation.