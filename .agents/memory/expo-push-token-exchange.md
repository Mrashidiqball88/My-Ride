---
name: Expo push token exchange
description: Expo notification token registration must distinguish raw device tokens from Expo service tokens.
---

Expo's addPushTokenListener emits the raw FCM/APNs device token. It must never be sent directly to an API that stores ExpoPushToken values; call getExpoPushTokenAsync again and register the returned Expo token.

**Why:** The native Driver server dispatches through Expo's push service, which rejects raw device tokens. Treating the listener payload as an Expo token silently breaks background alerts after token creation or rotation.

**How to apply:** Keep the native readiness gate dependent on successful Expo token registration, and ensure every token-refresh listener re-exchanges the device token before updating the Driver record.