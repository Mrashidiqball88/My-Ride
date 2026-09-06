---
name: Long Range commission percentage
description: The authoritative calculation and wallet-gating rule for Long Range ride commissions.
---

Long Range commission settings are percentage values. The Driver wallet debit is calculated from the persisted final agreed ride fare as `final fare × configured percentage ÷ 100`, at acceptance.

**Why:** Long Range commission was changed from a fixed rupee deduction to a fare-relative charge while preserving the existing minimum wallet balance policy.

**How to apply:** Keep the persisted Admin setting key compatible, calculate the ride-specific commission before wallet allocation, and treat the configured minimum wallet balance as an independent floor alongside the calculated commission.