---
name: Native Urdu font shaping
description: The font and direction strategy for Urdu-capable Driver interfaces.
---

Load an Arabic/Urdu-capable font alongside the normal Latin Driver font and keep both behind the existing splash-screen font gate. Apply RTL direction and the Arabic font only to dynamic strings that contain Arabic-script characters; do not switch the entire English Driver layout to RTL.

**Why:** Urdu needs a font with the required joining forms plus an RTL text direction, while the Driver product labels, controls, numbers, and route chrome remain predominantly Latin and should keep their existing layout.

**How to apply:** For web Driver surfaces, keep MapLibre RTL text shaping enabled before map creation and mark dynamic location/passenger text with `dir="auto"`/bidi styling. For native Driver surfaces, preserve Inter for the regular UI and conditionally apply the loaded Noto Naskh Arabic family to Arabic-script dynamic labels.