---
name: Wallet source accounting
description: Durable rules for separating Driver wallet funding sources from real platform revenue.
---

Wallet debits must record their funding source and split real-cash and bonus portions when a debit is mixed. New daily fees and Long Range commissions consume real cash first, then bonus balance. Approved Driver recharges are wallet funding; settled ride earnings are audit-only income entries and never wallet-funding credits. Admin bonuses remain bonus-funded.

**Why:** Aggregate wallet balance and cumulative credit-origin totals cannot identify which source paid a later debit. Real-cash-first preserves explicitly deposited cash until it is spent, while keeping independent ride payouts from making fee funds appear available.

**How to apply:** Admin revenue reports count only the real portion of source-aware fee/commission debits. Bonus-funded portions belong in Bonus / Non-Revenue Earnings, approved recharges remain funding rather than revenue, and Ride earnings transactions use the earnings source with zero real/bonus amount. Historical debits without source metadata are excluded from real revenue and shown as unclassified where useful.