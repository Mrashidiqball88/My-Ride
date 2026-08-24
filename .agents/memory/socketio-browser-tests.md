---
name: Socket.io browser tests
description: Durable setup constraint for browser tests that exercise Socket.io rooms.
---

Live Socket.io tests must start the exported HTTP server instance that has Socket.io attached, rather than calling `app.listen()` on the Express app alone.

**Why:** Express can serve the page successfully while a separate listener leaves the browser's Socket.io client disconnected, masking room-delivery behavior.

**How to apply:** When a test imports an Express app and Socket.io server separately, start the Socket.io-backed server and use its bound port for both browser navigation and API requests.

Browser fixtures for protected apps must also place the current session token in local storage before navigation and include it in direct API-request headers.

**Why:** A valid JWT alone is intentionally insufficient under single-device session validation; pages can stay at the sign-in shell and direct requests can be rejected despite a valid account fixture.

**How to apply:** Use the same active session token for the socket auth payload, browser storage, and HTTP requests created by the live test harness.