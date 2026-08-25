---
name: Identity image preflight
description: Safe handling of corrupt identity image uploads before OCR starts.
---

Validate decoded identity image bytes with the image processor before handing them to an OCR worker.

**Why:** OCR workers can emit asynchronous failures for corrupt but base64-shaped uploads after the request handler has otherwise caught its promise, which makes a normal verification rejection appear as a server/test failure.

**How to apply:** Keep strict data-URL validation at the request boundary, then verify that each image has readable dimensions before invoking OCR. Treat a failed preflight as a normal document-verification failure, not an internal error.