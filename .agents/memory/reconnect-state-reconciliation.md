---
name: Reconnect state reconciliation
description: Realtime client recovery when events may have been missed during a transient disconnect
---

When a realtime client reconnects, reconcile any actionable local state with an authoritative server read instead of relying only on replayed socket events.

**Why:** Socket rooms do not replay events missed during a disconnect, so an object can be changed by another actor while the client still holds an actionable stale card or pending state.

**How to apply:** After reconnect and any server-side room rehydration, refetch the current user-scoped actionable records and clear local entries that are no longer present.