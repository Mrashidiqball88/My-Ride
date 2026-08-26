# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: fare-flow-live.spec.js >> live Mongo fare refresh >> persists settings, creates a ride, and refreshes only matching browser clients
- Location: tests/fare-flow-live.spec.js:282:3

# Error details

```
Error: expect(received).toBe(expected) // Object.is equality

Expected: true
Received: false

Call Log:
- Timeout 5000ms exceeded while waiting on the predicate
```

# Test source

```ts
  215 |         activeRide = { status: 'accepted', pickupLocation: pickup, dropoffLocation: dropoff };
  216 |         lastDriverLocation = { lat: 31.521, lng: 74.359 };
  217 |         customerTrackingFollow = false;
  218 |         followCustomerTrip();
  219 |         const callsAfterManualPan = calls.length;
  220 |         focusCustomerTrip();
  221 |         pendingVerificationPin = '2468';
  222 |         hideRidePin();
  223 |         const hiddenOnAcceptance = document.getElementById('ar-pin-card').style.display === 'none';
  224 |         const hiddenAwayFromPickup = !revealRidePinIfAtPickup({ lat: 31.53, lng: 74.37 });
  225 |         const visibleAtPickup = revealRidePinIfAtPickup({ lat: 31.5205, lng: 74.3588 });
  226 |         const contactBeforePin = Boolean(
  227 |           document.getElementById('ar-contact-btns').compareDocumentPosition(document.getElementById('ar-pin-card'))
  228 |           & Node.DOCUMENT_POSITION_FOLLOWING
  229 |         );
  230 |         return {
  231 |           callsAfterManualPan,
  232 |           focusCall: calls.at(-1),
  233 |           hiddenOnAcceptance,
  234 |           hiddenAwayFromPickup,
  235 |           visibleAtPickup,
  236 |           displayedPin: document.getElementById('ar-pin-value').textContent,
  237 |           contactBeforePin
  238 |         };
  239 |       }, { pickup, dropoff });
  240 | 
  241 |       expect(customerCamera.callsAfterManualPan).toBe(0);
  242 |       expect(customerCamera.focusCall.zoom).toBe(17);
  243 |       expect(customerCamera.hiddenOnAcceptance).toBe(true);
  244 |       expect(customerCamera.hiddenAwayFromPickup).toBe(true);
  245 |       expect(customerCamera.visibleAtPickup).toBe(true);
  246 |       expect(customerCamera.displayedPin).toBe('2468');
  247 |       expect(customerCamera.contactBeforePin).toBe(true);
  248 | 
  249 |       const driverCamera = await driverPage.evaluate(({ pickup, dropoff }) => {
  250 |         const calls = [];
  251 |         map = {
  252 |           getZoom: () => 18,
  253 |           setView: (center, zoom) => calls.push({ center, zoom })
  254 |         };
  255 |         activeRide = { status: 'accepted', pickupLocation: pickup, dropoffLocation: dropoff };
  256 |         driverLocation = { lat: 31.521, lng: 74.359 };
  257 |         navigationFollowing = false;
  258 |         focusActiveNavigation();
  259 |         const originalPolyline = L.polyline;
  260 |         const routeColors = [];
  261 |         L.polyline = (_coords, options) => {
  262 |           routeColors.push(options.color);
  263 |           return { addTo() { return this; }, remove() {} };
  264 |         };
  265 |         routeLine = null;
  266 |         drawNavigationLine([[31.521, 74.359], [31.5204, 74.3587]]);
  267 |         L.polyline = originalPolyline;
  268 |         clearRideMap();
  269 |         return {
  270 |           focusCall: calls[0],
  271 |           routeColors
  272 |         };
  273 |       }, { pickup, dropoff });
  274 | 
  275 |       expect(driverCamera.focusCall.zoom).toBe(18);
  276 |       expect(driverCamera.routeColors).toEqual(['#092c62', '#2688ff']);
  277 |     } finally {
  278 |       await Promise.all([customerPage.close(), driverPage.close()]);
  279 |     }
  280 |   });
  281 | 
  282 |   test('persists settings, creates a ride, and refreshes only matching browser clients', async ({ browser, playwright }) => {
  283 |     const customerToken = token(customer);
  284 |     const adminToken = token({ _id: new mongoose.Types.ObjectId(), role: 'admin', isAdmin: true, name: 'Admin' });
  285 |     const matchingToken = token(matchingDriver);
  286 |     const otherToken = token(otherDriver);
  287 |     const baseURL = `http://127.0.0.1:${httpServer.address().port}`;
  288 |     const request = await playwright.request.newContext({ baseURL });
  289 | 
  290 |     const matchingPage = await browser.newPage();
  291 |     const otherPage = await browser.newPage();
  292 |     const customerPage = await browser.newPage();
  293 |     try {
  294 |       const initial = settingsFor(200, 100);
  295 |       const savedInitial = await request.patch('/api/admin/fare-settings', {
  296 |         headers: { authorization: `Bearer ${adminToken}` },
  297 |         data: { dailyFareSettings: initial }
  298 |       });
  299 |       expect(savedInitial.ok()).toBeTruthy();
  300 |       expect((await models.Settings.findOne({ key: 'daily_fare_settings' }).lean()).value['Car Mini Non-AC'].baseFare)
  301 |         .toBe(200);
  302 | 
  303 |       await Promise.all([
  304 |         openAuthenticatedClient(customerPage, baseURL, '/customer', customer, customerToken),
  305 |         openAuthenticatedClient(matchingPage, baseURL, '/driver', matchingDriver, matchingToken),
  306 |         openBrowserSocket(otherPage, baseURL, otherDriver)
  307 |       ]);
  308 | 
  309 |       await matchingPage.evaluate(() => toggleOnline(true));
  310 |       await expect.poll(async () => (await models.User.findById(matchingDriver._id).lean()).isOnline).toBe(true);
  311 |       await expect.poll(() => io.sockets.adapter.rooms.get('drivers:Car Mini Non-AC')?.size || 0).toBeGreaterThan(0);
  312 |       await expect.poll(async () => {
  313 |         const broadcast = await findRideBroadcastDrivers({ lat: 1, lng: 2 }, 'Car Mini');
  314 |         return broadcast.drivers.some(driver => String(driver._id) === String(matchingDriver._id));
> 315 |       }).toBe(true);
      |          ^ Error: expect(received).toBe(expected) // Object.is equality
  316 | 
  317 |       const rideResponse = await request.post('/api/rides', {
  318 |         headers: authHeaders(customer),
  319 |         data: {
  320 |           pickupLocation: { lat: 31.5204, lng: 74.3587, address: 'Live pickup' },
  321 |           dropoffLocation: { lat: 31.5304, lng: 74.3687, address: 'Live dropoff' },
  322 |           distance: 7,
  323 |           vehicleType: 'Car Mini',
  324 |           fare: 1
  325 |         }
  326 |       });
  327 |       expect(rideResponse.status()).toBe(201);
  328 |       const ride = await rideResponse.json();
  329 |       // The server owns fare calculation. Keep the initial assertion tied to
  330 |       // the quote returned with the created ride rather than duplicating a
  331 |       // fare value that can change with the configured /km rate.
  332 |       expect(ride.fare).toBe(ride.fareQuote.totalFare);
  333 |       const initialFare = ride.fare;
  334 | 
  335 |       await customerPage.evaluate(({ ride: createdRide }) => {
  336 |         activeRide = createdRide;
  337 |         activeLiveFare = createdRide.fare;
  338 |         showWaitingPanel(createdRide);
  339 |         connectToRideRoom(createdRide._id);
  340 |       }, { ride });
  341 |       await matchingPage.evaluate(({ ride: createdRide }) => {
  342 |         pendingRide = { ...createdRide, id: String(createdRide._id) };
  343 |         document.getElementById('rr-fare').textContent = `Rs ${createdRide.fare}`;
  344 |         document.getElementById('ride-request').style.display = 'block';
  345 |       }, { ride });
  346 | 
  347 |       await expect(customerPage.locator('#active-ride')).toBeVisible();
  348 |       await expect(customerPage.locator('#ar-live-fare')).toHaveText(`Rs ${initialFare}`);
  349 |       await expect(matchingPage.locator('#ride-request')).toBeVisible();
  350 |       await expect(matchingPage.locator('#rr-fare')).toHaveText(`Rs ${initialFare}`);
  351 | 
  352 |       const refreshed = settingsFor(500, 125);
  353 |       const savedRefresh = await request.patch('/api/admin/fare-settings', {
  354 |         headers: { authorization: `Bearer ${adminToken}` },
  355 |         data: { dailyFareSettings: refreshed }
  356 |       });
  357 |       expect(savedRefresh.ok()).toBeTruthy();
  358 | 
  359 |       await expect.poll(async () => (await fareEvents(customerPage)).length).toBe(1);
  360 |       await expect.poll(async () => (await fareEvents(matchingPage)).length).toBe(1);
  361 |       await expect.poll(async () => (await fareEvents(otherPage)).length).toBe(0);
  362 | 
  363 |       const customerEvents = await fareEvents(customerPage);
  364 |       const matchingEvents = await fareEvents(matchingPage);
  365 |       const refreshedFare = customerEvents[0].fareQuote.totalFare;
  366 |       expect(customerEvents[0]).toMatchObject({ id: ride._id, fare: refreshedFare });
  367 |       expect(matchingEvents[0]).toMatchObject({ id: ride._id, fare: refreshedFare });
  368 |       await expect(customerPage.locator('#ar-live-fare')).toHaveText(`Rs ${refreshedFare}`);
  369 |       await expect(matchingPage.locator('#rr-fare')).toHaveText(`Rs ${refreshedFare}`);
  370 |       await expect(otherPage.locator('body')).not.toContainText(`Rs ${refreshedFare}`);
  371 |       expect((await models.Ride.findById(ride._id).lean()).fare).toBe(refreshedFare);
  372 |       expect((await models.Settings.findOne({ key: 'daily_fare_settings' }).lean()).value['Car Mini Non-AC'])
  373 |         .toMatchObject({ baseFare: 500 });
  374 |     } finally {
  375 |       await Promise.all([matchingPage.close(), otherPage.close(), customerPage.close()]);
  376 |       await request.dispose();
  377 |     }
  378 |   });
  379 | 
  380 |   test('routes each Toyota category from the customer UI to only its matching driver', async ({ browser, playwright }) => {
  381 |     const customerToken = token(customer);
  382 |     const highroofToken = token(highroofDriver);
  383 |     const coasterToken = token(coasterDriver);
  384 |     const otherToken = token(otherDriver);
  385 |     const baseURL = `http://127.0.0.1:${httpServer.address().port}`;
  386 |     const request = await playwright.request.newContext({ baseURL });
  387 |     const customerPage = await browser.newPage();
  388 |     const highroofPage = await browser.newPage();
  389 |     const coasterPage = await browser.newPage();
  390 |     const otherPage = await browser.newPage();
  391 | 
  392 |     try {
  393 |       const fareSettings = settingsFor(200, 100);
  394 |       fareSettings['Toyota Highroof'] = {
  395 |         baseFare: 700,
  396 |         distanceSlabs: [{ minKm: 0, maxKm: null, rate: 130 }],
  397 |         peakRules: []
  398 |       };
  399 |       fareSettings['Toyota Saloon Coaster'] = {
  400 |         baseFare: 900,
  401 |         distanceSlabs: [{ minKm: 0, maxKm: null, rate: 170 }],
  402 |         peakRules: []
  403 |       };
  404 |       const saved = await request.patch('/api/admin/fare-settings', {
  405 |         headers: { authorization: `Bearer ${token({ _id: new mongoose.Types.ObjectId(), role: 'admin', isAdmin: true, name: 'Admin' })}` },
  406 |         data: { dailyFareSettings: fareSettings }
  407 |       });
  408 |       expect(saved.ok()).toBeTruthy();
  409 | 
  410 |       await Promise.all([
  411 |         openAuthenticatedClient(customerPage, baseURL, '/customer', customer, customerToken),
  412 |         openAuthenticatedClient(highroofPage, baseURL, '/driver', highroofDriver, highroofToken),
  413 |         openAuthenticatedClient(coasterPage, baseURL, '/driver', coasterDriver, coasterToken),
  414 |         openAuthenticatedClient(otherPage, baseURL, '/driver', otherDriver, otherToken)
  415 |       ]);
```