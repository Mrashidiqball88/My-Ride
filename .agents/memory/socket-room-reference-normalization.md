---
name: Socket room reference normalization
description: Rules for constructing Socket.io personal and ride room names from MongoDB documents.
---

Normalize MongoDB references to their scalar identifier before constructing Socket.io room names; populated documents must never be interpolated directly into a room string.

**Why:** A populated passenger or Driver reference stringifies as `[object Object]`, silently sending lifecycle events away from the intended personal room while other notification paths may still work.

**How to apply:** Room emitters should accept both raw ObjectId/string references and populated objects by resolving `_id` (or `id`) first, then omit missing participant rooms rather than emitting malformed names.