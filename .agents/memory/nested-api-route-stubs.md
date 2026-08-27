---
name: Nested API route stubs
description: Matching nested API endpoints in Playwright request interception.
---

When a browser test stubs both a base endpoint and a nested endpoint, use an explicit nested-path pattern or a regex rather than assuming a trailing glob matches every slash-separated path.

**Why:** A geocode stub intended for both forward search and reverse lookup matched the query-string form but missed the nested reverse path, causing the test to exercise the real authenticated route and report a misleading product failure.

**How to apply:** Include the optional nested segment in the matcher and verify the request path before diagnosing client state or server behavior.