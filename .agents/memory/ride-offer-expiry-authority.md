---
name: Ride offer expiry authority
description: Rules for keeping Driver offer windows consistent across realtime, push, and reconnect paths.
---

Persist each ride's offer duration and absolute expiry at request creation, then make
every delivery and recovery path use that expiry.

**Why:** A client-side timer resets after reconnects, duplicate Socket.io events, or
push-notification opens, allowing stale offers to look actionable.

**How to apply:** New offer channels must carry the persisted expiry metadata, and
server-side accept/counter operations must reject offers after it. Admin setting
changes apply only to future requests; existing requests retain their original window.