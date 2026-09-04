---
name: Admin revenue consistency
description: Keep Overview revenue widgets and detailed schedules on the same platform-revenue calculation.
---

Admin Overview revenue must use the same settled fee and commission trend as the detailed revenue schedule. Approved Driver recharge payments are funding/advance deposits, not operating income, and must never be rendered as platform revenue.

**Why:** Grouping approved payments by update date creates sparse-date “income” rows and makes valid deposits look like ghost revenue when the detailed schedule excludes them from net revenue.

**How to apply:** Reuse the shared revenue analytics calculation for Overview and compatibility endpoints. Preserve date-range filters, include zero-value calendar dates in trends, and keep advance deposits visible only in their excluded-funding fields.