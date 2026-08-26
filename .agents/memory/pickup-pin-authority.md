---
name: Pickup PIN authority
description: Security and UI rules for releasing ride verification PINs at pickup
---

The ride verification PIN is an in-person handoff secret. The server must persist pickup arrival only after validating the Driver's GPS against the pickup point, and only then may the Customer receive or display the PIN.

**Why:** Client-side distance checks can be altered or become stale, and a pre-pickup API response can reveal the secret before the handoff. The authoritative persisted gate also provides a stable cancellation boundary.

**How to apply:** Keep `pickupReachedAt` server-owned; redact the PIN from all pre-pickup responses and acceptance events; emit a Customer-only release event after a valid location update; lock Customer cancellation once the gate exists.