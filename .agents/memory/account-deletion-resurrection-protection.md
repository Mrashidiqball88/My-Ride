---
name: Account deletion resurrection protection
description: Durable rule for preventing deleted split-role accounts from returning through legacy migration or preview seeding.
---

Explicit Customer or Driver deletion must be treated as a durable data state, not only as removal from the current role collection. Delete the legacy source and related account-owned data, and preserve a tombstone that startup migration and configured demo/test seeders check before recreating identities.

**Why:** The role-partition migration can copy a surviving legacy `users` record back into `customers` or `drivers`, while preview upserts can recreate configured accounts after a restart.

**How to apply:** Any new migration, import, fixture, or seed path that can create Customer/Driver identities must honor the deletion tombstone before writing an account.