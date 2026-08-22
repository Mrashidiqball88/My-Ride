# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: fare-flow-live.spec.js >> live Mongo fare refresh >> persists settings, creates a ride, and refreshes only matching browser clients
- Location: tests/fare-flow-live.spec.js:113:3

# Error details

```
Error: expect(received).toBe(expected) // Object.is equality

Expected: 300
Received: 550
```

# Test source

```ts
  55  |   });
  56  | }
  57  | 
  58  | async function fareEvents(page) {
  59  |   return page.evaluate(() => window.__fareEvents || []);
  60  | }
  61  | 
  62  | test.describe('live Mongo fare refresh', () => {
  63  |   /** @type {import('mongodb-memory-server').MongoMemoryServer} */
  64  |   let mongo;
  65  |   let httpServer;
  66  |   let customer;
  67  |   let matchingDriver;
  68  |   let otherDriver;
  69  | 
  70  |   test.beforeAll(async () => {
  71  |     mongo = await MongoMemoryServer.create();
  72  |     await mongoose.connect(mongo.getUri());
  73  | 
  74  |     customer = await models.User.create({
  75  |       name: 'Live Customer',
  76  |       email: 'fare-live-customer@example.test',
  77  |       password: 'not-used',
  78  |       role: 'customer'
  79  |     });
  80  |     matchingDriver = await models.User.create({
  81  |       name: 'Matching Driver',
  82  |       email: 'fare-live-matching@example.test',
  83  |       password: 'not-used',
  84  |       role: 'driver',
  85  |       vehicleType: 'Car Mini',
  86  |       isOnline: true,
  87  |       accountStatus: 'active'
  88  |     });
  89  |     otherDriver = await models.User.create({
  90  |       name: 'Other Driver',
  91  |       email: 'fare-live-other@example.test',
  92  |       password: 'not-used',
  93  |       role: 'driver',
  94  |       vehicleType: 'Bike',
  95  |       isOnline: true,
  96  |       accountStatus: 'active'
  97  |     });
  98  |     await models.Settings.create({
  99  |       key: 'daily_fare_settings',
  100 |       value: settingsFor(200, 100)
  101 |     });
  102 |     httpServer = await new Promise(resolve => {
  103 |       server.listen(0, () => resolve(server));
  104 |     });
  105 |   });
  106 | 
  107 |   test.afterAll(async () => {
  108 |     if (httpServer) await new Promise(resolve => httpServer.close(resolve));
  109 |     await mongoose.disconnect();
  110 |     if (mongo) await mongo.stop();
  111 |   });
  112 | 
  113 |   test('persists settings, creates a ride, and refreshes only matching browser clients', async ({ browser, playwright }) => {
  114 |     const customerToken = token(customer);
  115 |     const adminToken = token({ _id: new mongoose.Types.ObjectId(), role: 'admin', isAdmin: true, name: 'Admin' });
  116 |     const matchingToken = token(matchingDriver);
  117 |     const otherToken = token(otherDriver);
  118 |     const baseURL = `http://127.0.0.1:${httpServer.address().port}`;
  119 |     const request = await playwright.request.newContext({ baseURL });
  120 | 
  121 |     const matchingPage = await browser.newPage();
  122 |     const otherPage = await browser.newPage();
  123 |     const customerPage = await browser.newPage();
  124 |     try {
  125 |       const initial = settingsFor(200, 100);
  126 |       const savedInitial = await request.patch('/api/admin/fare-settings', {
  127 |         headers: { authorization: `Bearer ${adminToken}` },
  128 |         data: { dailyFareSettings: initial }
  129 |       });
  130 |       expect(savedInitial.ok()).toBeTruthy();
  131 |       expect((await models.Settings.findOne({ key: 'daily_fare_settings' }).lean()).value['Car Mini'].baseFare)
  132 |         .toBe(200);
  133 | 
  134 |       await Promise.all([
  135 |         openAuthenticatedClient(customerPage, baseURL, '/customer', customer, customerToken),
  136 |         openAuthenticatedClient(matchingPage, baseURL, '/driver', matchingDriver, matchingToken),
  137 |         openBrowserSocket(otherPage, baseURL, otherToken)
  138 |       ]);
  139 | 
  140 |       await matchingPage.evaluate(() => toggleOnline(true));
  141 |       await expect.poll(async () => (await models.User.findById(matchingDriver._id).lean()).isOnline).toBe(true);
  142 | 
  143 |       const rideResponse = await request.post('/api/rides', {
  144 |         headers: { authorization: `Bearer ${customerToken}` },
  145 |         data: {
  146 |           pickupLocation: { lat: 1, lng: 2, address: 'Live pickup' },
  147 |           dropoffLocation: { lat: 3, lng: 4, address: 'Live dropoff' },
  148 |           distance: 7,
  149 |           vehicleType: 'Car Mini',
  150 |           fare: 1
  151 |         }
  152 |       });
  153 |       expect(rideResponse.status()).toBe(201);
  154 |       const ride = await rideResponse.json();
> 155 |       expect(ride.fare).toBe(300);
      |                         ^ Error: expect(received).toBe(expected) // Object.is equality
  156 | 
  157 |       await customerPage.evaluate(({ ride: createdRide }) => {
  158 |         activeRide = createdRide;
  159 |         activeLiveFare = createdRide.fare;
  160 |         showWaitingPanel(createdRide);
  161 |         connectToRideRoom(createdRide._id);
  162 |       }, { ride });
  163 | 
  164 |       await expect(customerPage.locator('#active-ride')).toBeVisible();
  165 |       await expect(customerPage.locator('#ar-live-fare')).toHaveText('Rs 300');
  166 |       await expect(matchingPage.locator('#ride-request')).toBeVisible();
  167 |       await expect(matchingPage.locator('#rr-fare')).toHaveText('Rs 300');
  168 | 
  169 |       const refreshed = settingsFor(500, 125);
  170 |       const savedRefresh = await request.patch('/api/admin/fare-settings', {
  171 |         headers: { authorization: `Bearer ${adminToken}` },
  172 |         data: { dailyFareSettings: refreshed }
  173 |       });
  174 |       expect(savedRefresh.ok()).toBeTruthy();
  175 | 
  176 |       await expect.poll(async () => (await fareEvents(customerPage)).length).toBe(1);
  177 |       await expect.poll(async () => (await fareEvents(matchingPage)).length).toBe(1);
  178 |       await expect.poll(async () => (await fareEvents(otherPage)).length).toBe(0);
  179 | 
  180 |       const customerEvents = await fareEvents(customerPage);
  181 |       const matchingEvents = await fareEvents(matchingPage);
  182 |       expect(customerEvents[0]).toMatchObject({ id: ride._id, fare: 625 });
  183 |       expect(matchingEvents[0]).toMatchObject({ id: ride._id, fare: 625 });
  184 |       await expect(customerPage.locator('#ar-live-fare')).toHaveText('Rs 625');
  185 |       await expect(matchingPage.locator('#rr-fare')).toHaveText('Rs 625');
  186 |       await expect(otherPage.locator('body')).not.toContainText('Rs 625');
  187 |       expect((await models.Ride.findById(ride._id).lean()).fare).toBe(625);
  188 |       expect((await models.Settings.findOne({ key: 'daily_fare_settings' }).lean()).value['Car Mini'])
  189 |         .toMatchObject({ baseFare: 500 });
  190 |     } finally {
  191 |       await Promise.all([matchingPage.close(), otherPage.close(), customerPage.close()]);
  192 |       await request.dispose();
  193 |     }
  194 |   });
  195 | });
```