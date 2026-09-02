---
name: Expo local image parser
description: Constraint for local image-size replacements used by Expo Metro
---

Local replacements for image-size used by Expo Metro must accept both filesystem paths and byte buffers. Metro commonly passes the asset path for ordinary images and only supplies bytes for zipped assets.

**Why:** A parser that only handles buffers appears correct in isolated unit checks but fails during real Expo bundling with an unsupported-format error.

**How to apply:** When changing the safe parser or Metro dependency override, test it with both a path and a Buffer, then run an actual iOS and Android Metro bundle.