---
name: Online fee lifecycle
description: Daily fee charging and Driver availability share one server-authoritative online lifecycle.
---

Scheduled Daily Fee rollover must target explicitly online Drivers only; offline Drivers must not be charged or accrue fee passes. Both web and native activation must call the authoritative availability flow so a due fee is deducted immediately, with the persisted online start and next-deduction timestamps returned to the clients.

**Why:** Charging every active account creates unexpected wallet deductions for Drivers who were offline, while client-only online toggles can show availability without completing the fee decision.

**How to apply:** Keep online/offline transitions, fee charging, and timing fields in the availability endpoint/socket contract, preserve Long Range Only exemption, and make failed fee activation clear persisted online state and acceptance eligibility.