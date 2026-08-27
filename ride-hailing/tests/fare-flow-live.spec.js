// @ts-check
'use strict';

const { test, expect } = require('@playwright/test');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const fare = require('../server');
const {
  server, io, models, FARE_VEHICLE_CATEGORIES, findRideBroadcastDrivers
} = fare;

const JWT_SECRET = 'ride-hailing-secret-fallback';

function settingsFor(baseFare, rate = 100) {
  return Object.fromEntries(FARE_VEHICLE_CATEGORIES.map(category => [category, {
    baseFare,
    distanceSlabs: [{ minKm: 0, maxKm: null, rate }],
    peakRules: []
  }]));
}

function token(user) {
  return jwt.sign({
    id: String(user._id),
    role: user.role,
    name: user.name,
    isAdmin: user.isAdmin || undefined
  }, JWT_SECRET);
}

function sessionToken(user) {
  return `live-session-${String(user._id)}`;
}

function authHeaders(user) {
  return {
    authorization: `Bearer ${token(user)}`,
    'x-session-token': sessionToken(user)
  };
}

function browserUser(user) {
  return {
    _id: String(user._id),
    id: String(user._id),
    name: user.name,
    role: user.role,
    accountStatus: user.accountStatus,
    vehicleType: user.vehicleType
  };
}

async function openBrowserSocket(page, baseURL, user, room) {
  const authToken = token(user);
  const authSession = sessionToken(user);
  await page.goto(`${baseURL}/customer`);
  await page.waitForFunction(() => typeof window.io === 'function');
  await page.evaluate(({ authToken: socketToken, sessionToken: socketSession, room: socketRoom }) => {
    window.__fareEvents = [];
    const socket = window.io({ auth: { token: socketToken, sessionToken: socketSession } });
    window.__fareSocket = socket;
    socket.on('ride:fare-updated', payload => window.__fareEvents.push(payload));
    if (socketRoom) socket.on('connect', () => socket.emit('ride:join', socketRoom));
  }, { authToken, sessionToken: authSession, room });
  await page.waitForFunction(() => window.__fareSocket?.connected === true);
}

async function openAuthenticatedClient(page, baseURL, path, user, authToken) {
  await page.addInitScript(({ user: storedUser, token: storedToken, sessionToken: storedSession }) => {
    localStorage.setItem('rh_token', storedToken);
    localStorage.setItem('rh_user', JSON.stringify(storedUser));
    localStorage.setItem('rh_session', storedSession);
  }, { user: browserUser(user), token: authToken, sessionToken: sessionToken(user) });
  await page.goto(`${baseURL}${path}`);
  await page.waitForFunction(() => document.getElementById('app')?.style.display !== 'none');
  await page.waitForFunction(() => typeof socket !== 'undefined' && socket?.connected === true);
  await page.evaluate(() => {
    window.__fareEvents = [];
    socket.on('ride:fare-updated', payload => window.__fareEvents.push(payload));
  });
}

async function fareEvents(page) {
  return page.evaluate(() => window.__fareEvents || []);
}

test.describe('live Mongo fare refresh', () => {
  /** @type {import('mongodb-memory-server').MongoMemoryServer} */
  let mongo;
  let httpServer;
  let customer;
  let matchingDriver;
  let otherDriver;
  let highroofDriver;
  let highroofTakeoverDriver;
  let coasterDriver;

  test.beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());

    customer = await models.User.create({
      name: 'Live Customer',
      email: 'fare-live-customer@example.test',
      password: 'not-used',
      role: 'customer'
    });
    matchingDriver = await models.User.create({
      name: 'Matching Driver',
      email: 'fare-live-matching@example.test',
      password: 'not-used',
      role: 'driver',
      vehicleType: 'Car Mini',
      isOnline: true,
      currentLocation: { lat: 31.5204, lng: 74.3587 },
      accountStatus: 'active'
    });
    otherDriver = await models.User.create({
      name: 'Other Driver',
      email: 'fare-live-other@example.test',
      password: 'not-used',
      role: 'driver',
      vehicleType: 'Bike',
      isOnline: true,
      currentLocation: { lat: 24.8607, lng: 67.0011 },
      accountStatus: 'active'
    });
    highroofDriver = await models.User.create({
      name: 'Highroof Driver',
      email: 'fare-live-highroof@example.test',
      password: 'not-used',
      role: 'driver',
      vehicleType: 'Toyota Highroof',
      isOnline: true,
      currentLocation: { lat: 31.5204, lng: 74.3587 },
      accountStatus: 'active'
    });
    highroofTakeoverDriver = await models.User.create({
      name: 'Highroof Takeover Driver',
      email: 'fare-live-highroof-takeover@example.test',
      password: 'not-used',
      role: 'driver',
      vehicleType: 'Toyota Highroof',
      isOnline: true,
      currentLocation: { lat: 31.5204, lng: 74.3587 },
      accountStatus: 'active'
    });
    coasterDriver = await models.User.create({
      name: 'Coaster Driver',
      email: 'fare-live-coaster@example.test',
      password: 'not-used',
      role: 'driver',
      vehicleType: 'Toyota Saloon Coaster',
      isOnline: true,
      currentLocation: { lat: 31.5204, lng: 74.3587 },
      accountStatus: 'active'
    });
    await models.Wallet.create([
      { user: matchingDriver._id, balance: 1000, transactions: [] },
      { user: otherDriver._id, balance: 1000, transactions: [] },
      { user: highroofDriver._id, balance: 1000, transactions: [] },
      { user: highroofTakeoverDriver._id, balance: 1000, transactions: [] },
      { user: coasterDriver._id, balance: 1000, transactions: [] }
    ]);
    await Promise.all([
      customer, matchingDriver, otherDriver, highroofDriver, highroofTakeoverDriver, coasterDriver
    ].map(user => models.User.updateOne({ _id: user._id }, { activeSessionToken: sessionToken(user) })));
    await models.Settings.create({
      key: 'daily_fare_settings',
      value: settingsFor(200, 100)
    });
    httpServer = await new Promise(resolve => {
      server.listen(0, () => resolve(server));
    });
  });

  test.afterAll(async () => {
    if (httpServer) await new Promise(resolve => httpServer.close(resolve));
    await mongoose.disconnect();
    if (mongo) await mongo.stop();
  });

  test.beforeEach(async () => {
    // Each browser scenario owns its ride state. Without this reset, a pending
    // request from an earlier case can be restored by a reconnect and mask the
    // event the current case intends to verify.
    await models.Ride.deleteMany({});
    await models.User.updateMany(
      { _id: { $in: [matchingDriver._id, otherDriver._id, highroofDriver._id, highroofTakeoverDriver._id, coasterDriver._id] } },
      { $set: { isOnline: false } }
    );
  });

  test('keeps active-trip cameras stable and waits for the server pickup gate before showing the PIN', async ({ browser }) => {
    const baseURL = `http://127.0.0.1:${httpServer.address().port}`;
    const customerPage = await browser.newPage();
    const driverPage = await browser.newPage();
    const pickup = { lat: 31.5204, lng: 74.3587, address: 'Pickup' };
    const dropoff = { lat: 31.5304, lng: 74.3687, address: 'Drop-off' };

    try {
      await Promise.all([
        openAuthenticatedClient(customerPage, baseURL, '/customer', customer, token(customer)),
        openAuthenticatedClient(driverPage, baseURL, '/driver', matchingDriver, token(matchingDriver))
      ]);
      await Promise.all([
        customerPage.evaluate(() => { if (!map) initMap(); }),
        driverPage.evaluate(() => { if (!map) initMap(); })
      ]);

      const realZoomBehavior = await Promise.all([
        customerPage.evaluate(({ pickup, dropoff }) => {
          activeRide = { status: 'accepted', pickupLocation: pickup, dropoffLocation: dropoff };
          customerTrackingFollow = true;
          customerMapAutoCenter = true;
          map.setZoom(map.getZoom() + 1, { animate: false });
          return { follow: customerTrackingFollow, autoCenter: customerMapAutoCenter };
        }, { pickup, dropoff }),
        driverPage.evaluate(({ pickup, dropoff }) => {
          activeRide = { status: 'accepted', pickupLocation: pickup, dropoffLocation: dropoff };
          navigationFollowing = true;
          driverMapAutoCenter = true;
          map.setZoom(map.getZoom() + 1, { animate: false });
          return { following: navigationFollowing, autoCenter: driverMapAutoCenter };
        }, { pickup, dropoff })
      ]);
      expect(realZoomBehavior[0]).toEqual({ follow: false, autoCenter: false });
      expect(realZoomBehavior[1]).toEqual({ following: false, autoCenter: false });

      const customerCamera = await customerPage.evaluate(({ pickup, dropoff }) => {
        const calls = [];
        map.getZoom = () => 17;
        map.easeTo = camera => calls.push(camera);
        activeRide = { status: 'accepted', pickupLocation: pickup, dropoffLocation: dropoff };
        lastDriverLocation = { lat: 31.521, lng: 74.359 };
        customerTrackingFollow = true;
        customerMapAutoCenter = true;
        map.fire('zoomstart');
        const followAfterZoom = customerTrackingFollow;
        const autoCenterAfterZoom = customerMapAutoCenter;
        followCustomerTrip();
        const callsAfterManualPan = calls.length;
        focusCustomerTrip();
        showMatchedPanel({ name: 'Driver Test', phone: '03000000000' }, 400);
        pendingVerificationPin = '2468';
        hideRidePin();
        const hiddenOnAcceptance = document.getElementById('ar-pin-card').style.display === 'none';
        const hiddenWithoutServerGate = !revealRidePinIfAtPickup({ lat: 31.5205, lng: 74.3588 });
        activeRide.pickupReachedAt = new Date().toISOString();
        const visibleAfterServerGate = revealRidePinIfAtPickup();
        const contactBeforePin = Boolean(
          document.getElementById('ar-contact-btns').compareDocumentPosition(document.getElementById('ar-pin-card'))
          & Node.DOCUMENT_POSITION_FOLLOWING
        );
        return {
          callsAfterManualPan,
          followAfterZoom,
          autoCenterAfterZoom,
          focusCall: calls.at(-1),
          hiddenOnAcceptance,
          hiddenWithoutServerGate,
          visibleAfterServerGate,
          displayedPin: document.getElementById('ar-pin-value').textContent,
          contactBeforePin,
          cancellationLocked: document.getElementById('ar-cancel-btn').disabled,
          contactButtonsVisible: document.getElementById('ar-contact-btns').style.display === 'flex',
          contactText: document.getElementById('ar-contact-btns').textContent
        };
      }, { pickup, dropoff });

      expect(customerCamera.callsAfterManualPan).toBe(0);
      expect(customerCamera.followAfterZoom).toBe(false);
      expect(customerCamera.autoCenterAfterZoom).toBe(false);
      expect(customerCamera.focusCall.zoom).toBe(17);
      expect(customerCamera.hiddenOnAcceptance).toBe(true);
      expect(customerCamera.hiddenWithoutServerGate).toBe(true);
      expect(customerCamera.visibleAfterServerGate).toBe(true);
      expect(customerCamera.displayedPin).toBe('2468');
      expect(customerCamera.contactBeforePin).toBe(true);
      expect(customerCamera.cancellationLocked).toBe(true);
      expect(customerCamera.contactButtonsVisible).toBe(true);
      expect(customerCamera.contactText).toContain('Phone Call');
      expect(customerCamera.contactText).toContain('WhatsApp');

      const driverCamera = await driverPage.evaluate(async ({ pickup, dropoff }) => {
        const calls = [];
        map.getZoom = () => 18;
        map.easeTo = camera => calls.push(camera);
        activeRide = { status: 'accepted', pickupLocation: pickup, dropoffLocation: dropoff };
        driverLocation = { lat: 31.521, lng: 74.359 };
        navigationFollowing = true;
        driverMapAutoCenter = true;
        map.fire('zoomstart');
        const followingAfterZoom = navigationFollowing;
        const autoCenterAfterZoom = driverMapAutoCenter;
        focusActiveNavigation();
        if (!map.isStyleLoaded()) await new Promise(resolve => map.once('load', resolve));
        routeLine = null;
        drawNavigationLine([[31.521, 74.359], [31.5204, 74.3587]]);
        const routeColors = [
          map.getPaintProperty(DRIVER_ROUTE_IDS.shadow, 'line-color'),
          map.getPaintProperty(DRIVER_ROUTE_IDS.line, 'line-color')
        ];
        clearRideMap();
        return {
          focusCall: calls[0],
          followingAfterZoom,
          autoCenterAfterZoom,
          routeColors
        };
      }, { pickup, dropoff });

      expect(driverCamera.focusCall.zoom).toBe(18);
      expect(driverCamera.followingAfterZoom).toBe(false);
      expect(driverCamera.autoCenterAfterZoom).toBe(false);
      expect(driverCamera.routeColors).toEqual(['#092c62', '#2688ff']);
    } finally {
      await Promise.all([customerPage.close(), driverPage.close()]);
    }
  });

  test('releases the PIN from authoritative pickup GPS and rejects Customer cancellation', async ({ browser }) => {
    const baseURL = `http://127.0.0.1:${httpServer.address().port}`;
    const customerPage = await browser.newPage();
    const pickup = { lat: 31.5204, lng: 74.3587, address: 'Pickup' };
    const dropoff = { lat: 31.5304, lng: 74.3687, address: 'Drop-off' };
    let ride;

    try {
      await models.User.updateOne({ _id: matchingDriver._id }, {
        $set: {
          isOnline: true,
          lastOnlineHeartbeat: new Date(),
          currentLocation: { lat: 31.53, lng: 74.37 }
        }
      });
      ride = await models.Ride.create({
        passenger: customer._id,
        driver: matchingDriver._id,
        pickupLocation: pickup,
        dropoffLocation: dropoff,
        dropoffLocations: [dropoff],
        fare: 400,
        vehicleType: 'Car Mini Non-AC',
        status: 'accepted',
        verificationPin: '2468'
      });

      await openAuthenticatedClient(customerPage, baseURL, '/customer', customer, token(customer));
      await customerPage.evaluate(({ rideId, pickup, dropoff }) => {
        activeRide = {
          _id: rideId,
          status: 'accepted',
          pickupLocation: pickup,
          dropoffLocation: dropoff,
          fare: 400,
          driver: { name: 'Matching Driver', phone: '03000000000' }
        };
        activeDriverInfo = activeRide.driver;
        window.__pickupEvents = [];
        showMatchedPanel(activeRide.driver, activeRide.fare);
        connectToRideRoom(rideId);
        socket.on('ride:pickup-reached', payload => window.__pickupEvents.push(payload));
      }, { rideId: String(ride._id), pickup, dropoff });

      const farLocation = await fetch(`${baseURL}/api/driver/location`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(matchingDriver) },
        body: JSON.stringify({ rideId: String(ride._id), lat: 31.53, lng: 74.37 })
      });
      expect(farLocation.status).toBe(200);
      await customerPage.waitForTimeout(150);
      expect(await customerPage.evaluate(() => window.__pickupEvents.length)).toBe(0);
      expect((await models.Ride.findById(ride._id).select('pickupReachedAt').lean()).pickupReachedAt).toBeNull();

      const beforeRelease = await fetch(`${baseURL}/api/rides/${ride._id}`, {
        headers: authHeaders(customer)
      });
      const beforeReleaseBody = await beforeRelease.json();
      expect(beforeReleaseBody.verificationPin).toBeUndefined();

      const releaseEvent = customerPage.waitForFunction(() => window.__pickupEvents.length === 1);
      const atPickup = await fetch(`${baseURL}/api/driver/location`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(matchingDriver) },
        body: JSON.stringify({ rideId: String(ride._id), ...pickup })
      });
      expect(atPickup.status).toBe(200);
      await releaseEvent;

      const pickupEvent = await customerPage.evaluate(() => window.__pickupEvents[0]);
      expect(pickupEvent.verificationPin).toBe('2468');
      expect(await customerPage.locator('#ar-pin-card').isVisible()).toBe(true);
      expect(await customerPage.locator('#ar-cancel-btn').isDisabled()).toBe(true);
      expect(await customerPage.locator('#ar-contact-btns').textContent()).toContain('Phone Call');
      expect(await customerPage.locator('#ar-contact-btns').textContent()).toContain('WhatsApp');

      const afterRelease = await fetch(`${baseURL}/api/rides/${ride._id}`, {
        headers: authHeaders(customer)
      });
      const afterReleaseBody = await afterRelease.json();
      expect(afterReleaseBody.verificationPin).toBe('2468');
      expect(afterReleaseBody.pickupReachedAt).toBeTruthy();

      const cancelAttempt = await fetch(`${baseURL}/api/rides/${ride._id}/cancel`, {
        method: 'PATCH',
        headers: authHeaders(customer)
      });
      expect(cancelAttempt.status).toBe(400);
      expect((await cancelAttempt.json()).error).toBe('Cannot cancel at this stage');
      expect((await models.Ride.findById(ride._id).select('status').lean()).status).toBe('accepted');
    } finally {
      await customerPage.close();
    }
  });

  test('publishes active Driver locations on one strict three-second lifecycle timer', async ({ browser }) => {
    const baseURL = `http://127.0.0.1:${httpServer.address().port}`;
    const driverPage = await browser.newPage();

    try {
      await openAuthenticatedClient(driverPage, baseURL, '/driver', matchingDriver, token(matchingDriver));
      await driverPage.evaluate(() => {
        stopActiveRideLocationSync();
        activeRide = { _id: 'three-second-cadence-ride', status: 'accepted' };
        window.__activeRideLocationTicks = [];
        readCurrentDriverLocation = async () => {
          window.__activeRideLocationTicks.push(performance.now());
          return true;
        };
        startActiveRideLocationSync();
      });

      await driverPage.waitForTimeout(6250);
      const cadence = await driverPage.evaluate(() => {
        const ticks = window.__activeRideLocationTicks.slice();
        const intervals = ticks.slice(1).map((tick, index) => tick - ticks[index]);
        endActiveRide();
        return {
          tickCount: ticks.length,
          intervals,
          timerStopped: activeRideLocationTimer === null
        };
      });

      expect(cadence.tickCount).toBe(3);
      expect(cadence.timerStopped).toBe(true);
      cadence.intervals.forEach(interval => {
        expect(interval).toBeGreaterThanOrEqual(2850);
        expect(interval).toBeLessThanOrEqual(3250);
      });

      await driverPage.waitForTimeout(3200);
      const ticksAfterEnd = await driverPage.evaluate(() => window.__activeRideLocationTicks.length);
      expect(ticksAfterEnd).toBe(3);
    } finally {
      await driverPage.close();
    }
  });

  test('does not overlap GPS reads or route requests during reconnect and slow routing', async ({ browser }) => {
    const baseURL = `http://127.0.0.1:${httpServer.address().port}`;
    const customerPage = await browser.newPage();
    const driverPage = await browser.newPage();
    const pickup = { lat: 31.5204, lng: 74.3587, address: 'Pickup' };
    const dropoff = { lat: 31.5304, lng: 74.3687, address: 'Drop-off' };

    try {
      await Promise.all([
        openAuthenticatedClient(customerPage, baseURL, '/customer', customer, token(customer)),
        openAuthenticatedClient(driverPage, baseURL, '/driver', matchingDriver, token(matchingDriver))
      ]);

      const initialReadState = await driverPage.evaluate(() => {
        stopActiveRideLocationSync();
        activeRide = { _id: 'delayed-gps-ride', status: 'accepted' };
        window.__delayedGpsReadCount = 0;
        window.__resolveDelayedGpsRead = null;
        readCurrentDriverLocation = () => {
          window.__delayedGpsReadCount++;
          if (window.__delayedGpsReadCount === 1) {
            return new Promise(resolve => { window.__resolveDelayedGpsRead = resolve; });
          }
          return Promise.resolve(true);
        };
        startActiveRideLocationSync();
        const firstTimer = activeRideLocationTimer;
        startActiveRideLocationSync();
        const sameRideKeptTimer = firstTimer === activeRideLocationTimer;
        stopActiveRideLocationSync();
        startActiveRideLocationSync();
        return {
          reads: window.__delayedGpsReadCount,
          sameRideKeptTimer,
          inFlight: activeRideLocationRequestInFlight
        };
      });

      expect(initialReadState).toEqual({ reads: 1, sameRideKeptTimer: true, inFlight: true });
      await driverPage.evaluate(() => window.__resolveDelayedGpsRead(true));
      await driverPage.waitForTimeout(3150);
      const readsAfterRestart = await driverPage.evaluate(() => {
        const reads = window.__delayedGpsReadCount;
        stopActiveRideLocationSync();
        activeRide = null;
        return reads;
      });
      expect(readsAfterRestart).toBe(2);

      const driverRouteRequests = await driverPage.evaluate(async ({ pickup, dropoff }) => {
        activeRide = { _id: 'driver-route-ride', status: 'accepted', pickupLocation: pickup, dropoffLocation: dropoff };
        driverLocation = { lat: 31.521, lng: 74.359 };
        map = { getZoom: () => 17 };
        navigationRoute = null;
        navigationRouteInFlight = false;
        const originalRequestRoadRoute = requestRoadRoute;
        let requests = 0;
        let release;
        requestRoadRoute = () => {
          requests++;
          return new Promise(resolve => { release = resolve; });
        };
        const first = refreshActiveNavigation();
        const second = refreshActiveNavigation();
        release({ coords: [] });
        await Promise.all([first, second]);
        requestRoadRoute = originalRequestRoadRoute;
        activeRide = null;
        return requests;
      }, { pickup, dropoff });
      expect(driverRouteRequests).toBe(1);

      const customerRouteRequests = await customerPage.evaluate(async ({ pickup, dropoff }) => {
        activeRide = { _id: 'customer-route-ride', status: 'accepted', pickupLocation: pickup, dropoffLocation: dropoff };
        map = { getZoom: () => 17, setView() {} };
        driverMarker = { setLatLng() {}, remove() {}, getElement: () => ({ style: {} }) };
        liveTripLine = null;
        liveTripRouteOrigin = null;
        liveTripRouteInFlight = false;
        const originalRequestRoadRoute = requestRoadRoute;
        let requests = 0;
        let release;
        requestRoadRoute = () => {
          requests++;
          return new Promise(resolve => { release = resolve; });
        };
        const first = updateLiveTripTracking({ lat: 31.521, lng: 74.359 });
        const second = updateLiveTripTracking({ lat: 31.522, lng: 74.36 });
        release({ coords: [] });
        await Promise.all([first, second]);
        requestRoadRoute = originalRequestRoadRoute;
        endRide();
        return requests;
      }, { pickup, dropoff });
      expect(customerRouteRequests).toBe(1);
    } finally {
      await Promise.all([customerPage.close(), driverPage.close()]);
    }
  });

  test('clears completed ride panels and locks customer cancellation after pickup arrival', async ({ browser }) => {
    const baseURL = `http://127.0.0.1:${httpServer.address().port}`;
    const customerPage = await browser.newPage();
    const driverPage = await browser.newPage();
    const pickup = { lat: 31.5204, lng: 74.3587, address: 'Pickup' };

    try {
      await Promise.all([
        openAuthenticatedClient(customerPage, baseURL, '/customer', customer, token(customer)),
        openAuthenticatedClient(driverPage, baseURL, '/driver', matchingDriver, token(matchingDriver))
      ]);

      const customerLifecycle = await customerPage.evaluate(({ pickup }) => {
        activeRide = { _id: 'finished-customer-ride', status: 'arrived', pickupLocation: pickup, fare: 300 };
        activeDriverInfo = { name: 'Driver Test', phone: '03000000000' };
        document.getElementById('active-ride').style.display = 'block';
        document.getElementById('ar-matched').style.display = 'block';
        updateCustomerCancellationControl('arrived');
        const lockedAtArrival = document.getElementById('ar-cancel-btn').disabled;
        const originalLoadHistory = loadRideHistory;
        loadRideHistory = () => Promise.resolve();
        endRide();
        loadRideHistory = originalLoadHistory;
        showRatingModal({ rideId: 'finished-customer-ride', driverName: 'Driver Test' });
        return {
          cancelLocked: lockedAtArrival,
          activeRideCleared: activeRide === null,
          panelHidden: document.getElementById('active-ride').style.display === 'none',
          ratingRideId: _ratingRideId,
          ratingDriver: document.getElementById('rating-driver-name').textContent
        };
      }, { pickup });

      expect(customerLifecycle).toEqual({
        cancelLocked: true,
        activeRideCleared: true,
        panelHidden: true,
        ratingRideId: 'finished-customer-ride',
        ratingDriver: 'Driver Test'
      });

      const driverLifecycle = await driverPage.evaluate(() => {
        activeRide = { _id: 'finished-driver-ride', passenger: { name: 'Passenger Test' } };
        document.getElementById('active-panel').style.display = 'block';
        const originalCheckTickets = checkUnreadDriverTickets;
        checkUnreadDriverTickets = () => Promise.resolve();
        endActiveRide();
        checkUnreadDriverTickets = originalCheckTickets;
        showDriverRatingModal({ _id: 'finished-driver-ride', passenger: { name: 'Passenger Test' } });
        return {
          activeRideCleared: activeRide === null,
          panelHidden: document.getElementById('active-panel').style.display === 'none',
          ratingRideId: _drRatingRideId,
          ratingPassenger: document.getElementById('dr-passenger-name').textContent
        };
      });

      expect(driverLifecycle).toEqual({
        activeRideCleared: true,
        panelHidden: true,
        ratingRideId: 'finished-driver-ride',
        ratingPassenger: 'Passenger Test'
      });
    } finally {
      await Promise.all([customerPage.close(), driverPage.close()]);
    }
  });

  test('persists settings, creates a ride, and refreshes only matching browser clients', async ({ browser, playwright }) => {
    const customerToken = token(customer);
    const adminToken = token({ _id: new mongoose.Types.ObjectId(), role: 'admin', isAdmin: true, name: 'Admin' });
    const matchingToken = token(matchingDriver);
    const otherToken = token(otherDriver);
    const baseURL = `http://127.0.0.1:${httpServer.address().port}`;
    const request = await playwright.request.newContext({ baseURL });

    const matchingPage = await browser.newPage();
    const otherPage = await browser.newPage();
    const customerPage = await browser.newPage();
    try {
      const initial = settingsFor(200, 100);
      const savedInitial = await request.patch('/api/admin/fare-settings', {
        headers: { authorization: `Bearer ${adminToken}` },
        data: { dailyFareSettings: initial }
      });
      expect(savedInitial.ok()).toBeTruthy();
      expect((await models.Settings.findOne({ key: 'daily_fare_settings' }).lean()).value['Car Mini Non-AC'].baseFare)
        .toBe(200);

      await Promise.all([
        openAuthenticatedClient(customerPage, baseURL, '/customer', customer, customerToken),
        openAuthenticatedClient(matchingPage, baseURL, '/driver', matchingDriver, matchingToken),
        openBrowserSocket(otherPage, baseURL, otherDriver)
      ]);

      await matchingPage.evaluate(() => toggleOnline(true));
      await expect.poll(async () => (await models.User.findById(matchingDriver._id).lean()).isOnline).toBe(true);
      await expect.poll(() => io.sockets.adapter.rooms.get('drivers:Car Mini Non-AC')?.size || 0).toBeGreaterThan(0);
      await expect.poll(async () => {
        const broadcast = await findRideBroadcastDrivers({ lat: 31.5204, lng: 74.3587 }, 'Car Mini');
        return broadcast.drivers.some(driver => String(driver._id) === String(matchingDriver._id));
      }).toBe(true);

      const rideResponse = await request.post('/api/rides', {
        headers: authHeaders(customer),
        data: {
          pickupLocation: { lat: 31.5204, lng: 74.3587, address: 'Live pickup' },
          dropoffLocation: { lat: 31.5304, lng: 74.3687, address: 'Live dropoff' },
          distance: 7,
          vehicleType: 'Car Mini',
          fare: 1
        }
      });
      expect(rideResponse.status()).toBe(201);
      const ride = await rideResponse.json();
      // The server owns fare calculation. Keep the initial assertion tied to
      // the quote returned with the created ride rather than duplicating a
      // fare value that can change with the configured /km rate.
      expect(ride.fare).toBe(ride.fareQuote.totalFare);
      const initialFare = ride.fare;

      await customerPage.evaluate(({ ride: createdRide }) => {
        activeRide = createdRide;
        activeLiveFare = createdRide.fare;
        showWaitingPanel(createdRide);
        connectToRideRoom(createdRide._id);
      }, { ride });
      await matchingPage.evaluate(({ ride: createdRide }) => {
        pendingRide = { ...createdRide, id: String(createdRide._id) };
        document.getElementById('rr-fare').textContent = `Rs ${createdRide.fare}`;
        document.getElementById('ride-request').style.display = 'block';
      }, { ride });

      await expect(customerPage.locator('#active-ride')).toBeVisible();
      await expect(customerPage.locator('#ar-live-fare')).toHaveText(`Rs ${initialFare}`);
      await expect(matchingPage.locator('#ride-request')).toBeVisible();
      await expect(matchingPage.locator('#rr-fare')).toHaveText(`Rs ${initialFare}`);

      const refreshed = settingsFor(500, 125);
      const savedRefresh = await request.patch('/api/admin/fare-settings', {
        headers: { authorization: `Bearer ${adminToken}` },
        data: { dailyFareSettings: refreshed }
      });
      expect(savedRefresh.ok()).toBeTruthy();

      await expect.poll(async () => (await fareEvents(customerPage)).length).toBe(1);
      await expect.poll(async () => (await fareEvents(matchingPage)).length).toBe(1);
      await expect.poll(async () => (await fareEvents(otherPage)).length).toBe(0);

      const customerEvents = await fareEvents(customerPage);
      const matchingEvents = await fareEvents(matchingPage);
      const refreshedFare = customerEvents[0].fareQuote.totalFare;
      expect(customerEvents[0]).toMatchObject({ id: ride._id, fare: refreshedFare });
      expect(matchingEvents[0]).toMatchObject({ id: ride._id, fare: refreshedFare });
      await expect(customerPage.locator('#ar-live-fare')).toHaveText(`Rs ${refreshedFare}`);
      await expect(matchingPage.locator('#rr-fare')).toHaveText(`Rs ${refreshedFare}`);
      await expect(otherPage.locator('body')).not.toContainText(`Rs ${refreshedFare}`);
      expect((await models.Ride.findById(ride._id).lean()).fare).toBe(refreshedFare);
      expect((await models.Settings.findOne({ key: 'daily_fare_settings' }).lean()).value['Car Mini Non-AC'])
        .toMatchObject({ baseFare: 500 });
    } finally {
      await Promise.all([matchingPage.close(), otherPage.close(), customerPage.close()]);
      await request.dispose();
    }
  });

  test('routes each Toyota category from the customer UI to only its matching driver', async ({ browser, playwright }) => {
    const customerToken = token(customer);
    const highroofToken = token(highroofDriver);
    const coasterToken = token(coasterDriver);
    const otherToken = token(otherDriver);
    const baseURL = `http://127.0.0.1:${httpServer.address().port}`;
    const request = await playwright.request.newContext({ baseURL });
    const customerPage = await browser.newPage();
    const highroofPage = await browser.newPage();
    const coasterPage = await browser.newPage();
    const otherPage = await browser.newPage();

    try {
      const fareSettings = settingsFor(200, 100);
      fareSettings['Toyota Highroof'] = {
        baseFare: 700,
        distanceSlabs: [{ minKm: 0, maxKm: null, rate: 130 }],
        peakRules: []
      };
      fareSettings['Toyota Saloon Coaster'] = {
        baseFare: 900,
        distanceSlabs: [{ minKm: 0, maxKm: null, rate: 170 }],
        peakRules: []
      };
      const saved = await request.patch('/api/admin/fare-settings', {
        headers: { authorization: `Bearer ${token({ _id: new mongoose.Types.ObjectId(), role: 'admin', isAdmin: true, name: 'Admin' })}` },
        data: { dailyFareSettings: fareSettings }
      });
      expect(saved.ok()).toBeTruthy();

      await Promise.all([
        openAuthenticatedClient(customerPage, baseURL, '/customer', customer, customerToken),
        openAuthenticatedClient(highroofPage, baseURL, '/driver', highroofDriver, highroofToken),
        openAuthenticatedClient(coasterPage, baseURL, '/driver', coasterDriver, coasterToken),
        openAuthenticatedClient(otherPage, baseURL, '/driver', otherDriver, otherToken)
      ]);
      await Promise.all([
        highroofPage.evaluate(() => toggleOnline(true)),
        coasterPage.evaluate(() => toggleOnline(true)),
        otherPage.evaluate(() => toggleOnline(true))
      ]);
      await expect.poll(async () => (await models.User.findById(highroofDriver._id).lean()).isOnline).toBe(true);
      await expect.poll(async () => (await models.User.findById(coasterDriver._id).lean()).isOnline).toBe(true);
      await expect.poll(async () => (await models.User.findById(otherDriver._id).lean()).isOnline).toBe(true);
      await expect.poll(() => io.sockets.adapter.rooms.get('drivers:Toyota Highroof')?.size || 0).toBeGreaterThan(0);
      await expect.poll(() => io.sockets.adapter.rooms.get('drivers:Toyota Saloon Coaster')?.size || 0).toBeGreaterThan(0);
      await expect.poll(() => io.sockets.adapter.rooms.get(`user:${highroofDriver._id}`)?.size || 0).toBe(1);
      await expect.poll(() => io.sockets.adapter.rooms.get(`user:${coasterDriver._id}`)?.size || 0).toBe(1);
      await expect.poll(() => highroofPage.evaluate(() => isOnline)).toBe(true);
      await expect.poll(() => coasterPage.evaluate(() => isOnline)).toBe(true);
      await expect.poll(async () => {
        const broadcast = await findRideBroadcastDrivers({ lat: 31.5204, lng: 74.3587 }, 'Toyota Highroof');
        return broadcast.drivers.some(driver => String(driver._id) === String(highroofDriver._id));
      }).toBe(true);
      await expect.poll(async () => {
        const broadcast = await findRideBroadcastDrivers({ lat: 31.5204, lng: 74.3587 }, 'Toyota Saloon Coaster');
        return broadcast.drivers.some(driver => String(driver._id) === String(coasterDriver._id));
      }).toBe(true);

      const cases = [
        {
          category: 'Toyota Highroof',
          driverPage: highroofPage,
          unrelatedPages: [coasterPage, otherPage],
          expectedFare: 1540
        },
        {
          category: 'Toyota Saloon Coaster',
          driverPage: coasterPage,
          unrelatedPages: [highroofPage, otherPage],
          expectedFare: 1880
        }
      ];
      for (const [index, { category, driverPage, unrelatedPages, expectedFare }] of cases.entries()) {
        if (index > 0) {
          await openAuthenticatedClient(customerPage, baseURL, '/customer', customer, customerToken);
        }
        await Promise.all([
          highroofPage.evaluate(() => hideRideRequest()),
          coasterPage.evaluate(() => hideRideRequest()),
          otherPage.evaluate(() => hideRideRequest())
        ]);
        await expect.poll(() => driverPage.evaluate(() => ({
          isOnline, activeRide: !!activeRide, sentOffer: !!sentOffer, pendingRide: !!pendingRide
        }))).toEqual({ isOnline: true, activeRide: false, sentOffer: false, pendingRide: false });
        await customerPage.evaluate(() => {
          pickup = { lat: 31.5204, lng: 74.3587, address: 'Toyota pickup' };
          dropoffs[0] = { lat: 31.5304, lng: 74.3687, address: 'Toyota dropoff' };
          activeStops = 1;
          routeDistanceKm = 7;
        });
        await customerPage.locator(`.vehicle-btn[data-type="${category}"]`)
          .evaluate(button => button.click());
        const expectedFareLabel = `Rs ${expectedFare.toLocaleString()}`;
        await expect(customerPage.locator('#fare-suggested-val')).toHaveText(expectedFareLabel);
        await expect(customerPage.locator('#book-btn')).toBeVisible();

        await customerPage.locator('#book-btn').evaluate(button => button.click());
        const availableRides = await driverPage.evaluate(async () => {
          const response = await fetch('/api/rides/available', {
            headers: {
              authorization: `Bearer ${localStorage.getItem('rh_token')}`,
              'x-session-token': localStorage.getItem('rh_session')
            }
          });
          return response.json();
        });
        expect(availableRides).toHaveLength(1);
        expect(availableRides[0]).toMatchObject({
          vehicleType: category,
          fare: expectedFare
        });
        await expect(customerPage.locator('#ar-live-fare')).toHaveText(expectedFareLabel);
        const otherAvailableRides = await otherPage.evaluate(async () => {
          const response = await fetch('/api/rides/available', {
            headers: {
              authorization: `Bearer ${localStorage.getItem('rh_token')}`,
              'x-session-token': localStorage.getItem('rh_session')
            }
          });
          return response.json();
        });
        expect(otherAvailableRides).toEqual([]);
        const ride = await models.Ride.findOne({ passenger: customer._id, vehicleType: category })
          .sort({ createdAt: -1 }).lean();
        expect(ride).toBeTruthy();
        expect(ride.fare).toBe(expectedFare);

        // Assert the real Socket.io notification opened the production request
        // card and rendered the category-specific fare on the matching page.
        await expect(driverPage.locator('#ride-request')).toBeVisible();
        await expect(driverPage.locator('#rr-vehicle')).toHaveText(category);
        await expect(driverPage.locator('#rr-fare')).toHaveText(`Rs ${expectedFare.toLocaleString()}`);
        await Promise.all(unrelatedPages.map(page =>
          expect(page.locator('#ride-request')).toBeHidden()
        ));
      }
    } finally {
      await Promise.all([
        customerPage.close(), highroofPage.close(), coasterPage.close(), otherPage.close()
      ]);
      await request.dispose();
    }
  });

  test('clears a Highroof request after takeover during a driver reconnect', async ({ browser, playwright }) => {
    const customerToken = token(customer);
    const takeoverToken = token(highroofTakeoverDriver);
    const baseURL = `http://127.0.0.1:${httpServer.address().port}`;
    const request = await playwright.request.newContext({ baseURL });
    const highroofPage = await browser.newPage();
    const coasterPage = await browser.newPage();

    try {
      await Promise.all([
        openAuthenticatedClient(highroofPage, baseURL, '/driver', highroofDriver, token(highroofDriver)),
        openAuthenticatedClient(coasterPage, baseURL, '/driver', coasterDriver, token(coasterDriver))
      ]);
      await Promise.all([
        highroofPage.evaluate(() => toggleOnline(true)),
        coasterPage.evaluate(() => toggleOnline(true))
      ]);
      await expect.poll(() => highroofPage.evaluate(() => isOnline)).toBe(true);
      await expect.poll(() => coasterPage.evaluate(() => isOnline)).toBe(true);
      await expect.poll(() => io.sockets.adapter.rooms.get('drivers:Toyota Highroof')?.size || 0).toBeGreaterThan(0);
      await expect.poll(() => io.sockets.adapter.rooms.get('drivers:Toyota Saloon Coaster')?.size || 0).toBeGreaterThan(0);
      // This driver intentionally has no browser page: the ride-recipient
      // snapshot must still permit a real eligible driver to take over while
      // the originally alerted driver is disconnected.
      await models.User.updateOne({ _id: highroofTakeoverDriver._id }, {
        $set: { isOnline: true, lastOnlineHeartbeat: new Date(), currentLocation: { lat: 31.5204, lng: 74.3587 } }
      });

      const rideResponse = await request.post('/api/rides', {
        headers: authHeaders(customer),
        data: {
          pickupLocation: { lat: 31.5204, lng: 74.3587, address: 'Highroof takeover pickup' },
          dropoffLocation: { lat: 31.5304, lng: 74.3687, address: 'Highroof takeover dropoff' },
          distance: 7,
          vehicleType: 'Toyota Highroof',
          fare: 1
        }
      });
      expect(rideResponse.status()).toBe(201);
      const ride = await rideResponse.json();

      await expect(highroofPage.locator('#ride-request')).toBeVisible();
      await expect(highroofPage.locator('#rr-vehicle')).toHaveText('Toyota Highroof');
      await expect(coasterPage.locator('#ride-request')).toBeHidden();

      // The original driver misses ride:taken while its socket is down.
      await highroofPage.evaluate(() => socket.disconnect());
      await expect.poll(() => highroofPage.evaluate(() => socket.connected)).toBe(false);

      const accepted = await request.patch(`/api/rides/${ride._id}/accept`, {
        headers: authHeaders(highroofTakeoverDriver)
      });
      expect(accepted.status()).toBe(200);

      await highroofPage.evaluate(() => socket.connect());
      await expect.poll(() => highroofPage.evaluate(() => socket.connected)).toBe(true);
      await expect(highroofPage.locator('#ride-request')).toBeHidden();
      await expect.poll(() => highroofPage.evaluate(() => ({
        pendingRide: !!pendingRide,
        sentOffer: !!sentOffer,
        activeRide: !!activeRide
      }))).toEqual({ pendingRide: false, sentOffer: false, activeRide: false });
      await expect.poll(async () => {
        const available = await highroofPage.evaluate(async () => {
          const response = await fetch('/api/rides/available', {
            headers: {
              authorization: `Bearer ${localStorage.getItem('rh_token')}`,
              'x-session-token': localStorage.getItem('rh_session')
            }
          });
          return response.json();
        });
        return available.some(availableRide => String(availableRide._id) === String(ride._id));
      }).toBe(false);
      await expect(coasterPage.locator('#ride-request')).toBeHidden();
    } finally {
      await Promise.all([highroofPage.close(), coasterPage.close()]);
      await request.dispose();
    }
  });

  test('blocks an unrelated driver from reading a ride they do not own', async ({ playwright }) => {
    const baseURL = `http://127.0.0.1:${httpServer.address().port}`;
    const request = await playwright.request.newContext({ baseURL });
    try {
      const heartbeat = new Date();
      await models.User.updateOne({ _id: matchingDriver._id }, {
        $set: { isOnline: true, lastOnlineHeartbeat: heartbeat, currentLocation: { lat: 31.5204, lng: 74.3587 } }
      });
      await models.User.updateOne({ _id: otherDriver._id }, {
        $set: {
          isOnline: true,
          vehicleType: 'Car Mini',
          lastOnlineHeartbeat: heartbeat,
          currentLocation: { lat: 40, lng: 40 }
        }
      });
      const created = await request.post('/api/rides', {
        headers: authHeaders(customer),
        data: {
          pickupLocation: { lat: 31.5204, lng: 74.3587, address: 'Private pickup' },
          dropoffLocation: { lat: 31.5304, lng: 74.3687, address: 'Private dropoff' },
          distance: 7,
          vehicleType: 'Car Mini',
          fare: 1
        }
      });
      expect(created.status()).toBe(201);
      const ride = await created.json();

      const unrelatedRead = await request.get(`/api/rides/${ride._id}`, {
        headers: authHeaders(otherDriver)
      });
      expect(unrelatedRead.status()).toBe(403);

      const unrelatedAcceptance = await request.patch(`/api/rides/${ride._id}/accept`, {
        headers: authHeaders(otherDriver)
      });
      expect(unrelatedAcceptance.status()).toBe(409);

      const notifiedAcceptance = await request.patch(`/api/rides/${ride._id}/accept`, {
        headers: authHeaders(matchingDriver)
      });
      expect(notifiedAcceptance.status()).toBe(200);

      const passengerRead = await request.get(`/api/rides/${ride._id}`, {
        headers: authHeaders(customer)
      });
      expect(passengerRead.status()).toBe(200);
    } finally {
      await request.dispose();
    }
  });

  test('removes a cancelled request and activates the winning Driver without a refresh', async ({ browser, playwright }) => {
    const customerToken = token(customer);
    const matchingToken = token(matchingDriver);
    const baseURL = `http://127.0.0.1:${httpServer.address().port}`;
    const request = await playwright.request.newContext({ baseURL });
    const driverPage = await browser.newPage();

    async function createRide(label) {
      const response = await request.post('/api/rides', {
        headers: authHeaders(customer),
        data: {
          pickupLocation: { lat: 31.5204, lng: 74.3587, address: `${label} pickup` },
          dropoffLocation: { lat: 31.5304, lng: 74.3687, address: `${label} dropoff` },
          distance: 7,
          vehicleType: 'Car Mini',
          fare: 1
        }
      });
      expect(response.status()).toBe(201);
      return response.json();
    }

    try {
      await openAuthenticatedClient(driverPage, baseURL, '/driver', matchingDriver, matchingToken);
      await driverPage.evaluate(() => toggleOnline(true));
      await expect.poll(() => driverPage.evaluate(() => isOnline)).toBe(true);
      await expect.poll(() => io.sockets.adapter.rooms.get('drivers:Car Mini Non-AC')?.size || 0).toBeGreaterThan(0);

      const cancelledRide = await createRide('Instant cancellation');
      await expect(driverPage.locator('#ride-request')).toBeVisible();
      // Browser automation does not grant notification/audio activation by
      // default. Start the same request alert explicitly so cancellation
      // verifies the cleanup path for an already-alerting offer.
      await driverPage.evaluate(() => startRideAlert(pendingRide));
      await expect.poll(() => driverPage.evaluate(rideId => ({
        pending: String(pendingRide?.id || pendingRide?._id) === String(rideId),
        alerting: !!alertInterval
      }), cancelledRide._id)).toEqual({ pending: true, alerting: true });

      const cancelled = await request.patch(`/api/rides/${cancelledRide._id}/cancel`, {
        headers: authHeaders(customer)
      });
      expect(cancelled.status()).toBe(200);
      await expect(driverPage.locator('#ride-request')).toBeHidden();
      await expect.poll(() => driverPage.evaluate(() => ({
        pendingRide: !!pendingRide,
        sentOffer: !!sentOffer,
        alertInterval: !!alertInterval,
        notification: !!rideNotification
      }))).toEqual({ pendingRide: false, sentOffer: false, alertInterval: false, notification: false });

      const acceptedRide = await createRide('Instant acceptance');
      await expect(driverPage.locator('#ride-request')).toBeVisible();
      const accepted = await request.patch(`/api/rides/${acceptedRide._id}/accept`, {
        headers: authHeaders(matchingDriver)
      });
      expect(accepted.status()).toBe(200);
      await expect(driverPage.locator('#ride-request')).toBeHidden();
      await expect(driverPage.locator('#active-panel')).toBeVisible();
      await expect.poll(() => driverPage.evaluate(rideId =>
        String(activeRide?._id) === String(rideId), acceptedRide._id
      )).toBe(true);
    } finally {
      await driverPage.close();
      await request.dispose();
    }
  });

  test('loads MapLibre vector maps without Leaflet or raster tile layers', async ({ browser }) => {
    const baseURL = `http://127.0.0.1:${httpServer.address().port}`;
    const context = await browser.newContext({
      viewport: { width: 430, height: 900 },
      deviceScaleFactor: 2
    });
    const customerPage = await context.newPage();
    const driverPage = await context.newPage();

    try {
      await Promise.all([
        openAuthenticatedClient(customerPage, baseURL, '/customer', customer, token(customer)),
        openAuthenticatedClient(driverPage, baseURL, '/driver', matchingDriver, token(matchingDriver))
      ]);
      await Promise.all([
        customerPage.evaluate(() => { if (!map) initMap(); }),
        driverPage.evaluate(() => { if (!map) initMap(); })
      ]);
      await Promise.all([
        customerPage.waitForFunction(() => map?.isStyleLoaded() === true),
        driverPage.waitForFunction(() => map?.isStyleLoaded() === true)
      ]);

      const mapDetails = await Promise.all([customerPage, driverPage].map(page =>
        page.evaluate(() => ({
          styleUrl: MAP_STYLE_URL,
          vectorSources: Object.values(map.getStyle()?.sources || {})
            .filter(source => source.type === 'vector')
            .map(source => source.url || source.tiles?.[0] || ''),
          canvas: Boolean(document.querySelector('#map .maplibregl-canvas')),
          leafletNodes: document.querySelectorAll('#map [class*="leaflet"]').length
        }))
      ));
      for (const details of mapDetails) {
        expect(details.styleUrl).toBe('https://demotiles.maplibre.org/style.json');
        expect(details.vectorSources.length).toBeGreaterThan(0);
        expect(details.canvas).toBe(true);
        expect(details.leafletNodes).toBe(0);
      }
    } finally {
      await context.close();
    }
  });
});
