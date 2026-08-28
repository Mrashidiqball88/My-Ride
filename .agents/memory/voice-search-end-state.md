---
name: Voice search end state
description: Browser SpeechRecognition result and end-event handling for the Customer location search.
---

One-shot SpeechRecognition can fire `onend` immediately after `onresult` or `onerror`; route transcripts directly into the location search handler, and never leave a failed recognition instance or end handler able to clear the visible match/error message.

**Why:** Clearing status in `onend` made successful voice searches look blank and hid actionable microphone errors even though the transcript and autocomplete result had already been produced. Reparented mobile inputs can also fail to route a synthetic `input` event, while a thrown `stop()` can strand the session.

**How to apply:** Call the shared location-search function directly from `onresult`, keep the canonical matched location in the input, retain result/error feedback after recognition ends, clear recognition references on errors, safely abort/stop stale instances, and use the timeout path separately for sessions that never produce a result.