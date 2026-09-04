---
name: Model facade query support
description: The project’s exported model facade does not expose every native Mongoose model helper.
---

Use the facade’s supported query chains, such as find(...).select(...).lean(), instead of assuming helpers like distinct() are available.

**Why:** Admin wallet aggregation initially failed because the facade omitted distinct(), even though the underlying Mongoose API supports it.

**How to apply:** When adding server queries through exported models, prefer existing facade patterns and verify the exact method exists before using a native-model convenience helper.