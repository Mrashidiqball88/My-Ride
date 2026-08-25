---
name: Mobile location search focus
description: Focus behavior for the Customer location search sheet on mobile browsers.
---

When opening the Customer location search sheet moves its active input into a new container, restore focus on the next animation frame.

**Why:** DOM reparenting can silently blur the input and dismiss the mobile keyboard, turning a normal search tap into a second-tap interaction.

**How to apply:** Detect whether the input was active before moving its wrapper. After the wrapper enters the sheet, schedule a focus restore with scrolling disabled; retain the normal drag and scroll behavior of the surrounding sheet.