---
name: Scheduled reminder delivery
description: Persistence and delivery rules for Admin and automatic scheduled-ride reminders.
---

Scheduled-booking reminders target only future bookings with an assigned Driver. Automatic delivery runs once within the 45-minute pre-pickup window; Admin delivery may explicitly resend. Persist `reminderSentAt`, `reminderLastSentAt`, a short `reminderInFlightAt` lease, count, and a safe error marker so concurrent workers do not duplicate automatic sends.

**Why:** Reminder delivery uses both Socket.io personal rooms and Expo push, and the process may restart or run on multiple workers. A client-only flag would cause missed or duplicate alerts.

**How to apply:** Keep the persisted claim/update flow authoritative. Treat a socket delivery as useful even when no Expo token exists, and never expose push tokens in Admin responses.