---
name: Active ride contact rehydration
description: Contact actions must survive realtime status changes and active-ride restoration.
---

Customer and Driver contact actions must be rendered from the authoritative assigned ride snapshot for every non-terminal active status, including accepted, arrived, and in-progress.

**Why:** A client that only renders contacts during the initial acceptance event loses the controls after a refresh, reconnect, or direct restoration of an in-progress ride.

**How to apply:** Populate the opposing party's phone on the active ride response, normalize it once for both `tel:` and `https://wa.me/` targets, and rebuild the visible contact controls whenever an active ride snapshot or lifecycle status arrives.

When a populated opposing reference is missing because the record lives in a legacy alternate collection, recover the raw participant ID from the Ride document before resolving the contact through the partition-aware User facade.

**Why:** Mongoose population can turn an assigned legacy-partition reference into a null UI object even though the ride and account are valid.

**How to apply:** Treat the raw Ride reference plus the authoritative User lookup as the source of contact identity; direct validated anchors are the most reliable web/native bridge for `tel:` and WhatsApp actions.