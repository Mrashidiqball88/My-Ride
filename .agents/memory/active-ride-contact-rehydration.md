---
name: Active ride contact rehydration
description: Contact actions must survive realtime status changes and active-ride restoration.
---

Customer and Driver contact actions must be rendered from the authoritative assigned ride snapshot for every non-terminal active status, including accepted, arrived, and in-progress.

**Why:** A client that only renders contacts during the initial acceptance event loses the controls after a refresh, reconnect, or direct restoration of an in-progress ride.

**How to apply:** Populate the opposing party's phone on the active ride response, normalize it once for both `tel:` and `https://wa.me/` targets, and rebuild the visible contact controls whenever an active ride snapshot or lifecycle status arrives.