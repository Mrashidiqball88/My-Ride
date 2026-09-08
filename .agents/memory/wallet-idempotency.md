---
name: Wallet mutation idempotency
description: Rules for retry-safe wallet, recharge, and commission mutations.
---

Persist the idempotency record and the financial mutation in the same MongoDB transaction. Key records by operation scope, actor, and client key, and reject reuse when the request fingerprint changes.

**Why:** A retry can arrive after a committed transaction but before its response reaches a browser or mobile client; process-local flags cannot prevent a duplicate credit or debit after restart.

**How to apply:** Keep idempotency keys optional for backward compatibility, but have first-party clients persist and resend the same key until success. Store only a compact replay result, never proof images or other large request payloads.