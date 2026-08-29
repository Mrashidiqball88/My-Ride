---
name: Preview Admin credential authority
description: Authentication precedence for ephemeral demo databases and configured Admin secrets.
---

When environment-managed Admin credentials are configured, the environment password and recovery key are authoritative across preview and persistent MongoDB deployments; startup reconciles their bcrypt hashes and email metadata into `admin_security`. When those environment values are absent, valid database-managed credentials remain authoritative.

**Why:** Workspace secret changes must repair stale or missing restored hashes without exposing plaintext credentials, while absent environment values must not strand an intentionally database-managed Admin account.

**How to apply:** Keep environment values out of logs, responses, and MongoDB; invalidate existing Admin sessions when the persisted email or password hash changes; reject Admin UI password/recovery-key edits that cannot update the environment secret; cover both preview and persistent-database paths with regression tests.