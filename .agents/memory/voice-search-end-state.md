---
name: Voice search end state
description: Browser SpeechRecognition result and end-event handling for the Customer location search.
---

One-shot SpeechRecognition can fire `onend` immediately after `onresult` or `onerror`; the end handler must not clear the visible match or error message.

**Why:** Clearing status in `onend` made successful voice searches look blank and hid actionable microphone errors even though the transcript and autocomplete result had already been produced.

**How to apply:** Keep the canonical matched location in the input, retain result/error feedback after recognition ends, and use the timeout path separately for sessions that never produce a result.