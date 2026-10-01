'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync(`${__dirname}/../public/customer.html`, 'utf8');
const tick = () => new Promise(setImmediate);
function functionSource(name) {
  const match = new RegExp(`(?:async )?function ${name}\\(`).exec(html);
  assert.ok(match, `Missing production handler ${name}`);
  const rest = html.slice(match.index);
  const next = /\n(?:async )?function /.exec(rest);
  return rest.slice(0, next ? next.index : rest.length);
}

function harness() {
  const elements = new Map(), handlers = new Map(), browserHandlers = new Map();
  const messages = [], matched = [], waiting = [], joined = [];
  const document = {
    activeElement: null, visibilityState: 'visible',
    getElementById(id) {
      if (!elements.has(id)) {
        const classes = new Set();
        const element = {
          innerHTML: '', textContent: '', style: { display: 'none' }, attributes: {},
          classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) },
          setAttribute(key, value) { this.attributes[key] = value; },
          focus() { document.activeElement = this; }
        };
        elements.set(id, element);
      }
      return elements.get(id);
    },
    addEventListener(name, handler) { browserHandlers.set(name, handler); }
  };
  const context = vm.createContext({
    console: { warn() {} }, document,
    window: { location: { href: '' }, addEventListener(name, handler) { browserHandlers.set(name, handler); } },
    token: 'customer-session', sessionToken: null, user: { _id: 'customer-1', role: 'customer' },
    socket: null, activeRide: null, activeDriverInfo: null, activeLiveFare: 0, driverOffers: [],
    pendingVerificationPin: null, lastDriverLocation: null,
    CUSTOMER_ACTIVE_RIDE_STATUSES: new Set(['requested', 'accepted', 'arrived', 'in-progress']),
    customerRideRecoveryInFlight: null, customerRideRecoveryLastAt: 0, customerRideRecoveryListenersInstalled: false,
    apiCall: async path => path === '/api/advance-bookings/my' ? [] : null,
    io: () => ({
      connected: true,
      on(name, handler) { handlers.set(name, handler); },
      emit() {}, connect() {}
    }),
    showToast: (message, type) => messages.push({ message, type }),
    escapeLocationText: value => String(value ?? '').replace(/[&<>"']/g, char => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[char])),
    customerOffersFromRide: () => [],
    showMatchedPanel: (driver, fare, status) => matched.push({ driver, fare, status }),
    showWaitingPanel: ride => waiting.push(ride),
    renderOffers() {}, revealRidePinIfAtPickup() {}, updateLiveTripTracking() {},
    connectToRideRoom: id => joined.push(id),
    setCustomerRideRecoveryState() {}, endRide() {},
    syncCustomerRideState: async () => {},
    confirm: () => true
  });
  const stateStart = html.indexOf('let advanceBookingsLoadInFlight');
  vm.runInContext(html.slice(stateStart, html.indexOf('function syncLocationSheetViewport', stateStart)), context);
  for (const name of ['extractCustomerDriverPhone', 'customerRideParticipantId', 'mergeCustomerRideContact']) {
    vm.runInContext(functionSource(name), context);
  }
  vm.runInContext(html.slice(html.indexOf('function formatAdvanceBookingStatus'), html.indexOf('// ── Add / Remove Stops')), context);
  for (const name of ['renderRestoredCustomerRide', 'restoreCustomerActiveRide', 'installCustomerRideRecoveryListeners', 'connectSocket']) {
    vm.runInContext(functionSource(name), context);
  }
  context.connectSocket();
  return {
    context, elements, handlers, browserHandlers, messages, matched, waiting, joined,
    state: expression => vm.runInContext(expression, context),
    list: () => document.getElementById('advance-booking-list').innerHTML,
    details: () => document.getElementById('advance-assignment-details').innerHTML,
    modal: () => document.getElementById('advance-assignment-modal')
  };
}

const pending = () => ({
  _id: 'booking-1', status: 'pending', driver: null,
  scheduledFor: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
  pickupLocation: { address: 'Pickup Street' }, dropoffLocation: { address: 'Destination Avenue' },
  vehicleType: 'Car Sedan', fare: 850, passengerCount: 2,
  counterOffers: [
    { driver: 'driver-1', driverName: 'Assigned Ali', price: 850, type: 'accept' },
    { driver: 'driver-2', driverName: 'Other Driver', price: 900, type: 'counter' }
  ]
});
const assigned = () => ({
  ...pending(), status: 'assigned', assignedAt: '2026-10-01T12:00:00.000Z',
  driver: {
    _id: 'driver-1', name: 'Assigned Ali', phone: '0300-1234567',
    vehicleType: 'Car Sedan', vehicleModel: 'Corolla', vehiclePlate: 'ABC-123',
    rating: 4.8, profilePhoto: '/uploads/driver_profiles/ali.jpg'
  }
});

test('actual assigned socket handler immediately confirms Driver profile, photo, contact and pickup without Choose/Finding', () => {
  const h = harness();
  h.context.applyCustomerAdvanceBooking(pending());
  assert.match(h.list(), /Finding a Driver/);
  assert.match(h.list(), /Optional Driver counter-offers/);
  h.context.apiCall = () => new Promise(() => {});
  h.handlers.get('advance-booking:assigned')(assigned());
  for (const view of [h.list(), h.details()]) {
    assert.match(view, /Assigned Ali/);
    assert.match(view, /\/uploads\/driver_profiles\/ali\.jpg/);
    assert.match(view, /Corolla/);
    assert.match(view, /ABC-123/);
    assert.match(view, /4\.8/);
    assert.match(view, /Pickup time:/);
    assert.match(view, /tel:\+923001234567/);
    assert.match(view, /https:\/\/wa\.me\/923001234567/);
    assert.doesNotMatch(view, /Finding a Driver|Choose counter-offer|Optional Driver counter-offers/);
  }
  assert.match(h.details(), /No further Driver selection is needed/);
  assert.equal(h.modal().style.display, 'flex');
  assert.equal(h.modal().attributes['aria-hidden'], 'false');
  assert.equal(h.context.activeRide, null, 'Assignment is a scheduled confirmation, not an early active ride');
  assert.match(h.messages.at(-1).message, /Assigned Ali.*Pickup:/);
  assert.ok(h.list().includes(h.context.formatAdvancePickupTime(assigned())));
});

test('real HTTP load normalizes raw-id and sparse profiles, refreshes an already-open modal, deduplicates notification', async () => {
  const h = harness();
  h.context.applyCustomerAdvanceBooking(assigned(), { notify: true });
  const notificationCount = h.messages.length;
  for (const driver of ['driver-1', { id: 'driver-1', phone: 0, profilePhoto: '', name: '' }]) {
    h.context.apiCall = async () => [{ _id: 'booking-1', status: 'assigned', driver, fare: 975 }];
    await h.context.loadAdvanceBookings();
    assert.match(h.list(), /Assigned Ali/);
    assert.match(h.details(), /975/);
    assert.match(h.details(), /ali\.jpg/);
    assert.match(h.details(), /tel:\+923001234567/);
    assert.equal(h.messages.length, notificationCount);
  }
  h.context.apiCall = async () => [{
    id: 'booking-1', status: 'assigned', driver: { id: 'driver-1', phone: '0092 301 7654321', name: 'Updated Ali' }
  }];
  await h.context.refreshAdvanceBookings();
  assert.match(h.details(), /Updated Ali/);
  assert.match(h.details(), /tel:\+923017654321/);
  assert.doesNotMatch(h.details(), /tel:\+923001234567/);
});

test('scheduled merge never leaks a former Driver profile or phone across reassignment, unknown identity or another booking', () => {
  const h = harness(), prior = assigned();
  for (const source of [
    { _id: 'booking-1', status: 'assigned', driver: { id: 'driver-2', name: 'New Driver', phone: 0 } },
    { _id: 'booking-2', status: 'assigned', driver: 'driver-1' },
    { _id: 'booking-1', status: 'assigned', driver: { name: 'Unknown identity', phone: 0 } },
    { _id: 'booking-1', status: 'assigned', driver: null }
  ]) {
    const merged = h.context.normalizeCustomerAdvanceBooking(source, prior);
    assert.ok(!merged.driver?.phone);
    assert.ok(!merged.driver?.profilePhoto);
    assert.notEqual(merged.driver?.name, 'Assigned Ali');
    assert.equal(merged.contactPhone, '');
  }
  const same = h.context.normalizeCustomerAdvanceBooking({ advanceBookingId: 'booking-1', fare: 990 }, prior);
  assert.equal(same.driver.phone, '+923001234567');
  assert.equal(same.driver.profilePhoto, '/uploads/driver_profiles/ali.jpg');
  assert.equal(same.scheduledFor, prior.scheduledFor);
  const inferred = h.context.normalizeCustomerAdvanceBooking({ ...assigned(), status: 'pending' });
  assert.equal(inferred.status, 'assigned');
});

test('assignment event wins over an earlier in-flight pending/empty HTTP snapshot', async () => {
  for (const stale of [[pending()], []]) {
    const h = harness();
    let resolve;
    h.context.apiCall = () => new Promise(done => { resolve = done; });
    const loading = h.context.loadAdvanceBookings();
    h.handlers.get('advance-booking:assigned')(assigned());
    resolve(stale);
    await loading;
    assert.match(h.list(), /Driver assigned/);
    assert.match(h.details(), /Assigned Ali/);
    assert.doesNotMatch(h.list(), /Finding a Driver|Choose counter-offer/);
    assert.equal(h.state('customerAdvanceBookings.size'), 1);
  }
});

test('actual late pending offer handler and later HTTP snapshot cannot undo assignment or replace its fare/profile', async () => {
  const h = harness();
  h.context.apiCall = async () => [assigned()];
  h.handlers.get('advance-booking:assigned')(assigned());
  await tick();
  const count = h.messages.length;
  const stale = { ...pending(), fare: 500, scheduledFor: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString() };
  h.context.apiCall = async () => [stale];
  h.handlers.get('advance-booking:offer')(stale);
  await tick();
  assert.equal(h.state("customerAdvanceBookings.get('booking-1').status"), 'assigned');
  assert.equal(h.state("customerAdvanceBookings.get('booking-1').fare"), 850);
  assert.equal(h.state("customerAdvanceBookings.get('booking-1').driver.phone"), '+923001234567');
  assert.match(h.list(), /Assigned Ali/);
  assert.match(h.details(), /ali\.jpg/);
  assert.equal(h.modal().style.display, 'flex');
  assert.doesNotMatch(h.list(), /Finding a Driver|Choose counter-offer/);
  assert.equal(h.messages.length, count, 'Late pending offer must not issue a misleading response toast');
  h.handlers.get('advance-booking:offer')({ bookingId: 'booking-1', driver: null, counterOffers: pending().counterOffers });
  await tick();
  assert.equal(h.state("customerAdvanceBookings.get('booking-1').driver.name"), 'Assigned Ali');
  assert.equal(h.messages.length, count);
});

test('actual delayed create response cannot regress an assignment received while POST is still pending', async () => {
  const h = harness();
  const created = pending();
  let finishCreate;
  Object.assign(h.context, {
    pickup: { lat: 24.86, lng: 67.01, address: 'Pickup Street' },
    dropoffs: [{ lat: 24.87, lng: 67.02, address: 'Destination Avenue' }],
    currentFareQuote: { totalFare: 850 }, offeredFare: 850, customerFareOffset: 0,
    selectedVehicle: 'Car Sedan', routeDurationMinutes: 15,
    advanceBookingPayload: () => ({ activeDropoffsList: h.context.dropoffs, dist: 5 }),
    resolveRideLocationAddress: async value => value,
    isGenericRideLocationAddress: () => false,
    toggleAdvanceBookingControls() {}, switchAppTab() {}
  });
  h.context.document.getElementById('pickup-input').value = 'Pickup Street';
  h.context.document.getElementById('scheduled-for-input').value = created.scheduledFor.slice(0, 16);
  h.context.document.getElementById('scheduled-passenger-count').value = '2';
  h.context.apiCall = async (path, method) => {
    if (path === '/api/advance-bookings' && method === 'POST') {
      return new Promise(resolve => { finishCreate = resolve; });
    }
    assert.equal(path, '/api/advance-bookings/my');
    return [created];
  };
  vm.runInContext(functionSource('scheduleRide'), h.context);
  const creating = h.context.scheduleRide();
  await tick();
  assert.equal(typeof finishCreate, 'function');
  h.handlers.get('advance-booking:assigned')({ ...assigned(), scheduledFor: created.scheduledFor });
  await tick();
  finishCreate(created);
  await creating;
  await tick();
  assert.equal(h.state("customerAdvanceBookings.get('booking-1').status"), 'assigned');
  assert.equal(h.state("customerAdvanceBookings.get('booking-1').driver.name"), 'Assigned Ali');
  assert.equal(h.modal().style.display, 'flex');
  assert.match(h.details(), /tel:\+923001234567/);
  assert.doesNotMatch(h.list(), /Finding a Driver|Choose counter-offer/);
  assert.ok(!h.messages.some(({ message }) => /We will assign a Driver|responded/.test(message)));
});

test('terminal bookings stay terminal after late pending, assignment and counter-offer events', async () => {
  for (const status of ['converted', 'cancelled', 'failed']) {
    const h = harness();
    const final = { ...assigned(), status, driver: status === 'cancelled' ? null : assigned().driver };
    h.context.applyCustomerAdvanceBooking(final);
    h.context.apiCall = async () => [pending()];
    h.handlers.get('advance-booking:offer')(pending());
    await tick();
    h.handlers.get('advance-booking:assigned')(assigned());
    await tick();
    assert.equal(h.state("customerAdvanceBookings.get('booking-1').status"), status);
    assert.equal(h.modal().style.display, 'none');
    assert.doesNotMatch(h.list(), /Finding a Driver|Choose counter-offer|View Driver profile/);
    assert.ok(!h.messages.some(({ message }) => /responded|is assigned/.test(message)));
  }
});

test('partial assigned event and duplicate notifications preserve complete profile without reopening dismissed modal', async () => {
  const h = harness();
  h.context.apiCall = async () => [assigned()];
  h.handlers.get('advance-booking:assigned')(assigned());
  await tick();
  h.context.closeAdvanceAssignmentModal();
  const count = h.messages.length;
  h.handlers.get('advance-booking:assigned')({ bookingId: 'booking-1', driver: 'driver-1' });
  await tick();
  assert.equal(h.modal().style.display, 'none');
  assert.equal(h.messages.length, count);
  assert.match(h.list(), /Assigned Ali/);
  assert.match(h.list(), /ali\.jpg/);
  h.context.openAdvanceAssignmentModal('booking-1');
  assert.match(h.details(), /Assigned Ali/);
});

test('reconnect, browser focus/pageshow/visibility, and native restore entry recover assignments for scheduled-only Customer', async () => {
  for (const signal of ['connect', 'focus', 'pageshow', 'visibilitychange', 'native']) {
    const h = harness();
    let scheduledReads = 0;
    h.context.apiCall = async path => {
      if (path === '/api/advance-bookings/my') { scheduledReads++; return [assigned()]; }
      assert.equal(path, '/api/rides/active');
      return null;
    };
    h.context.installCustomerRideRecoveryListeners();
    if (signal === 'connect') h.handlers.get('connect')();
    else if (signal === 'native') await h.context.restoreCustomerActiveRide({ reason: 'resume' });
    else h.browserHandlers.get(signal)();
    await tick();
    assert.equal(scheduledReads, 1, signal);
    assert.equal(h.context.activeRide, null);
    assert.match(h.list(), /Driver assigned/);
    assert.match(h.details(), /Assigned Ali/);
    assert.equal(h.modal().style.display, 'flex');
  }
});

test('counter-offer PATCH renders returned assignment immediately without waiting for broadcast or list refresh', async () => {
  const h = harness();
  h.context.applyCustomerAdvanceBooking(pending());
  const calls = [];
  h.context.apiCall = async (path, method, body) => {
    calls.push({ path, method, body });
    if (path.endsWith('/accept-driver')) return assigned();
    return new Promise(() => {});
  };
  await h.context.acceptAdvanceDriver('booking-1', 'driver-1');
  assert.equal(calls[0].path, '/api/advance-bookings/booking-1/accept-driver');
  assert.equal(calls[0].method, 'PATCH');
  assert.equal(calls[0].body.driverId, 'driver-1');
  assert.match(h.list(), /Assigned Ali/);
  assert.equal(h.modal().style.display, 'flex');
  assert.doesNotMatch(h.list(), /Choose counter-offer/);
});

test('actual converted handler restores accepted/arrived/in-progress rides using matched panel, not Finding Driver', async () => {
  for (const status of ['accepted', 'arrived', 'in-progress']) {
    const h = harness();
    h.context.applyCustomerAdvanceBooking(assigned(), { notify: true });
    const ride = { _id: 'ride-1', status, fare: 850, driver: assigned().driver };
    h.context.apiCall = async path => path === '/api/advance-bookings/my'
      ? [{ ...assigned(), status: 'converted', ride: 'ride-1' }] : ride;
    h.handlers.get('advance-booking:converted')({ bookingId: 'booking-1', rideId: 'ride-1' });
    await tick();
    assert.equal(h.context.activeRide.status, status);
    assert.equal(h.context.activeRide.driver.phone, '+923001234567');
    assert.equal(h.matched.length, 1);
    assert.equal(h.matched[0].status, status);
    assert.equal(h.waiting.length, 0);
    assert.equal(h.modal().style.display, 'none');
    assert.deepEqual(h.joined, ['ride-1']);
  }
});

test('scheduled contact actions launch normalized browser/native links offline and stop bridge propagation', () => {
  const h = harness();
  h.context.applyCustomerAdvanceBooking(assigned());
  let stopped = 0, prevented = 0, reads = 0;
  h.context.apiCall = async () => { reads++; throw new Error('offline'); };
  const event = { preventDefault() { prevented++; }, stopPropagation() { stopped++; } };
  const anchor = action => ({ dataset: { advanceBookingId: 'booking-1', contactAction: action } });
  assert.equal(h.context.openCustomerAdvanceContact(event, anchor('call')), false);
  assert.equal(h.context.window.location.href, 'tel:+923001234567');
  h.context.window.location.href = '';
  const native = [];
  h.context.window.ReactNativeWebView = { postMessage: message => native.push(JSON.parse(message)) };
  h.context.openCustomerAdvanceContact(event, anchor('whatsapp'));
  assert.deepEqual(native, [{ type: 'contact', url: 'https://wa.me/923001234567' }]);
  assert.equal(h.context.window.location.href, '');
  assert.equal(stopped, 2);
  assert.equal(prevented, 2);
  assert.equal(reads, 0);
});

test('reassignment refresh updates open notification, removes old contact, and unavailable contact fails explicitly', async () => {
  const h = harness();
  h.context.applyCustomerAdvanceBooking(assigned(), { notify: true });
  h.context.apiCall = async () => [{
    _id: 'booking-1', status: 'assigned', driver: { id: 'driver-2', name: 'New Driver', phone: 0 },
    scheduledFor: pending().scheduledFor
  }];
  await h.context.loadAdvanceBookings();
  assert.match(h.details(), /New Driver/);
  assert.match(h.details(), /Contact unavailable/);
  assert.doesNotMatch(h.details(), /Assigned Ali|ali\.jpg|tel:|wa\.me/);
  assert.equal(h.context.openCustomerAdvanceContact(null, { dataset: { advanceBookingId: 'booking-1', contactAction: 'call' } }), false);
  assert.equal(h.context.window.location.href, '');
  assert.equal(h.messages.at(-1).type, 'error');
});

test('refresh failure keeps assigned card/modal; invalid envelopes and conversion failures surface real errors', async () => {
  const h = harness();
  h.context.applyCustomerAdvanceBooking(assigned(), { notify: true });
  for (const response of [new Error('Network unavailable'), { bookings: [] }]) {
    h.context.apiCall = async () => { if (response instanceof Error) throw response; return response; };
    await h.context.refreshAdvanceBookings();
    assert.match(h.list(), /Assigned Ali/);
    assert.match(h.details(), /Assigned Ali/);
    assert.equal(h.messages.at(-1).type, 'error');
  }
  h.context.apiCall = async path => {
    if (path === '/api/advance-bookings/my') return [{ ...assigned(), status: 'converted' }];
    throw new Error('Ride could not be recovered');
  };
  h.handlers.get('advance-booking:converted')({ bookingId: 'booking-1', rideId: 'ride-1' });
  await tick();
  assert.ok(h.messages.some(({ message, type }) => type === 'error' && message === 'Ride could not be recovered'));
});

test('cancellation closes an open assigned notification, and session reset ignores delayed old-user responses', async () => {
  const h = harness();
  h.context.applyCustomerAdvanceBooking(assigned(), { notify: true });
  h.context.apiCall = async () => [{ ...pending(), status: 'cancelled' }];
  h.handlers.get('advance-booking:cancelled')({ bookingId: 'booking-1' });
  assert.equal(h.modal().style.display, 'none');
  await tick();
  assert.doesNotMatch(h.list(), /Assigned Ali|Phone Call|View Driver profile/);
  let resolve;
  h.context.apiCall = () => new Promise(done => { resolve = done; });
  const oldRequest = h.context.loadAdvanceBookings();
  h.context.resetCustomerAdvanceBookings();
  resolve([assigned()]);
  await oldRequest;
  assert.equal(h.state('customerAdvanceBookings.size'), 0);
  assert.equal(h.modal().style.display, 'none');
  assert.match(h.list(), /No advance bookings/);
});

test('missing optional profile/time safely renders; unsafe photo and HTML content never become executable markup', () => {
  const h = harness();
  h.context.applyCustomerAdvanceBooking({
    id: 'booking-1', status: 'assigned',
    driver: { id: 'driver-1', name: '<script>alert(1)</script>', profilePhoto: 'javascript:alert(1)', phone: '0' }
  }, { notify: true });
  assert.match(h.details(), /Pickup time unavailable/);
  assert.match(h.details(), /Contact unavailable/);
  assert.match(h.details(), /&lt;script&gt;/);
  assert.doesNotMatch(h.details(), /<script>|javascript:|tel:0|wa\.me\/0|Invalid Date/);
});