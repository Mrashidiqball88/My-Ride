---
name: Admin auth shell visibility
description: Preventing the Admin application shell from appearing behind the login overlay across responsive layouts.
---

The unauthenticated Admin shell must have an explicit hidden auth state that takes precedence over responsive layout rules. The shell should become visible only when the authenticated state is applied during session boot.

**Why:** A later mobile media rule can override a base `display:none`, leaving the protected navigation and data shell visible behind the login screen after logout or reload.

**How to apply:** Use an auth-state class or equivalent high-specificity guard on the shell, add it only after session validation begins, and remove it during logout before returning to the Admin login route.