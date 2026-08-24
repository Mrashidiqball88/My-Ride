---
name: Mockup preview routing
description: Keep canvas mockup previews reachable through the artifact-mounted Vite server.
---

Mockup sandbox previews must use the artifact's `/__mockup/` base route and a component registry that resolves `/preview/<group>/<component>` paths.

**Why:** When the Vite base and preview router do not agree with the artifact mount, browser module requests fall through to the root app or every preview silently renders the router fallback.

**How to apply:** After adding mockups, restart the sandbox workflow and verify a `/preview/` route in the artifact preview before marking canvas frames live.