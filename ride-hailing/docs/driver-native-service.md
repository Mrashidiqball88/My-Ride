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
- The native app blocks the Online control until its readiness gate passes: notification permission, the maximum-importance public Android ride-alert channel where supported, precise foreground and background location, successful Expo token registration, and the Driver's explicit lock-screen-alert confirmation. Returning from Settings or a background/foreground transition rechecks these conditions.
- Socket.io and Expo Push carry the same server-issued ride ID and expiry. The native runtime coalesces both paths, so a connected socket plus the matching push alert produces one actionable offer rather than two cards. If the background location service cannot start or a required permission is later revoked, availability is taken offline and the server heartbeat grace period fails closed.
- Account approval, wallet eligibility, and booking permissions are still verified by the server. A background client cannot bypass them.

### Platform requirements

Use an installed Android development/production build rather than a browser preview. Complete the in-app alert setup before switching Online: grant **precise location**, **Allow all the time**, notification permission, and lock-screen visibility, then tap the confirmation only after checking the device Settings screen. Android may let a user restrict the foreground-service notification or battery usage; the app deliberately respects those operating-system controls. On iOS, background location is governed by the user’s Always permission and the system’s background execution policies; iOS does not expose a lock-screen visibility flag to Expo, so the app requires the Driver’s explicit Settings confirmation instead of pretending it can verify that OS setting.

## Browser Driver page fallback

The existing `/driver` browser/PWA remains available for registration, document upload, and ordinary browser use. A browser cannot guarantee a permanent Android foreground service, uninterrupted location tracking, persistent Socket.io connection, or post-force-stop execution. Drivers who need dependable background availability should use the native My Ride Driver build.

While the page is visible or the browser permits timers to run, the fallback sends a 25-second REST heartbeat and maintains the Socket.io connection. `online` and `visibilitychange` events trigger socket reconnect, heartbeat, active-ride reconciliation, available-ride reconciliation, and Web Push re-registration. The service worker remains the background notification path.

## Delivery limits

The server treats `isOnline` as persisted availability but requires a `lastOnlineHeartbeat` no older than 90 seconds for ride eligibility. Expo Push requests are retried once for transient provider failures and invalid `DeviceNotRegistered` tokens are removed. This prevents a force-stopped, disconnected, or permission-revoked client from receiving new rides indefinitely. No browser or native implementation can guarantee alerts after force-stop, revoked notification permission, Do Not Disturb, vendor battery restrictions, provider failure, or loss of network service; a successful push request is not proof that a physical device displayed the alert.