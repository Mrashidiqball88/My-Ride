---
name: Customer PWA shell updates
description: Cache-version handling for urgent Customer portal HTML and JavaScript repairs.
---

When Customer portal HTML or inline JavaScript is repaired, increment the Customer Service Worker cache version in the same release.

**Why:** A previously cached Customer shell can continue serving a broken script after the source file is fixed, leaving global auth handlers undefined for existing PWA sessions.

**How to apply:** Keep the Service Worker cache version as a release boundary for Customer shell repairs, then restart the workflow and test from a fresh browser context.