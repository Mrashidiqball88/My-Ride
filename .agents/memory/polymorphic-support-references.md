---
name: Polymorphic support references
description: Persistence rule for Mongoose documents whose user reference uses refPath.
---

When a document references multiple Mongoose models through `refPath`, always write the concrete model discriminator together with the reference.

**Why:** Mongoose cannot validate or populate a required polymorphic reference when its model discriminator is omitted, producing a server error at creation time.

**How to apply:** Derive the discriminator from the authenticated role on the server, never from an untrusted client payload, and keep the role and model mapping explicit.