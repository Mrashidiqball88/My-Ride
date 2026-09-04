---
name: Wallet source accounting
description: Durable rules for separating Driver wallet funding sources from real platform revenue.
---

Wallet debits must record their funding source and split real-cash and bonus portions when a debit is mixed. New daily fees and Long Range commissions consume real cash first, then bonus balance. Real-funded credits include approved Driver recharges and settled ride earnings; Admin bonuses remain bonus-funded.

**Why:** Aggregate wallet balance and cumulative credit-origin totals cannot identify which source paid a later debit. Real-cash-first preserves funded cash until it is spent while still preventing promotional credits from being counted as platform revenue.

**How to apply:** Admin revenue reports count only the real portion of source-aware fee/commission debits. Bonus-funded portions belong in Bonus / Non-Revenue Earnings, approved recharges remain funding rather than revenue, and historical debits without source metadata are excluded from real revenue and shown as unclassified where useful.