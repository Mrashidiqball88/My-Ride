---
name: Preview Admin credential authority
description: Authentication precedence for ephemeral demo databases and configured Admin secrets.
---

In a non-production preview with demo accounts enabled and no MongoDB URI, the configured Admin password secret is authoritative even if the ephemeral Settings collection contains an older password hash. A real MongoDB deployment must continue to use the persisted password hash as the authority.

**Why:** Workspace secret changes are the intended recovery mechanism for the ephemeral preview, while allowing an old in-memory hash to win creates a misleading “password rejected” loop after a restart or reset.

**How to apply:** Keep the preview-only condition explicit and covered by a regression test that seeds a stale hash, rejects the old password, and accepts the configured current secret. Do not broaden this override to production persistence.