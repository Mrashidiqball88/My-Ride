---
name: Admin deep-link guards
description: Durable rules for protecting Admin section deep links and hash navigation.
---

Admin section routing must authorize both initial URL fragments and later hash changes before activating a panel or invoking its data loader. A denied route should clear the fragment and select a permitted fallback.

**Why:** Browser navigation to a hash-only URL does not reload the document, so guarding only initial boot leaves bookmarked or manually changed routes inconsistent.

**How to apply:** Route every section entry point through the same access check, including sidebar clicks, startup fragments, and hashchange events.