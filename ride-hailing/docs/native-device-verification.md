# Native driver device verification

This runbook is for the final physical-device pass. A browser preview or
simulator cannot prove Android/iOS lock-screen execution, notification
sound/vibration, radio recovery, or force-stop behavior.

## Test setup

- Use an installed native development or production build of **My Ride Driver**.
- Use one approved driver with a non-negative wallet balance and one customer
  account on a second device or browser.
- Grant precise location, **Allow all the time** (Android), **Always** (iOS),
  and notification permissions.
- Record the device model, OS version, app build, network used, and timestamp
  for every run.
- Keep the driver online only during the test. Turn the driver offline and
  confirm the status before moving to the next scenario.

## Acceptance matrix

### Android: locked-screen location

1. Start the app, grant the permissions above, and switch the driver **Online**.
2. Confirm the Android foreground-service notification is visible.
3. Lock the phone for at least five minutes while moving it more than 25 meters.
4. From the customer side, create or monitor an active ride.
5. Pass when the server/customer receives location updates while locked and the
   driver remains eligible for new rides.
6. Record a timestamped location update and a screenshot of the foreground
   service notification.

### iOS: locked-screen location

1. Switch the driver **Online** and confirm the system location indicator is
   visible.
2. Lock the phone for at least five minutes while moving it more than 25 meters.
3. Confirm the customer receives current driver locations and the driver
   remains eligible for new rides.
4. Record a timestamped location update and the permission state shown in
   Settings.

### New-ride alert and matching offer

1. Leave the driver online with the screen locked/backgrounded.
2. Create a ride matching the driver's vehicle category.
3. Pass when the phone produces sound and vibration, and opening the alert
   displays the same ride ID, pickup, drop-off, and fare as the customer request.
4. Create a second matching ride only after dismissing or accepting the first;
   confirm the offer does not show a different ride's details.

### Wi-Fi/mobile-data interruption

1. Leave the driver online and background the app.
2. Disable Wi-Fi (and use mobile data), then restore Wi-Fi; repeat in the
   opposite direction if the device supports both networks.
3. Pass when the connection returns, the driver remains online, available rides
   are refreshed, and one ride produces at most one visible offer.
4. Accept the offer and confirm the active ride is not duplicated after
   reconnecting.

### Force-stop and revoked permission fail closed

1. Switch the driver online, then force-stop the app from Android Settings (or
   swipe-terminate the iOS app where applicable).
2. Wait longer than the 90-second server heartbeat grace period.
3. Pass when the driver no longer appears eligible for new rides and receives
   no new offer.
4. Separately revoke background/Always location permission, relaunch the app,
   and confirm the driver cannot remain reliably online or receive new rides.
5. Restore permission and explicitly switch online again before continuing.

## Verification record

The physical-device pass could not be executed in this workspace. No Android or
iOS phone, installed native development/production build, customer/driver test
accounts, or device-level notification/location telemetry is attached. The
entries below are therefore marked **Blocked — no device evidence**, not
passed. This is a production-gate rejection, not an assertion that the native
behaviour works. The supporting implementation and automated contract evidence
make the remaining hands-on work reproducible.

**Recorded:** 2026-08-22
**Validation attempt:** 2026-08-22T15:35:32Z
**Tester:** Replit workspace (physical-device access unavailable)
**Available device inventory:** Expo reported zero attached devices
(`artifacts/myride-driver-mobile/.expo/devices.json`).
**Automated evidence:** driver app typecheck passed; Android and iOS Expo
bundles/manifests built successfully from SDK 54; resolved config includes
Android background location/foreground service permissions, iOS location usage
descriptions, and the iOS background-location flag; the 20 native
availability/location/fare contract tests passed. The running workflow is
Expo Go, and the build output is an Expo Go/static bundle, not an approved
native device build, so it cannot satisfy the scenarios below.

| Scenario | Device / OS / build | Evidence (timestamp, ride ID, screenshot/log) | Pass/Fail | Tester |
| --- | --- | --- | --- | --- |
| Android locked location | No approved Android device or native build available | **Blocked — no device evidence** (2026-08-22T15:31:49Z); no lock-screen movement, foreground-service notification screenshot, ride ID, or timestamped GPS update can be recorded in this workspace. Supporting config enables Android background location and foreground service; background updates request 25 m / 15 s intervals. | Blocked | Replit workspace |
| iOS locked location | No approved iOS device or native build available | **Blocked — no device evidence** (2026-08-22T15:31:49Z); no lock-screen movement, system location indicator, Settings permission screenshot, ride ID, or timestamped GPS update can be recorded in this workspace. Supporting config declares When In Use and Always usage descriptions and enables the background indicator. | Blocked | Replit workspace |
| Alert and matching offer | No approved Android/iOS device or native build available | **Blocked — no device evidence** (2026-08-22T15:31:49Z); sound, vibration, lock-screen tap-through, ride ID, pickup/drop-off, and fare cannot be observed or captured. Supporting implementation schedules a default-sound ride-request notification and retains the ride payload when opened. | Blocked | Replit workspace |
| Network interruption | No approved Android/iOS device or native build available | **Blocked — no device evidence** (2026-08-22T15:31:49Z); Wi-Fi/mobile-data switching, reconnect timing, duplicate visible offers, and an accepted ride ID cannot be observed or logged. Supporting implementation enables Socket.io reconnection and refreshes available rides after reconnect. | Blocked | Replit workspace |
| Force-stop / permission revoke | No approved Android/iOS device or native build available | **Blocked — no device evidence** (2026-08-22T15:31:49Z); force-stop/termination, permission revocation, the >90-second wait, and absence of a new offer cannot be observed or captured. Supporting server contracts verify heartbeat persistence; background GPS fails closed on 401/403. | Blocked | Replit workspace |

## Sign-off status

**Not approved for production reliance on locked-screen tracking or push
alerts.** A tester must replace each **Blocked** entry with the device model,
OS, native build, timestamp, ride ID, and screenshot or log after completing
the acceptance steps above. The automated server contract checks remain
regression coverage only; they do not close this physical-device gate. Task
completion is blocked until approved Android and iOS phones and a qualified
native build are available.