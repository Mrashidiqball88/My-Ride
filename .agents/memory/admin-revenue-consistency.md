---
name: Admin revenue consistency
description: Keep Overview revenue widgets and detailed schedules on the same platform-revenue calculation.
---

Admin Overview revenue must use the same fee and explicitly marked manual Long Range charge trend as the detailed revenue schedule. Ordinary rides have no platform commission, and approved Driver recharge payments are funding/advance deposits, not operating income.

**Why:** Grouping approved payments by update date creates sparse-date “income” rows, while generic historical Long Range debits can otherwise make percentage-era or ghost charges look like current platform revenue.

**How to apply:** Reuse the shared revenue analytics calculation for Overview and compatibility endpoints. Count only source-aware fee debits and explicitly marked manual Long Range charges; keep legacy/unmarked debits outside net revenue and show them as unclassified where useful. Preserve date-range filters, include zero-value calendar dates in trends, and keep advance deposits visible only in excluded-funding fields.