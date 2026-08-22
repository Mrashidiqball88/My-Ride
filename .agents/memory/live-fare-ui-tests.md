---
name: Live fare UI tests
description: Guidance for browser coverage of fare refresh behavior across customer and driver clients.
---

Live fare tests should authenticate the real customer and driver pages, put each into the visible fare state, and assert both the initial and refreshed DOM amounts. Keep a separate vehicle-category client subscribed to verify that unrelated clients remain unchanged.

**Why:** Socket payload assertions can pass while the application fails to render the refreshed fare in the user-facing card.

**How to apply:** When extending fare refresh coverage, use the page’s application socket and actual UI state rather than a test-only socket/page substitute.