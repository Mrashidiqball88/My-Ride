---
name: Driver alert recovery race
description: Reconnect recovery must account for a status refresh racing the initial socket rehydration query.
---

The server must queue a second driver rehydration pass when `driver:status` arrives during the initial reconnect read; otherwise a stale heartbeat result can suppress replay even though the client has just refreshed availability.

**Why:** Native and browser clients announce their persisted online state immediately after Socket.io connects, so the first DB read and the heartbeat refresh can legitimately overlap.

**How to apply:** Preserve queued recovery whenever changing driver reconnect, heartbeat, availability, or offer replay logic.