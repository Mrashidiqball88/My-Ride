---
name: Paid-until access authority
description: Server-side fee-pass rule for Admin-granted paid periods.
---

Any valid future `paidUntilDate` is an active online fee pass, independent of `isFreeTrial` and real-cash wallet state.

**Why:** Admin-granted custom extensions previously updated only the date, so online entry still fell through to wallet charging and could block the Driver.

**How to apply:** Check the server-authoritative date before reading or debiting the fee wallet; after expiry, resume the normal daily-fee path.