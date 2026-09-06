---
name: Preview financial transactions
description: Environment constraint for exercising atomic wallet flows in the local preview.
---

The in-memory preview database must run as a single-node replica set because Daily Fee and Long Range financial writes use MongoDB transactions.

**Why:** A standalone in-memory server accepts ordinary reads and writes but rejects transaction sessions, making the preview report false financial failures even when production MongoDB is transaction-capable.

**How to apply:** Preserve transaction-capable preview startup whenever testing wallet debits, passes, commissions, or revenue atomicity locally.