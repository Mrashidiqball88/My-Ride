---
name: Admin permission refresh
description: Durable client/server rule for keeping Sub-Admin visibility current after permission edits.
---

Sub-Admin pages must refresh the current permission set from the server during every admin boot, rather than trusting only permissions captured at login.

**Why:** Permission changes are persisted independently of the browser token, and stale client flags can expose or hide restricted navigation and actions after a refresh.

**How to apply:** Keep the session refresh behind the existing admin authentication middleware and apply its response before loading permission-gated sections or rendering sensitive payment proof links.