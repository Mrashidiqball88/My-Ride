---
name: Native alert readiness
description: Durable rules for native Driver notification and background availability readiness.
---

Native Driver availability must remain blocked until notification access, background location, push registration, lock-screen readiness, and a foreground-service preflight all pass. Recheck them after returning from system settings and on app resume; take the Driver offline when a required capability is revoked or the service stops.

**Why:** Socket.io only covers connected foreground clients, while Expo Push requests can be suppressed by the OS or provider. A stale local Online flag must never imply that a locked-screen alert route or background heartbeat is still usable.

**How to apply:** Keep Socket.io and Expo Push complementary, deduplicate by the authoritative ride ID and expiry, and describe provider acceptance as a request—not proof of physical device display.