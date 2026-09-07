---
name: Long Range commission percentage
description: The authoritative calculation and wallet-gating rule for Long Range ride commissions.
---

Long Range commission settings are percentage values. The Driver wallet debit is calculated from the persisted final agreed ride fare as `final fare × configured percentage ÷ 100`, and the Admin-selected timing controls whether it is charged at verified ride start or successful completion. Acceptance never debits it.

**Why:** Long Range commission was changed from a fixed rupee deduction to a fare-relative charge, then moved out of acceptance so pending, accepted, and arrived rides cannot be charged prematurely.

**How to apply:** Keep the persisted Admin setting key compatible, calculate the ride-specific commission before wallet allocation, and treat the configured minimum wallet balance as an independent floor alongside the calculated commission. Preserve the two timing values (`started` and `completed`) and the existing idempotency transaction guard.