---
name: Draggable sheet geometry
description: Reliable snap-drag behavior for a panel that begins in a CSS-collapsed state.
---

When a draggable panel is initialized collapsed with animated `max-height`, derive its full draggable range from its `scrollHeight` before removing the collapsed class, and support both Pointer Events and standard mouse events.

**Why:** A synchronous visual measurement during the CSS transition can report the still-collapsed height, leaving a zero drag range even though the panel has hidden content.

**How to apply:** For future map sheets or bottom cards, calculate the expanded height before changing the snap class, disable the transition during an active drag, and only restore snap styling after the gesture ends.

For native map sheets, keep the pan responder on a dedicated handle inside a finite-height stage and keep the detail body in its own scroll view; do not attach the vertical responder to the map or the whole screen.

**Why:** A map WebView and the outer screen scroll container both need to retain their normal touch behavior, while the handle must have an unambiguous vertical gesture owner.

**How to apply:** Use a measured stage, animate a bounded translate offset between expanded/compact/collapsed snaps, and let buttons, PIN inputs, and map gestures remain outside the handle responder.