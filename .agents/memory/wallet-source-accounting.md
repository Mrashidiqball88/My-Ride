---
name: Wallet source accounting
description: Durable rules for separating Driver wallet funding sources from real platform revenue.
---

Wallet debits must record their funding source and split real-cash and bonus portions when a debit is mixed. New daily fees and Long Range commissions consume bonus balance first, then real cash. Real-funded credits include approved Driver recharges and settled ride earnings; Admin bonuses remain bonus-funded.

**Why:** Aggregate wallet balance and cumulative credit-origin totals cannot identify which source paid a later debit. Counting all fee debits as revenue would overstate real platform earnings when promotional credits fund them.

**How to apply:** Admin revenue reports count only the real portion of source-aware fee/commission debits. Bonus-funded portions belong in Bonus / Non-Revenue Earnings, approved recharges remain funding rather than revenue, and historical debits without source metadata are excluded from real revenue and shown as unclassified where useful.