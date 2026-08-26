---
name: PWA shell updates
description: Cache-version handling for urgent Customer and Driver portal HTML and JavaScript repairs.
---

When Customer or Driver portal HTML or inline JavaScript is repaired, increment the shared Service Worker cache version in the same release.

**Why:** A previously cached portal shell can continue serving stale map configuration or broken scripts after the source file is fixed, leaving existing PWA sessions on the old experience.

**How to apply:** Keep the Service Worker cache version as a release boundary for portal shell repairs, then restart the workflow and test from a fresh browser context. Validate map providers by inspecting actual loaded tile images, not only their HTTP status, because a provider can return an error watermark as an image.