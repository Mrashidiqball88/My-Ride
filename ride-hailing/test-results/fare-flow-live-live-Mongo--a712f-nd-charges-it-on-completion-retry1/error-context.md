# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: fare-flow-live.spec.js >> live Mongo fare refresh >> tracks server-authoritative waiting time, updates the Customer fare, and charges it on completion
- Location: tests/fare-flow-live.spec.js:1113:3

# Error details

```
Error: expect(received).toBeGreaterThan(expected)

Expected: > 0
Received:   0
```

# Test source

```ts
  1113 |   test('tracks server-authoritative waiting time, updates the Customer fare, and charges it on completion', async ({ browser, playwright }) => {
  1114 |     const baseURL = `http://127.0.0.1:${httpServer.address().port}`;
  1115 |     const request = await playwright.request.newContext({ baseURL });
  1116 |     const adminJwt = token({ _id: new mongoose.Types.ObjectId(), role: 'admin', isAdmin: true, name: 'Admin' });
  1117 |     const customerPage = await browser.newPage();
  1118 |     const driverPage = await browser.newPage();
  1119 |     const pickup = { lat: 31.5204, lng: 74.3587, address: 'Waiting pickup' };
  1120 |     const dropoff = { lat: 31.5304, lng: 74.3687, address: 'Waiting drop-off' };
  1121 |     const waitingSettings = Object.fromEntries(FARE_VEHICLE_CATEGORIES.map(category => [
  1122 |       category,
  1123 |       { enabled: category === 'Car Mini Non-AC', ratePerMinute: category === 'Car Mini Non-AC' ? 60 : 0, graceMinutes: 0 }
  1124 |     ]));
  1125 |     const disabledWaitingSettings = Object.fromEntries(FARE_VEHICLE_CATEGORIES.map(category => [
  1126 |       category,
  1127 |       { enabled: false, ratePerMinute: 0, graceMinutes: 5 }
  1128 |     ]));
  1129 | 
  1130 |     try {
  1131 |       const fareSettings = await request.patch('/api/admin/fare-settings', {
  1132 |         headers: { authorization: `Bearer ${adminJwt}` },
  1133 |         data: { dailyFareSettings: settingsFor(200, 100) }
  1134 |       });
  1135 |       expect(fareSettings.ok()).toBeTruthy();
  1136 |       const waitingSaved = await request.patch('/api/admin/waiting-rate-settings', {
  1137 |         headers: { authorization: `Bearer ${adminJwt}` },
  1138 |         data: { waitingRateSettings: waitingSettings }
  1139 |       });
  1140 |       expect(waitingSaved.ok()).toBeTruthy();
  1141 | 
  1142 |       await Promise.all([
  1143 |         openAuthenticatedClient(customerPage, baseURL, '/customer', customer, token(customer)),
  1144 |         openAuthenticatedClient(driverPage, baseURL, '/driver', matchingDriver, token(matchingDriver))
  1145 |       ]);
  1146 |       await driverPage.evaluate(() => toggleOnline(true));
  1147 |       await expect.poll(async () => (await models.User.findById(matchingDriver._id).lean()).isOnline).toBe(true);
  1148 |       await expect.poll(() => io.sockets.adapter.rooms.get('drivers:Car Mini Non-AC')?.size || 0).toBeGreaterThan(0);
  1149 | 
  1150 |       const createdResponse = await request.post('/api/rides', {
  1151 |         headers: authHeaders(customer),
  1152 |         data: {
  1153 |           pickupLocation: pickup,
  1154 |           dropoffLocation: dropoff,
  1155 |           distance: 7,
  1156 |           vehicleType: 'Car Mini',
  1157 |           fare: 1
  1158 |         }
  1159 |       });
  1160 |       expect(createdResponse.status()).toBe(201);
  1161 |       const ride = await createdResponse.json();
  1162 |       await customerPage.evaluate(({ createdRide }) => {
  1163 |         activeRide = createdRide;
  1164 |         activeLiveFare = createdRide.fare;
  1165 |         showWaitingPanel(createdRide);
  1166 |         connectToRideRoom(createdRide._id);
  1167 |       }, { createdRide: ride });
  1168 |       await expect(driverPage.locator('#ride-request')).toBeVisible();
  1169 | 
  1170 |       const acceptedResponse = await request.patch(`/api/rides/${ride._id}/accept`, {
  1171 |         headers: authHeaders(matchingDriver)
  1172 |       });
  1173 |       expect(acceptedResponse.status()).toBe(200);
  1174 |       await expect(customerPage.locator('#ar-matched')).toBeVisible();
  1175 | 
  1176 |       await driverPage.evaluate(({ rideId, pickupLocation }) => {
  1177 |         socket.emit('driver:location', {
  1178 |           rideId,
  1179 |           lat: pickupLocation.lat,
  1180 |           lng: pickupLocation.lng
  1181 |         });
  1182 |       }, { rideId: ride._id, pickupLocation: pickup });
  1183 |       await expect.poll(async () => Boolean((await models.Ride.findById(ride._id).lean()).pickupReachedAt)).toBe(true);
  1184 | 
  1185 |       const arrived = await request.patch(`/api/rides/${ride._id}/status`, {
  1186 |         headers: authHeaders(matchingDriver),
  1187 |         data: { status: 'arrived' }
  1188 |       });
  1189 |       expect(arrived.status()).toBe(200);
  1190 |       const withPin = await models.Ride.findById(ride._id).lean();
  1191 |       const started = await request.patch(`/api/rides/${ride._id}/status`, {
  1192 |         headers: authHeaders(matchingDriver),
  1193 |         data: { status: 'in-progress', pin: withPin.verificationPin }
  1194 |       });
  1195 |       expect(started.status()).toBe(200);
  1196 | 
  1197 |       const emitStationaryLocation = () => driverPage.evaluate(({ rideId, pickupLocation }) => {
  1198 |         socket.emit('driver:location', {
  1199 |           rideId,
  1200 |           lat: pickupLocation.lat,
  1201 |           lng: pickupLocation.lng
  1202 |         });
  1203 |       }, { rideId: ride._id, pickupLocation: pickup });
  1204 |       await emitStationaryLocation();
  1205 |       await expect.poll(async () => Boolean((await models.Ride.findById(ride._id).lean()).waitingStartedAt)).toBe(true);
  1206 |       await new Promise(resolve => setTimeout(resolve, 1300));
  1207 |       await emitStationaryLocation();
  1208 |       await expect.poll(async () => {
  1209 |         const current = await models.Ride.findById(ride._id).lean();
  1210 |         return { waitingSeconds: current.waitingSeconds, waitingFare: current.waitingFare };
  1211 |       }).toMatchObject({ waitingSeconds: expect.any(Number), waitingFare: expect.any(Number) });
  1212 |       const waitingRide = await models.Ride.findById(ride._id).lean();
> 1213 |       expect(waitingRide.waitingSeconds).toBeGreaterThan(0);
       |                                          ^ Error: expect(received).toBeGreaterThan(expected)
  1214 |       expect(waitingRide.waitingFare).toBeGreaterThan(0);
  1215 |       await expect(customerPage.locator('#ar-waiting-fare-row')).toBeVisible();
  1216 |       await expect(customerPage.locator('#ar-waiting-fare')).toContainText('Rs');
  1217 | 
  1218 |       const completed = await request.patch(`/api/rides/${ride._id}/status`, {
  1219 |         headers: authHeaders(matchingDriver),
  1220 |         data: { status: 'completed' }
  1221 |       });
  1222 |       expect(completed.status()).toBe(200);
  1223 |       const finalRide = await models.Ride.findById(ride._id).lean();
  1224 |       expect(finalRide.waitingFare).toBeGreaterThan(0);
  1225 |       expect(finalRide.fare).toBeCloseTo(finalRide.agreedFareBeforeWaiting + finalRide.waitingFare, 2);
  1226 |     } finally {
  1227 |       await request.patch('/api/admin/waiting-rate-settings', {
  1228 |         headers: { authorization: `Bearer ${adminJwt}` },
  1229 |         data: { waitingRateSettings: disabledWaitingSettings }
  1230 |       }).catch(() => {});
  1231 |       await Promise.all([customerPage.close(), driverPage.close()]);
  1232 |       await request.dispose();
  1233 |     }
  1234 |   });
  1235 | 
  1236 |   test('removes a cancelled request and activates the winning Driver without a refresh', async ({ browser, playwright }) => {
  1237 |     const customerToken = token(customer);
  1238 |     const matchingToken = token(matchingDriver);
  1239 |     const baseURL = `http://127.0.0.1:${httpServer.address().port}`;
  1240 |     const request = await playwright.request.newContext({ baseURL });
  1241 |     const driverPage = await browser.newPage();
  1242 | 
  1243 |     async function createRide(label) {
  1244 |       const response = await request.post('/api/rides', {
  1245 |         headers: authHeaders(customer),
  1246 |         data: {
  1247 |           pickupLocation: { lat: 31.5204, lng: 74.3587, address: `${label} pickup` },
  1248 |           dropoffLocation: { lat: 31.5304, lng: 74.3687, address: `${label} dropoff` },
  1249 |           distance: 7,
  1250 |           vehicleType: 'Car Mini',
  1251 |           fare: 1
  1252 |         }
  1253 |       });
  1254 |       expect(response.status()).toBe(201);
  1255 |       return response.json();
  1256 |     }
  1257 | 
  1258 |     try {
  1259 |       await openAuthenticatedClient(driverPage, baseURL, '/driver', matchingDriver, matchingToken);
  1260 |       await driverPage.evaluate(() => toggleOnline(true));
  1261 |       await expect.poll(() => driverPage.evaluate(() => isOnline)).toBe(true);
  1262 |       await expect.poll(() => io.sockets.adapter.rooms.get('drivers:Car Mini Non-AC')?.size || 0).toBeGreaterThan(0);
  1263 | 
  1264 |       const cancelledRide = await createRide('Instant cancellation');
  1265 |       await expect(driverPage.locator('#ride-request')).toBeVisible();
  1266 |       // Browser automation does not grant notification/audio activation by
  1267 |       // default. Start the same request alert explicitly so cancellation
  1268 |       // verifies the cleanup path for an already-alerting offer.
  1269 |       await driverPage.evaluate(() => startRideAlert(pendingRide));
  1270 |       await expect.poll(() => driverPage.evaluate(rideId => ({
  1271 |         pending: String(pendingRide?.id || pendingRide?._id) === String(rideId),
  1272 |         alerting: !!alertInterval
  1273 |       }), cancelledRide._id)).toEqual({ pending: true, alerting: true });
  1274 | 
  1275 |       const cancelled = await request.patch(`/api/rides/${cancelledRide._id}/cancel`, {
  1276 |         headers: authHeaders(customer)
  1277 |       });
  1278 |       expect(cancelled.status()).toBe(200);
  1279 |       await expect(driverPage.locator('#ride-request')).toBeHidden();
  1280 |       await expect.poll(() => driverPage.evaluate(() => ({
  1281 |         pendingRide: !!pendingRide,
  1282 |         sentOffer: !!sentOffer,
  1283 |         alertInterval: !!alertInterval,
  1284 |         notification: !!rideNotification
  1285 |       }))).toEqual({ pendingRide: false, sentOffer: false, alertInterval: false, notification: false });
  1286 | 
  1287 |       const acceptedRide = await createRide('Instant acceptance');
  1288 |       await expect(driverPage.locator('#ride-request')).toBeVisible();
  1289 |       const accepted = await request.patch(`/api/rides/${acceptedRide._id}/accept`, {
  1290 |         headers: authHeaders(matchingDriver)
  1291 |       });
  1292 |       expect(accepted.status()).toBe(200);
  1293 |       await expect(driverPage.locator('#ride-request')).toBeHidden();
  1294 |       await expect(driverPage.locator('#active-panel')).toBeVisible();
  1295 |       await expect.poll(() => driverPage.evaluate(rideId =>
  1296 |         String(activeRide?._id) === String(rideId), acceptedRide._id
  1297 |       )).toBe(true);
  1298 |     } finally {
  1299 |       await driverPage.close();
  1300 |       await request.dispose();
  1301 |     }
  1302 |   });
  1303 | 
  1304 |   test('loads Mapbox maps without Leaflet or legacy raster map providers', async ({ browser }) => {
  1305 |     const baseURL = `http://127.0.0.1:${httpServer.address().port}`;
  1306 |     const context = await browser.newContext({
  1307 |       viewport: { width: 430, height: 900 },
  1308 |       deviceScaleFactor: 2
  1309 |     });
  1310 |     const customerPage = await context.newPage();
  1311 |     const driverPage = await context.newPage();
  1312 | 
  1313 |     try {
```