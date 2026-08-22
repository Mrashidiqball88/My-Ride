---
name: Socket.io browser tests
description: Durable setup constraint for browser tests that exercise Socket.io rooms.
---

Live Socket.io tests must start the exported HTTP server instance that has Socket.io attached, rather than calling `app.listen()` on the Express app alone.

**Why:** Express can serve the page successfully while a separate listener leaves the browser's Socket.io client disconnected, masking room-delivery behavior.

**How to apply:** When a test imports an Express app and Socket.io server separately, start the Socket.io-backed server and use its bound port for both browser navigation and API requests.