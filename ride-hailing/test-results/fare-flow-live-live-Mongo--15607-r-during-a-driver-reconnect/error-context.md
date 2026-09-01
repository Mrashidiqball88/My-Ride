# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: fare-flow-live.spec.js >> live Mongo fare refresh >> clears a Highroof request after takeover during a driver reconnect
- Location: tests/fare-flow-live.spec.js:979:3

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
    12 × locator resolved to <div id="ride-request">…</div>
       - unexpected value "hidden"

```

```yaml
- text: H
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
  920  |           pickup = { lat: 31.5204, lng: 74.3587, address: 'Toyota pickup' };
  921  |           dropoffs[0] = { lat: 31.5304, lng: 74.3687, address: 'Toyota dropoff' };
  922  |           activeStops = 1;
  923  |           routeDistanceKm = 7;
  924  |         });
  925  |         await customerPage.locator(`.vehicle-btn[data-type="${category}"]`)
  926  |           .evaluate(button => button.click());
  927  |         const expectedFareLabel = `Rs ${expectedFare.toLocaleString()}`;
  928  |         await expect(customerPage.locator('#fare-suggested-val')).toHaveText(expectedFareLabel);
  929  |         await expect(customerPage.locator('#book-btn')).toBeVisible();
  930  | 
  931  |         await customerPage.locator('#book-btn').evaluate(button => button.click());
  932  |         const availableRides = await driverPage.evaluate(async () => {
  933  |           const response = await fetch('/api/rides/available', {
  934  |             headers: {
  935  |               authorization: `Bearer ${localStorage.getItem('rh_token')}`,
  936  |               'x-session-token': localStorage.getItem('rh_session')
  937  |             }
  938  |           });
  939  |           return response.json();
  940  |         });
  941  |         expect(availableRides).toHaveLength(1);
  942  |         expect(availableRides[0]).toMatchObject({
  943  |           vehicleType: category,
  944  |           fare: expectedFare
  945  |         });
  946  |         await expect(customerPage.locator('#ar-live-fare')).toHaveText(expectedFareLabel);
  947  |         const otherAvailableRides = await otherPage.evaluate(async () => {
  948  |           const response = await fetch('/api/rides/available', {
  949  |             headers: {
  950  |               authorization: `Bearer ${localStorage.getItem('rh_token')}`,
  951  |               'x-session-token': localStorage.getItem('rh_session')
  952  |             }
  953  |           });
  954  |           return response.json();
  955  |         });
  956  |         expect(otherAvailableRides).toEqual([]);
  957  |         const ride = await models.Ride.findOne({ passenger: customer._id, vehicleType: category })
  958  |           .sort({ createdAt: -1 }).lean();
  959  |         expect(ride).toBeTruthy();
  960  |         expect(ride.fare).toBe(expectedFare);
  961  | 
  962  |         // Assert the real Socket.io notification opened the production request
  963  |         // card and rendered the category-specific fare on the matching page.
  964  |         await expect(driverPage.locator('#ride-request')).toBeVisible();
  965  |         await expect(driverPage.locator('#rr-vehicle')).toHaveText(category);
  966  |         await expect(driverPage.locator('#rr-fare')).toHaveText(`Rs ${expectedFare.toLocaleString()}`);
  967  |         await Promise.all(unrelatedPages.map(page =>
  968  |           expect(page.locator('#ride-request')).toBeHidden()
  969  |         ));
  970  |       }
  971  |     } finally {
  972  |       await Promise.all([
  973  |         customerPage.close(), highroofPage.close(), coasterPage.close(), otherPage.close()
  974  |       ]);
  975  |       await request.dispose();
  976  |     }
  977  |   });
  978  | 
  979  |   test('clears a Highroof request after takeover during a driver reconnect', async ({ browser, playwright }) => {
  980  |     const customerToken = token(customer);
  981  |     const takeoverToken = token(highroofTakeoverDriver);
  982  |     const baseURL = `http://127.0.0.1:${httpServer.address().port}`;
  983  |     const request = await playwright.request.newContext({ baseURL });
  984  |     const highroofPage = await browser.newPage();
  985  |     const coasterPage = await browser.newPage();
  986  | 
  987  |     try {
  988  |       await Promise.all([
  989  |         openAuthenticatedClient(highroofPage, baseURL, '/driver', highroofDriver, token(highroofDriver)),
  990  |         openAuthenticatedClient(coasterPage, baseURL, '/driver', coasterDriver, token(coasterDriver))
  991  |       ]);
  992  |       await Promise.all([
  993  |         highroofPage.evaluate(() => toggleOnline(true)),
  994  |         coasterPage.evaluate(() => toggleOnline(true))
  995  |       ]);
  996  |       await expect.poll(() => highroofPage.evaluate(() => isOnline)).toBe(true);
  997  |       await expect.poll(() => coasterPage.evaluate(() => isOnline)).toBe(true);
  998  |       await expect.poll(() => io.sockets.adapter.rooms.get('drivers:Toyota Highroof')?.size || 0).toBeGreaterThan(0);
  999  |       await expect.poll(() => io.sockets.adapter.rooms.get('drivers:Toyota Saloon Coaster')?.size || 0).toBeGreaterThan(0);
  1000 |       // This driver intentionally has no browser page: the ride-recipient
  1001 |       // snapshot must still permit a real eligible driver to take over while
  1002 |       // the originally alerted driver is disconnected.
  1003 |       await models.User.updateOne({ _id: highroofTakeoverDriver._id }, {
  1004 |         $set: { isOnline: true, lastOnlineHeartbeat: new Date(), currentLocation: { lat: 31.5204, lng: 74.3587 } }
  1005 |       });
  1006 | 
  1007 |       const rideResponse = await request.post('/api/rides', {
  1008 |         headers: authHeaders(customer),
  1009 |         data: {
  1010 |           pickupLocation: { lat: 31.5204, lng: 74.3587, address: 'Highroof takeover pickup' },
  1011 |           dropoffLocation: { lat: 31.5304, lng: 74.3687, address: 'Highroof takeover dropoff' },
  1012 |           distance: 7,
  1013 |           vehicleType: 'Toyota Highroof',
  1014 |           fare: 1
  1015 |         }
  1016 |       });
  1017 |       expect(rideResponse.status()).toBe(201);
  1018 |       const ride = await rideResponse.json();
  1019 | 
> 1020 |       await expect(highroofPage.locator('#ride-request')).toBeVisible();
       |                                                           ^ Error: expect(locator).toBeVisible() failed
  1021 |       await expect(highroofPage.locator('#rr-vehicle')).toHaveText('Toyota Highroof');
  1022 |       await expect(coasterPage.locator('#ride-request')).toBeHidden();
  1023 | 
  1024 |       // The original driver misses ride:taken while its socket is down.
  1025 |       await highroofPage.evaluate(() => socket.disconnect());
  1026 |       await expect.poll(() => highroofPage.evaluate(() => socket.connected)).toBe(false);
  1027 | 
  1028 |       const accepted = await request.patch(`/api/rides/${ride._id}/accept`, {
  1029 |         headers: authHeaders(highroofTakeoverDriver)
  1030 |       });
  1031 |       expect(accepted.status()).toBe(200);
  1032 | 
  1033 |       await highroofPage.evaluate(() => socket.connect());
  1034 |       await expect.poll(() => highroofPage.evaluate(() => socket.connected)).toBe(true);
  1035 |       await expect(highroofPage.locator('#ride-request')).toBeHidden();
  1036 |       await expect.poll(() => highroofPage.evaluate(() => ({
  1037 |         pendingRide: !!pendingRide,
  1038 |         sentOffer: !!sentOffer,
  1039 |         activeRide: !!activeRide
  1040 |       }))).toEqual({ pendingRide: false, sentOffer: false, activeRide: false });
  1041 |       await expect.poll(async () => {
  1042 |         const available = await highroofPage.evaluate(async () => {
  1043 |           const response = await fetch('/api/rides/available', {
  1044 |             headers: {
  1045 |               authorization: `Bearer ${localStorage.getItem('rh_token')}`,
  1046 |               'x-session-token': localStorage.getItem('rh_session')
  1047 |             }
  1048 |           });
  1049 |           return response.json();
  1050 |         });
  1051 |         return available.some(availableRide => String(availableRide._id) === String(ride._id));
  1052 |       }).toBe(false);
  1053 |       await expect(coasterPage.locator('#ride-request')).toBeHidden();
  1054 |     } finally {
  1055 |       await Promise.all([highroofPage.close(), coasterPage.close()]);
  1056 |       await request.dispose();
  1057 |     }
  1058 |   });
  1059 | 
  1060 |   test('blocks an unrelated driver from reading a ride they do not own', async ({ playwright }) => {
  1061 |     const baseURL = `http://127.0.0.1:${httpServer.address().port}`;
  1062 |     const request = await playwright.request.newContext({ baseURL });
  1063 |     try {
  1064 |       const heartbeat = new Date();
  1065 |       await models.User.updateOne({ _id: matchingDriver._id }, {
  1066 |         $set: { isOnline: true, lastOnlineHeartbeat: heartbeat, currentLocation: { lat: 31.5204, lng: 74.3587 } }
  1067 |       });
  1068 |       await models.User.updateOne({ _id: otherDriver._id }, {
  1069 |         $set: {
  1070 |           isOnline: true,
  1071 |           vehicleType: 'Car Mini',
  1072 |           lastOnlineHeartbeat: heartbeat,
  1073 |           currentLocation: { lat: 40, lng: 40 }
  1074 |         }
  1075 |       });
  1076 |       const created = await request.post('/api/rides', {
  1077 |         headers: authHeaders(customer),
  1078 |         data: {
  1079 |           pickupLocation: { lat: 31.5204, lng: 74.3587, address: 'Private pickup' },
  1080 |           dropoffLocation: { lat: 31.5304, lng: 74.3687, address: 'Private dropoff' },
  1081 |           distance: 7,
  1082 |           vehicleType: 'Car Mini',
  1083 |           fare: 1
  1084 |         }
  1085 |       });
  1086 |       expect(created.status()).toBe(201);
  1087 |       const ride = await created.json();
  1088 | 
  1089 |       const unrelatedRead = await request.get(`/api/rides/${ride._id}`, {
  1090 |         headers: authHeaders(otherDriver)
  1091 |       });
  1092 |       expect(unrelatedRead.status()).toBe(403);
  1093 | 
  1094 |       const unrelatedAcceptance = await request.patch(`/api/rides/${ride._id}/accept`, {
  1095 |         headers: authHeaders(otherDriver)
  1096 |       });
  1097 |       expect(unrelatedAcceptance.status()).toBe(409);
  1098 | 
  1099 |       const notifiedAcceptance = await request.patch(`/api/rides/${ride._id}/accept`, {
  1100 |         headers: authHeaders(matchingDriver)
  1101 |       });
  1102 |       expect(notifiedAcceptance.status()).toBe(200);
  1103 | 
  1104 |       const passengerRead = await request.get(`/api/rides/${ride._id}`, {
  1105 |         headers: authHeaders(customer)
  1106 |       });
  1107 |       expect(passengerRead.status()).toBe(200);
  1108 |     } finally {
  1109 |       await request.dispose();
  1110 |     }
  1111 |   });
  1112 | 
  1113 |   test('tracks server-authoritative waiting time, updates the Customer fare, and charges it on completion', async ({ browser, playwright }) => {
  1114 |     const baseURL = `http://127.0.0.1:${httpServer.address().port}`;
  1115 |     const request = await playwright.request.newContext({ baseURL });
  1116 |     const adminJwt = token({ _id: new mongoose.Types.ObjectId(), role: 'admin', isAdmin: true, name: 'Admin' });
  1117 |     const customerPage = await browser.newPage();
  1118 |     const driverPage = await browser.newPage();
  1119 |     const pickup = { lat: 31.5204, lng: 74.3587, address: 'Waiting pickup' };
  1120 |     const dropoff = { lat: 31.5304, lng: 74.3687, address: 'Waiting drop-off' };
```