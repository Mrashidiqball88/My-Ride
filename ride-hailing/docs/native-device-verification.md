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

The physical-device pass could not be executed in this workspace: no Android or
iOS phone, installed native build, or device-level notification/location
telemetry is attached. The entries below are therefore explicitly marked
**Not run**, not passed. The supporting implementation and automated contract
evidence is included to make the remaining hands-on work reproducible.

**Recorded:** 2026-08-22
**Tester:** Replit workspace (physical-device access unavailable)

| Scenario | Device / OS / build | Evidence (timestamp, ride ID, screenshot/log) | Pass/Fail | Tester |
| --- | --- | --- | --- | --- |
| Android locked location | Not available | Not run; physical Android lock-screen movement, foreground-service notification, and timestamped location update require hardware. Supporting configuration: `app.json` enables Android background location and foreground service; `background-location.ts` uses 25 m / 15 s updates. | Not run | Replit workspace |
| iOS locked location | Not available | Not run; physical iOS lock-screen movement, system location indicator, Settings permission state, and timestamped location update require hardware. Supporting configuration: `app.json` declares When In Use and Always location usage descriptions; `background-location.ts` enables the background indicator. | Not run | Replit workspace |
| Alert and matching offer | Not available | Not run; audible/vibration output and lock-screen tap-through require hardware. Supporting implementation uses an Android MAX channel, default sound, vibration pattern, ride-request category, and preserves the ride payload/ID when the alert opens. | Not run | Replit workspace |
| Network interruption | Not available | Not run; Wi-Fi/mobile-data switching and duplicate-visible-offer behavior require hardware. Supporting implementation enables infinite Socket.io reconnection, refreshes available rides on reconnect, and ignores a repeated offer with the same ride ID. | Not run | Replit workspace |
| Force-stop / permission revoke | Not available | Not run; Android force-stop/iOS termination, permission revocation, and the >90-second wait require hardware. Supporting server contract coverage verifies heartbeat persistence; the server eligibility window is 90 seconds and background location fails closed on 401/403. | Not run | Replit workspace |

## Sign-off status

**Not approved for production reliance on locked-screen tracking or push
alerts.** A tester must replace each “Not available”/“Not run” entry with the
device model, OS, native build, timestamp, ride ID, and screenshot or log after
completing the acceptance steps above. The automated server contract checks
remain regression coverage only; they do not close this physical-device gate.