# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: fare-flow-live.spec.js >> live Mongo fare refresh >> removes a cancelled request and activates the winning Driver without a refresh
- Location: tests/fare-flow-live.spec.js:1015:3

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator:  locator('#ride-request')
Expected: visible
Received: hidden
Timeout:  5000ms

Call log:
  - Expect "toBeVisible" with timeout 5000ms
  - waiting for locator('#ride-request')
    13 × locator resolved to <div id="ride-request">…</div>
       - unexpected value "hidden"

```

```yaml
- text: M
- img "My Ride Driver"
- text: My Ride DRIVER 💰 Rs 1,000
- button "Menu": ⋮
- button "Drag map controls": ⠿
- 'button "You are Online ✓ Searching nearby ride requests Daily Fee: Not configured"'
- button "Refresh map and ride status": ↻
- region "Map"
- img "Map marker": P
- img "Map marker": "1"
- button "Zoom in"
- button "Zoom out"
- button "Toggle attribution"
- link "Mapbox homepage":
  - /url: https://www.mapbox.com/
- text: 0 Rides today Rs 1,000 Earnings 5.0 ⭐ Rating
- button "🏠 Home"
- button "💳 Payments"
- text: You are now Online
- button "Open Today's Fare": Today’s Fare
```

# Test source

```ts
  944  |         const available = await highroofPage.evaluate(async () => {
  945  |           const response = await fetch('/api/rides/available', {
  946  |             headers: {
  947  |               authorization: `Bearer ${localStorage.getItem('rh_token')}`,
  948  |               'x-session-token': localStorage.getItem('rh_session')
  949  |             }
  950  |           });
  951  |           return response.json();
  952  |         });
  953  |         return available.some(availableRide => String(availableRide._id) === String(ride._id));
  954  |       }).toBe(false);
  955  |       await expect(coasterPage.locator('#ride-request')).toBeHidden();
  956  |     } finally {
  957  |       await Promise.all([highroofPage.close(), coasterPage.close()]);
  958  |       await request.dispose();
  959  |     }
  960  |   });
  961  | 
  962  |   test('blocks an unrelated driver from reading a ride they do not own', async ({ playwright }) => {
  963  |     const baseURL = `http://127.0.0.1:${httpServer.address().port}`;
  964  |     const request = await playwright.request.newContext({ baseURL });
  965  |     try {
  966  |       const heartbeat = new Date();
  967  |       await models.User.updateOne({ _id: matchingDriver._id }, {
  968  |         $set: { isOnline: true, lastOnlineHeartbeat: heartbeat, currentLocation: { lat: 31.5204, lng: 74.3587 } }
  969  |       });
  970  |       await models.User.updateOne({ _id: otherDriver._id }, {
  971  |         $set: {
  972  |           isOnline: true,
  973  |           vehicleType: 'Car Mini',
  974  |           lastOnlineHeartbeat: heartbeat,
  975  |           currentLocation: { lat: 40, lng: 40 }
  976  |         }
  977  |       });
  978  |       const created = await request.post('/api/rides', {
  979  |         headers: authHeaders(customer),
  980  |         data: {
  981  |           pickupLocation: { lat: 31.5204, lng: 74.3587, address: 'Private pickup' },
  982  |           dropoffLocation: { lat: 31.5304, lng: 74.3687, address: 'Private dropoff' },
  983  |           distance: 7,
  984  |           vehicleType: 'Car Mini',
  985  |           fare: 1
  986  |         }
  987  |       });
  988  |       expect(created.status()).toBe(201);
  989  |       const ride = await created.json();
  990  | 
  991  |       const unrelatedRead = await request.get(`/api/rides/${ride._id}`, {
  992  |         headers: authHeaders(otherDriver)
  993  |       });
  994  |       expect(unrelatedRead.status()).toBe(403);
  995  | 
  996  |       const unrelatedAcceptance = await request.patch(`/api/rides/${ride._id}/accept`, {
  997  |         headers: authHeaders(otherDriver)
  998  |       });
  999  |       expect(unrelatedAcceptance.status()).toBe(409);
  1000 | 
  1001 |       const notifiedAcceptance = await request.patch(`/api/rides/${ride._id}/accept`, {
  1002 |         headers: authHeaders(matchingDriver)
  1003 |       });
  1004 |       expect(notifiedAcceptance.status()).toBe(200);
  1005 | 
  1006 |       const passengerRead = await request.get(`/api/rides/${ride._id}`, {
  1007 |         headers: authHeaders(customer)
  1008 |       });
  1009 |       expect(passengerRead.status()).toBe(200);
  1010 |     } finally {
  1011 |       await request.dispose();
  1012 |     }
  1013 |   });
  1014 | 
  1015 |   test('removes a cancelled request and activates the winning Driver without a refresh', async ({ browser, playwright }) => {
  1016 |     const customerToken = token(customer);
  1017 |     const matchingToken = token(matchingDriver);
  1018 |     const baseURL = `http://127.0.0.1:${httpServer.address().port}`;
  1019 |     const request = await playwright.request.newContext({ baseURL });
  1020 |     const driverPage = await browser.newPage();
  1021 | 
  1022 |     async function createRide(label) {
  1023 |       const response = await request.post('/api/rides', {
  1024 |         headers: authHeaders(customer),
  1025 |         data: {
  1026 |           pickupLocation: { lat: 31.5204, lng: 74.3587, address: `${label} pickup` },
  1027 |           dropoffLocation: { lat: 31.5304, lng: 74.3687, address: `${label} dropoff` },
  1028 |           distance: 7,
  1029 |           vehicleType: 'Car Mini',
  1030 |           fare: 1
  1031 |         }
  1032 |       });
  1033 |       expect(response.status()).toBe(201);
  1034 |       return response.json();
  1035 |     }
  1036 | 
  1037 |     try {
  1038 |       await openAuthenticatedClient(driverPage, baseURL, '/driver', matchingDriver, matchingToken);
  1039 |       await driverPage.evaluate(() => toggleOnline(true));
  1040 |       await expect.poll(() => driverPage.evaluate(() => isOnline)).toBe(true);
  1041 |       await expect.poll(() => io.sockets.adapter.rooms.get('drivers:Car Mini Non-AC')?.size || 0).toBeGreaterThan(0);
  1042 | 
  1043 |       const cancelledRide = await createRide('Instant cancellation');
> 1044 |       await expect(driverPage.locator('#ride-request')).toBeVisible();
       |                                                         ^ Error: expect(locator).toBeVisible() failed
  1045 |       // Browser automation does not grant notification/audio activation by
  1046 |       // default. Start the same request alert explicitly so cancellation
  1047 |       // verifies the cleanup path for an already-alerting offer.
  1048 |       await driverPage.evaluate(() => startRideAlert(pendingRide));
  1049 |       await expect.poll(() => driverPage.evaluate(rideId => ({
  1050 |         pending: String(pendingRide?.id || pendingRide?._id) === String(rideId),
  1051 |         alerting: !!alertInterval
  1052 |       }), cancelledRide._id)).toEqual({ pending: true, alerting: true });
  1053 | 
  1054 |       const cancelled = await request.patch(`/api/rides/${cancelledRide._id}/cancel`, {
  1055 |         headers: authHeaders(customer)
  1056 |       });
  1057 |       expect(cancelled.status()).toBe(200);
  1058 |       await expect(driverPage.locator('#ride-request')).toBeHidden();
  1059 |       await expect.poll(() => driverPage.evaluate(() => ({
  1060 |         pendingRide: !!pendingRide,
  1061 |         sentOffer: !!sentOffer,
  1062 |         alertInterval: !!alertInterval,
  1063 |         notification: !!rideNotification
  1064 |       }))).toEqual({ pendingRide: false, sentOffer: false, alertInterval: false, notification: false });
  1065 | 
  1066 |       const acceptedRide = await createRide('Instant acceptance');
  1067 |       await expect(driverPage.locator('#ride-request')).toBeVisible();
  1068 |       const accepted = await request.patch(`/api/rides/${acceptedRide._id}/accept`, {
  1069 |         headers: authHeaders(matchingDriver)
  1070 |       });
  1071 |       expect(accepted.status()).toBe(200);
  1072 |       await expect(driverPage.locator('#ride-request')).toBeHidden();
  1073 |       await expect(driverPage.locator('#active-panel')).toBeVisible();
  1074 |       await expect.poll(() => driverPage.evaluate(rideId =>
  1075 |         String(activeRide?._id) === String(rideId), acceptedRide._id
  1076 |       )).toBe(true);
  1077 |     } finally {
  1078 |       await driverPage.close();
  1079 |       await request.dispose();
  1080 |     }
  1081 |   });
  1082 | 
  1083 |   test('loads Mapbox maps without Leaflet or legacy raster map providers', async ({ browser }) => {
  1084 |     const baseURL = `http://127.0.0.1:${httpServer.address().port}`;
  1085 |     const context = await browser.newContext({
  1086 |       viewport: { width: 430, height: 900 },
  1087 |       deviceScaleFactor: 2
  1088 |     });
  1089 |     const customerPage = await context.newPage();
  1090 |     const driverPage = await context.newPage();
  1091 | 
  1092 |     try {
  1093 |       await Promise.all([
  1094 |         openAuthenticatedClient(customerPage, baseURL, '/customer', customer, token(customer)),
  1095 |         openAuthenticatedClient(driverPage, baseURL, '/driver', matchingDriver, token(matchingDriver))
  1096 |       ]);
  1097 |       await Promise.all([
  1098 |         customerPage.evaluate(() => { if (!map) initMap(); }),
  1099 |         driverPage.evaluate(() => { if (!map) initMap(); })
  1100 |       ]);
  1101 |       await Promise.all([
  1102 |         customerPage.waitForFunction(() => map?.isStyleLoaded() === true),
  1103 |         driverPage.waitForFunction(() => map?.isStyleLoaded() === true)
  1104 |       ]);
  1105 | 
  1106 |       const mapDetails = await Promise.all([customerPage, driverPage].map(page =>
  1107 |         page.evaluate(() => ({
  1108 |           hasMapbox: Boolean(window.mapboxgl),
  1109 |           styleUrl: map?.getStyle()?.name || '',
  1110 |           canvas: Boolean(document.querySelector('#map .mapboxgl-canvas')),
  1111 |           legacyMapNodes: document.querySelectorAll('#map [class*="maplibre"], #map [class*="leaflet"]').length
  1112 |         }))
  1113 |       ));
  1114 |       for (const details of mapDetails) {
  1115 |         expect(details.hasMapbox).toBe(true);
  1116 |         expect(details.styleUrl).toBeTruthy();
  1117 |         expect(details.canvas).toBe(true);
  1118 |         expect(details.legacyMapNodes).toBe(0);
  1119 |       }
  1120 |     } finally {
  1121 |       await context.close();
  1122 |     }
  1123 |   });
  1124 | });
  1125 | 
```