---
name: Workspace security scan gate
description: How to interpret dependency findings across the Ride Hailing workspace before production release
---

Run dependency, SAST, and privacy/dataflow scans against the whole workspace before a production release. Dependency results may include the web server, API artifact, native Driver artifact, and development tooling rather than only the Ride Hailing package.

**Why:** A clean application-specific test suite does not prove that every installed workspace package is safe; direct upgrades can also affect native tooling or transitive dependency trees.

**How to apply:** For each high or critical advisory, identify the owning package and whether it is direct or transitive, upgrade the narrowest compatible parent, rerun all application tests and all scanners, and document any remaining launch blocker instead of masking it with an override.