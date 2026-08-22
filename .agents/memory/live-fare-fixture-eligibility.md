---
name: Live fare fixture eligibility
description: Durable setup requirements for browser tests that exercise live ride fare broadcasts.
---

Live fare browser fixtures must satisfy the same eligibility rules as production: the driver needs a nearby current location, a wallet eligible for the daily fee, and a live vehicle-room connection before ride creation.

**Why:** Ride broadcasts are filtered by persisted driver location, account/payment eligibility, and Socket.io room membership; checking only `isOnline` can create a false-negative test.

**How to apply:** Seed those fields and wait for the actual room/eligibility state. When rendering a pre-created ride in the driver page, use the broadcast payload's `id` shape so fare-update handlers can match it.