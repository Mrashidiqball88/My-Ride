---
name: Customer email index policy
description: Preserve real-email uniqueness without rejecting multiple Customer records whose email is null.
---

Customer email uniqueness must use a partial index that only includes string email values. Legacy non-sparse `email_1` indexes must be removed before Customer migration or model queries run.

**Why:** A unique MongoDB index treats multiple explicit null values as duplicates, which can surface as an unrelated ride-operation failure when a Customer record is created.

**How to apply:** Keep the shared Driver/legacy identity rules unchanged, but give the Customer collection its own null-safe index policy and run the legacy-index cleanup at connection startup.