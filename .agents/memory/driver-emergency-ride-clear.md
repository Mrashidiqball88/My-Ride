---
name: Driver emergency ride clear
description: Local recovery path for a Driver screen stuck on a pending or active ride.
---

The Driver emergency bypass is a continuous five-second hold on the existing Reject/Cancel control. It must clear pending, sent-offer, and active local ride state immediately without waiting for a backend cancellation response, while leaving the Driver's availability mode intact.

**Why:** A Customer device can disappear or a backend request can block, leaving the Driver unable to return to an available dashboard through the normal cancellation flow.

**How to apply:** Stop alerts/timers and navigation tracking, clear persisted active-ride state and owned map UI, suppress the synthetic click after a completed hold, and keep normal short-tap rejection/cancellation behavior unchanged.