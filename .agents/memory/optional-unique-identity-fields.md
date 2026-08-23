---
name: Optional unique identity fields
description: Prevents duplicate-key errors when a unique sparse identity value is irrelevant to some account roles.
---

For a unique sparse identity field that applies only to one role, omit the field for every other role. Do not store `''` or another shared sentinel value.

**Why:** Databases enforce uniqueness for repeated empty strings, so a second Driver registration can fail even though Drivers do not provide a customer National ID.

**How to apply:** Set an inapplicable optional unique value to `undefined` or leave it out of the create/update payload; rely on the sparse index only for real identifiers.