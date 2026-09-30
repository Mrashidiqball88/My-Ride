---
name: Native verification camera chooser
description: Camera file inputs require native capture routing and independently owned permission callbacks.
---

Treat explicit image capture as a camera-only operation. Permission denial, interrupted prompts, or missing camera handlers must settle the upload callback, not fall back to Gallery.

**Why:** The shared Android wrapper discarded HTML capture hints and always opened documents. Separately, react-native-webview 13.15.0 does not request missing CAMERA permission for a capture file input. Its media permission listener owns getUserMedia callbacks and cannot safely own file-capture results as well.

**How to apply:** Keep capture and gallery intents separate; keep file-permission callback ownership separate from microphone/media requests while serializing OS prompts. Test callback settlement and retries as well as grant. These fixes require native rebuild/install; web refresh, Expo Go, and JavaScript OTA cannot update installed native chooser code.