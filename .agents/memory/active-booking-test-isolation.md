---
name: Active booking test isolation
description: How Customer ride-flow scenarios should model the one-active-ride rule.
---

Customer ride-flow scenarios that create more than one ride for the same passenger must cancel or complete the prior active ride before starting the next one, then wait for the Customer recovery state to settle.

**Why:** The production duplicate-booking guard intentionally rejects a second requested, accepted, arrived, or in-progress ride, and the launch/resume recovery lock can briefly block booking while the authoritative read is pending.

**How to apply:** In sequential browser scenarios, end the first ride through the API or UI, verify the active panel is cleared, wait for recovery to be idle after reload/resume, and only then click Book again.