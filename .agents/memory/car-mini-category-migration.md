---
name: Car Mini category migration
description: Compatibility rule for the Car Mini AC and Car Mini Non-AC split.
---

Treat `Car Mini AC` and `Car Mini Non-AC` as the only canonical categories. Resolve the retired `Car Mini` value to `Car Mini Non-AC` for existing drivers, rides, matching, and new server responses.

**Why:** Historic records did not retain an air-conditioning attribute. Mapping the old value to one deterministic category avoids duplicate broadcasts and makes future AC/Non-AC pricing and eligibility independent.

**How to apply:** Preserve acceptance of the old value at server boundaries and copy a legacy Mini fare, daily-fee, or Long Range setting to both new settings only when an explicit split value is absent. New UI selections and persisted updates must use canonical values.