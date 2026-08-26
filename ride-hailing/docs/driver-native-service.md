# Driver availability: native app and browser fallback

## Native My Ride Driver app

The Expo native Driver app is the supported experience for drivers who need to remain available while the screen is locked or the app is backgrounded.

For the required final physical-device pass, use the
[native driver device verification runbook](./native-device-verification.md).

- When a driver switches **Online**, Android starts an ongoing foreground-service notification and native background location updates.
- The service posts GPS updates and a heartbeat at controlled intervals. Availability expires server-side after a short grace window without an update, so a force-stopped or disconnected app fails closed rather than receiving rides indefinitely.
- Socket.io reconnects automatically. When the app reconnects it restores the matching vehicle room, refreshes currently available rides, and rejoins the active ride room when applicable.
- The server rehydrates active ride membership and replays still-open, eligible `ride:new` offers after reconnect. Replay is idempotent on the clients, so a Socket.io event, REST recovery, and push notification cannot create duplicate offer effects.
- Application heartbeats are acknowledged by the server and persisted separately from Socket.io connection state. Native background location refreshes the REST heartbeat, while the foreground runtime sends both Socket.io and REST heartbeats.
- High-priority Expo push notifications provide ride alerts, default sound, and vibration when the UI is backgrounded. Notification taps never trust cached ride details: the app rechecks `/api/rides/available` before restoring an offer.
- Account approval, wallet eligibility, and booking permissions are still verified by the server. A background client cannot bypass them.

### Platform requirements

Use an installed Android development/production build rather than a browser preview. Grant **precise location**, **Allow all the time**, and notification permissions. Android may let a user restrict the foreground-service notification or battery usage; the app deliberately respects those operating-system controls. On iOS, background location is governed by the user’s Always permission and the system’s background execution policies.

## Browser Driver page fallback

The existing `/driver` browser/PWA remains available for registration, document upload, and ordinary browser use. A browser cannot guarantee a permanent Android foreground service, uninterrupted location tracking, persistent Socket.io connection, or post-force-stop execution. Drivers who need dependable background availability should use the native My Ride Driver build.

While the page is visible or the browser permits timers to run, the fallback sends a 25-second REST heartbeat and maintains the Socket.io connection. `online` and `visibilitychange` events trigger socket reconnect, heartbeat, active-ride reconciliation, available-ride reconciliation, and Web Push re-registration. The service worker remains the background notification path.

## Delivery limits

The server treats `isOnline` as persisted availability but requires a `lastOnlineHeartbeat` no older than 90 seconds for ride eligibility. This prevents a force-stopped, disconnected, or permission-revoked client from receiving new rides indefinitely. No browser or native implementation can guarantee alerts after force-stop, revoked notification permission, Do Not Disturb, vendor battery restrictions, or loss of network service.