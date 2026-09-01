---
name: Late database attachment
description: Runtime behavior when tests attach an in-memory database after importing the server module.
---

When a test connects Mongoose after importing the server, startup-time database flags can remain false even though the connection is ready. Runtime paths that gate persistence or broadcasts should account for the live connection state.

**Why:** Browser tests import the app before creating MongoMemoryServer, while production initializes the database during startup.

**How to apply:** For request-time database-dependent behavior, including cached waiting-rate configuration, prefer the current Mongoose connection readiness alongside any startup health flag.