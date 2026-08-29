---
name: Admin wallet bonus separation
description: The boundary between manual Driver wallet credits and paid daily-fee access grants.
---

Manual Admin wallet bonuses and paid-fee extensions are separate operations. A wallet credit must update the Driver wallet ledger without changing `paidUntilDate`; a fee grant must update fee access without debiting or crediting the wallet.

**Why:** Admins need to add promotional funds without accidentally granting access, and to grant access without making a cash-wallet transaction. Keeping the actions separate also makes audit history and Driver notifications unambiguous.

**How to apply:** Use a dedicated wallet-credit action for numeric bonus amounts, and a separate server-authoritative duration/custom-date action for fee access. Keep both protected by the Driver-pass Admin permission.