---
name: Draggable sheet geometry
description: Reliable snap-drag behavior for a panel that begins in a CSS-collapsed state.
---

When a draggable panel is initialized collapsed with animated `max-height`, derive its full draggable range from its `scrollHeight` before removing the collapsed class, and support both Pointer Events and standard mouse events.

**Why:** A synchronous visual measurement during the CSS transition can report the still-collapsed height, leaving a zero drag range even though the panel has hidden content.

**How to apply:** For future map sheets or bottom cards, calculate the expanded height before changing the snap class, disable the transition during an active drag, and only restore snap styling after the gesture ends.