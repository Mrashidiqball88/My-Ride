---
name: Driver recharge amounts
description: Separates the Admin-controlled Daily Fee indicator from Driver wallet recharge amounts
---

The Admin-controlled Daily Fee is informational in the Driver recharge form. It must be displayed separately in the Driver operations sheet, while the recharge amount remains a user-entered positive amount and is persisted as submitted.

**Why:** A fixed fee in the editable payment field prevents Drivers from depositing more than the Daily Fee and conflates fee policy with wallet funding.

**How to apply:** Read the current fee from the existing Admin settings endpoint for display and fee eligibility; never populate or lock the recharge input with that value, and do not replace the submitted amount with the fee on the server.