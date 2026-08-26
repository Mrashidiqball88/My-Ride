---
name: Strict active-ride tracking
description: Active rides use one serialized three-second GPS publication cycle across web and native clients.
---

Active-ride tracking must have one serialized three-second lifecycle: acquire and publish at most one accepted GPS sample per tick, keep an in-flight read locked across stop/restart boundaries, and reconfigure native tracking back to availability mode when the ride ends.

**Why:** Reconnects, slow GPS reads, and slow route responses can otherwise create overlapping work, stale bursts, camera stutter, or leave an online driver on the high-frequency active configuration after completion.

**How to apply:** Keep socket reconnects idempotent, coalesce route requests while one is pending, and preserve the existing Pakistan server validation and manual-pan/follow guards.