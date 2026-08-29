---
name: Migration upsert timestamps
description: Mongoose timestamp middleware can conflict with legacy timestamp fields during role-partition migrations.
---

When copying legacy documents with `$setOnInsert`, disable automatic timestamps for that update if the source includes `createdAt` or `updatedAt`.

**Why:** Mongoose adds timestamp operators to upserts, and supplying the same timestamp path in `$setOnInsert` can make MongoDB reject the update as a path conflict.

**How to apply:** Preserve source timestamps explicitly in the insert payload and use the update option that disables schema timestamp injection for that migration operation.