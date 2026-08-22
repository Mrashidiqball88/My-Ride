# Driver availability: native app and browser fallback

## Native My Ride Driver app

The Expo native Driver app is the supported experience for drivers who need to remain available while the screen is locked or the app is backgrounded.

- When a driver switches **Online**, Android starts an ongoing foreground-service notification and native background location updates.
- The service posts GPS updates and a heartbeat at controlled intervals. Availability expires server-side after a short grace window without an update, so a force-stopped or disconnected app fails closed rather than receiving rides indefinitely.
- Socket.io reconnects automatically. When the app reconnects it restores the matching vehicle room, refreshes currently available rides, and rejoins the active ride room when applicable.
- High-priority Expo push notifications provide ride alerts, default sound, and vibration when the UI is backgrounded. An incoming notification carries the ride details so opening the app restores the offer.
- Account approval, wallet eligibility, and booking permissions are still verified by the server. A background client cannot bypass them.

### Platform requirements

Use an installed Android development/production build rather than a browser preview. Grant **precise location**, **Allow all the time**, and notification permissions. Android may let a user restrict the foreground-service notification or battery usage; the app deliberately respects those operating-system controls. On iOS, background location is governed by the user’s Always permission and the system’s background execution policies.

## Browser Driver page fallback

The existing `/driver` browser/PWA remains available for registration, document upload, and ordinary browser use. A browser cannot guarantee a permanent Android foreground service, uninterrupted location tracking, persistent Socket.io connection, or post-force-stop execution. Drivers who need dependable background availability should use the native My Ride Driver build.