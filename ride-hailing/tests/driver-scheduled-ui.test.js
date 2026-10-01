'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('../../artifacts/myride-driver-mobile/node_modules/typescript');

const webSource = fs.readFileSync(path.join(__dirname, '../public/driver.html'), 'utf8');
const nativeSource = fs.readFileSync(path.join(__dirname, '../../artifacts/myride-driver-mobile/context/DriverRuntime.tsx'), 'utf8');
const screenSource = fs.readFileSync(path.join(__dirname, '../../artifacts/myride-driver-mobile/app/index.tsx'), 'utf8');
const booking = overrides => ({
  id: 'scheduled-1', _id: 'scheduled-1', advanceBookingId: 'scheduled-1',
  status: 'pending', scheduledFor: '2099-01-01T15:30:00.000Z',
  fare: 850, passengerCount: 2,
  pickupLocation: { lat: 31.52, lng: 74.35, address: 'Scheduled pickup' },
  dropoffLocation: { lat: 31.55, lng: 74.37, address: 'Scheduled destination' },
  passenger: { id: 'customer-1', name: 'Customer' },
  ...overrides,
});
const tick = () => new Promise(setImmediate);
const between = (source, start, end) => {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, start);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(to, -1, end);
  return source.slice(from, to);
};

function webHarness() {
  const elements = new Map();
  const messages = [], calls = [];
  const context = vm.createContext({
    token: 'driver-token', user: { id: 'driver-1' },
    driverAdvanceBookings: [], driverAdvanceBookingEventVersion: 0,
    driverAdvanceBookingLifecycle: new Map(),
    driverAdvanceRefreshTimer: 1,
    driverAdvanceAcceptingIds: new Set(),
    document: { getElementById(id) {
      if (!elements.has(id)) elements.set(id, {
        style: {}, innerHTML: '',
        insertAdjacentHTML(_, html) { this.innerHTML = html + this.innerHTML; },
      });
      return elements.get(id);
    } },
    formatStopAddr: stop => stop.address,
    escapeDriverText: value => String(value),
    showToast: message => messages.push(message),
    apiCall: async (...args) => { calls.push(args); throw new Error('Feed offline'); },
  });
  vm.runInContext(between(webSource, 'function handleDriverAdvanceBookingEvent', 'async function startAdvanceBooking'), context);
  vm.runInContext(between(webSource, 'async function declineAdvanceBooking', 'async function cancelAdvanceBooking'), context);
  return {
    context, elements, calls, messages,
    event: context.handleDriverAdvanceBookingEvent,
    refresh: context.loadDriverAdvanceBookings,
    accept: context.acceptAdvanceBooking,
    ignore: context.declineAdvanceBooking,
    getBookings: () => context.driverAdvanceBookings,
    setBookings: value => { context.driverAdvanceBookings = value; },
    api: handler => { context.apiCall = (...args) => { calls.push(args); return handler(...args); }; },
  };
}

function nativeHarness() {
  let bookings = [], error = null;
  const calls = [];
  const context = vm.createContext({
    useCallback: fn => fn, tokenRef: { current: 'driver-token' },
    sessionRef: { current: 'session-1' }, userRef: { current: { id: 'driver-1' } },
    advanceBookingsEventVersion: { current: 0 },
    advanceBookingLifecycle: { current: new Map() },
    setAdvanceBookings: next => { bookings = typeof next === 'function' ? next(bookings) : next; },
    setAdvanceBookingsLoading() {}, setError: next => { error = next; },
    participantId: value => typeof value === 'string' ? value : value?.id || value?._id || '',
    api: async (...args) => { calls.push(args); throw new Error('Feed offline'); },
    apiWithTimeout: async (...args) => { calls.push(args); throw new Error('Feed offline'); },
  });
  const code = [
    between(nativeSource, 'function normalizeAdvanceBooking', 'function isRideOfferLive'),
    between(nativeSource, '  const refreshAdvanceBookings =', '  const refreshPayments ='),
    between(nativeSource, '  const acceptAdvanceBooking =', '  const counterAdvanceBooking ='),
    between(nativeSource, '  const declineAdvanceBooking =', '  const cancelAdvanceBooking ='),
    'globalThis.handlers = { handleAdvanceBookingEvent, refreshAdvanceBookings, acceptAdvanceBooking, declineAdvanceBooking };',
  ].join('\n');
  vm.runInContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText, context);
  return {
    context, calls,
    event: context.handlers.handleAdvanceBookingEvent,
    refresh: context.handlers.refreshAdvanceBookings,
    accept: context.handlers.acceptAdvanceBooking,
    ignore: context.handlers.declineAdvanceBooking,
    getBookings: () => bookings,
    setBookings: value => { bookings = value; },
    getError: () => error,
    api: handler => {
      context.api = context.apiWithTimeout = (...args) => { calls.push(args); return handler(...args); };
    },
  };
}

for (const [client, createHarness] of [['web', webHarness], ['native', nativeHarness]]) {
  test(`${client}: complete scheduled broadcast is shown immediately without REST`, () => {
    const h = createHarness();
    h.event({ booking: booking() });
    assert.equal(h.getBookings().length, 1);
    assert.equal(h.getBookings()[0].scheduledFor, booking().scheduledFor);
    assert.equal(h.calls.length, 0);
    if (client === 'web') {
      const html = h.elements.get('driver-scheduled-ride-list').innerHTML;
      assert.equal(h.elements.get('scheduled-ride-home-panel').style.display, 'block');
      assert.match(html, /Scheduled Ride · Advance Booking/);
      assert.match(html, /Pickup:/);
      assert.match(html, /acceptAdvanceBooking\('scheduled-1'\)/);
      assert.match(html, />Ignore<\/button>/);
      assert.doesNotMatch(html, /waiting for Customer/);
    }
  });

  test(`${client}: ID-only loser notice, cancellation and conversion remove requests without REST`, () => {
    const h = createHarness();
    for (const status of ['assigned', 'cancelled', 'converted']) {
      h.setBookings([booking()]);
      h.event({ advanceBookingId: 'scheduled-1', status }, status);
      assert.equal(h.getBookings().length, 0, status);
    }
    h.setBookings([booking()]);
    h.event(booking({ status: 'assigned', driver: { id: 'other-driver' } }), 'assigned');
    assert.equal(h.getBookings().length, 0);
    assert.equal(h.calls.length, 0);
  });

  test(`${client}: partial winner event immediately marks the existing card assigned`, async () => {
    const h = createHarness();
    h.event(booking());
    h.event({ id: 'scheduled-1', driver: { id: 'driver-1' } }, 'assigned');
    assert.equal(h.getBookings()[0].status, 'assigned');
    assert.equal(h.getBookings()[0].pickupLocation.address, 'Scheduled pickup');
    await tick();
    assert.equal(h.getBookings()[0].status, 'assigned');
  });

  test(`${client}: delayed pending socket/push/counter snapshots cannot downgrade assigned data`, async () => {
    const h = createHarness();
    const assigned = booking({
      status: 'assigned', driver: { id: 'driver-1', name: 'Assigned Driver' }, fare: 850,
      passenger: { id: 'customer-1', name: 'Assigned Customer', phone: '+923001234567' },
      myOffer: { type: 'accept', price: 850 },
    });
    h.event(assigned, 'assigned');
    const original = JSON.stringify(h.getBookings()[0]);
    const latePending = booking({
      fare: 999, driver: null,
      passenger: { id: 'customer-1', name: 'Old Customer' },
      myOffer: { type: 'counter', price: 999 },
    });
    for (const payload of [
      latePending,
      { booking: latePending },
      { advanceBooking: latePending },
      { ...latePending, status: undefined },
      { bookingId: 'scheduled-1' },
    ]) h.event(payload);
    await tick();
    assert.equal(JSON.stringify(h.getBookings()[0]), original);
    assert.equal(h.calls.length, 0);
  });

  test(`${client}: assignment hydrated after reload also rejects late pending feed and pushes`, async () => {
    const h = createHarness();
    const assigned = booking({
      status: 'assigned', driver: { id: 'driver-1' }, fare: 850,
      passenger: { id: 'customer-1', name: 'Assigned Customer', phone: '+923001234567' },
    });
    h.api(async () => [assigned]);
    await h.refresh();
    const original = JSON.stringify(h.getBookings()[0]);
    h.api(async () => [booking({ fare: 123, driver: null })]);
    await h.refresh();
    h.event({ booking: booking({ fare: 123, driver: null }) });
    assert.equal(JSON.stringify(h.getBookings()[0]), original);
  });

  test(`${client}: taken/terminal tombstones reject delayed pending and assigned events and feeds`, async () => {
    for (const removal of [
      { id: 'scheduled-1', status: 'assigned' }, // privacy-safe taken notice to loser
      booking({ status: 'assigned', driver: { id: 'other-driver' } }),
      { bookingId: 'scheduled-1', status: 'cancelled' },
      { bookingId: 'scheduled-1', status: 'converted' },
      { bookingId: 'scheduled-1', status: 'failed' },
    ]) {
      const h = createHarness();
      h.event(booking());
      h.event(removal);
      assert.equal(h.getBookings().length, 0);
      h.event({ booking: booking() });
      h.event({ advanceBooking: booking() });
      h.event(booking({ status: 'assigned', driver: { id: 'driver-1' } }), 'assigned');
      h.api(async () => [booking()]);
      await h.refresh();
      assert.equal(h.getBookings().length, 0, JSON.stringify(removal));
      h.api(async () => [booking({ status: 'assigned', driver: { id: 'driver-1' } })]);
      await h.refresh();
      assert.equal(h.getBookings().length, 0, 'immutable tombstone cannot be undone by an older assigned read');
    }
  });

  test(`${client}: Ignore hides pending broadcasts but complete Admin assignment to self overrides it`, async () => {
    const h = createHarness();
    h.event(booking());
    h.api(async () => ({ ok: true }));
    await h.ignore('scheduled-1');
    h.event({ booking: booking() });
    assert.equal(h.getBookings().length, 0);
    const assigned = booking({
      status: 'assigned', driver: { id: 'driver-1', name: 'Admin-selected Driver' },
      passenger: { id: 'customer-1', name: 'Assigned Customer', phone: '+923001234567' },
      fare: 875,
    });
    h.event({ booking: assigned }, 'assigned');
    assert.equal(h.getBookings().length, 1);
    assert.equal(h.getBookings()[0].status, 'assigned');
    assert.equal(h.getBookings()[0].fare, 875);
    assert.equal(h.getBookings()[0].passenger.phone, '+923001234567');
    h.event({ booking: booking({ fare: 123 }) });
    h.event({ bookingId: 'scheduled-1', declined: true });
    assert.equal(h.getBookings()[0].status, 'assigned');
    assert.equal(h.getBookings()[0].fare, 875);
  });

  test(`${client}: REST recovery restores Admin assignment after Ignore, not late pending feeds`, async () => {
    const h = createHarness();
    h.event(booking());
    h.api(async () => ({ ok: true }));
    await h.ignore('scheduled-1');
    h.api(async () => [booking()]);
    await h.refresh();
    assert.equal(h.getBookings().length, 0);
    const assigned = booking({
      status: 'assigned', driver: 'driver-1',
      passenger: { id: 'customer-1', name: 'Assigned Customer', phone: '+923001234567' },
      fare: 875,
    });
    h.api(async () => [assigned]);
    await h.refresh();
    assert.equal(h.getBookings().length, 1);
    assert.equal(h.getBookings()[0].status, 'assigned');
    assert.equal(h.getBookings()[0].fare, 875);
    assert.equal(h.getBookings()[0].passenger.phone, '+923001234567');
    h.api(async () => [booking({ fare: 123 })]);
    await h.refresh();
    assert.equal(h.getBookings()[0].status, 'assigned');
    assert.equal(h.getBookings()[0].fare, 875);
  });

  test(`${client}: Ignore cannot bypass a later taken/terminal removal`, async () => {
    for (const removal of [
      { id: 'scheduled-1', status: 'assigned' },
      booking({ status: 'assigned', driver: { id: 'other-driver' } }),
      { bookingId: 'scheduled-1', status: 'cancelled' },
      { bookingId: 'scheduled-1', status: 'converted' },
      { bookingId: 'scheduled-1', status: 'failed' },
    ]) {
      const h = createHarness();
      h.event(booking());
      h.event({ bookingId: 'scheduled-1', declined: true });
      h.event(removal);
      h.event(booking({ status: 'assigned', driver: { id: 'driver-1' } }), 'assigned');
      h.api(async () => [booking({ status: 'assigned', driver: { id: 'driver-1' } })]);
      await h.refresh();
      assert.equal(h.getBookings().length, 0, JSON.stringify(removal));
    }
  });

  test(`${client}: delayed Ignore response does not hide a newer Admin assignment`, async () => {
    const h = createHarness();
    h.event(booking());
    let resolveIgnore;
    h.api(() => new Promise(resolve => { resolveIgnore = resolve; }));
    const ignore = h.ignore('scheduled-1');
    h.event(booking({ status: 'assigned', driver: { id: 'driver-1' }, fare: 875 }), 'assigned');
    resolveIgnore({ ok: true });
    await ignore;
    assert.equal(h.getBookings()[0].status, 'assigned');
    assert.equal(h.getBookings()[0].fare, 875);
  });

  test(`${client}: forward terminal transition removes an assigned card permanently`, async () => {
    for (const status of ['cancelled', 'converted', 'failed']) {
      const h = createHarness();
      h.event(booking({ status: 'assigned', driver: { id: 'driver-1' } }), 'assigned');
      h.event({ bookingId: 'scheduled-1', status }, status);
      h.event({ booking: booking() });
      await tick();
      assert.equal(h.getBookings().length, 0, status);
    }
  });

  test(`${client}: late acceptance response cannot resurrect a booking already removed by lifecycle event`, async () => {
    const h = createHarness();
    h.event(booking());
    let resolveAcceptance;
    h.api(url => {
      assert.ok(url.endsWith('/accept'), 'tombstoned acceptance must not rehydrate an old assignment');
      return new Promise(resolve => { resolveAcceptance = resolve; });
    });
    const acceptance = h.accept('scheduled-1');
    h.event({ bookingId: 'scheduled-1', status: 'cancelled' }, 'cancelled');
    resolveAcceptance(booking({ status: 'assigned', driver: { id: 'driver-1' } }));
    if (client === 'native') await assert.rejects(acceptance, /no longer available/);
    else {
      await acceptance;
      assert.ok(h.messages.every(message => !message.includes('assigned to you')));
    }
    assert.equal(h.getBookings().length, 0);
  });

  test(`${client}: dispatching lifecycle cannot regress to assigned/pending but can become terminal`, () => {
    const h = createHarness();
    h.event(booking({ status: 'assigned', driver: { id: 'driver-1' } }), 'assigned');
    h.event(booking({ status: 'dispatching', driver: { id: 'driver-1' } }), 'dispatching');
    h.event(booking({ status: 'assigned', driver: { id: 'driver-1' }, fare: 123 }), 'assigned');
    h.event(booking());
    assert.equal(h.getBookings()[0].status, 'dispatching');
    assert.equal(h.getBookings()[0].fare, 850);
    h.event({ bookingId: 'scheduled-1', status: 'converted' }, 'converted');
    assert.equal(h.getBookings().length, 0);
  });

  test(`${client}: stale REST response cannot resurrect a taken request or replace a fresh broadcast`, async () => {
    const h = createHarness();
    let resolveRead;
    h.api(() => new Promise(resolve => { resolveRead = resolve; }));
    const read = h.refresh();
    h.event(booking());
    resolveRead([]);
    await read;
    assert.equal(h.getBookings().length, 1);
    const readAgain = h.refresh();
    h.event({ id: 'scheduled-1', status: 'assigned' }, 'assigned');
    resolveRead([booking()]);
    await readAgain;
    assert.equal(h.getBookings().length, 0);
  });

  test(`${client}: direct Accept consumes assigned response even with socket absent and feed offline`, async () => {
    const h = createHarness();
    h.event(booking());
    const assigned = booking({ status: 'assigned', driver: { id: 'driver-1' }, myOffer: { type: 'accept', price: 850 } });
    h.api(async (url, methodOrToken, bodyOrSession, init) => {
      if (url.endsWith('/accept')) {
        assert.equal(client === 'web' ? methodOrToken : init.method, 'PATCH');
        return assigned;
      }
      throw new Error('Feed offline');
    });
    await h.accept('scheduled-1');
    await tick();
    assert.equal(h.getBookings()[0].status, 'assigned');
    assert.equal(h.getBookings()[0].fare, 850);
    assert.equal(h.calls.filter(call => call[0].endsWith('/accept')).length, 1);
    if (client === 'web') {
      const html = h.elements.get('driver-scheduled-ride-list').innerHTML;
      assert.match(html, /Assigned to you/);
      assert.doesNotMatch(html, /waiting for Customer/);
    }
  });

  test(`${client}: timeout checks authoritative assignment and recovers committed acceptance`, async () => {
    const h = createHarness();
    h.event(booking());
    h.api(async url => {
      if (url.endsWith('/accept')) throw new Error('Response timed out');
      return [booking({ status: 'assigned', driver: { id: 'driver-1' } })];
    });
    await h.accept('scheduled-1');
    assert.equal(h.getBookings()[0].status, 'assigned');
    if (client === 'web') assert.match(h.messages.at(-1), /assigned to you/);
  });

  test(`${client}: assigned booking rehydrates on reload and Ignore cannot return from an older feed`, async () => {
    const reloaded = createHarness();
    reloaded.api(async () => [booking({ status: 'assigned', driver: { id: 'driver-1' } })]);
    await reloaded.refresh();
    assert.equal(reloaded.getBookings()[0].status, 'assigned');
    const h = createHarness();
    h.event(booking());
    let resolveRead;
    h.api(url => url.endsWith('/decline') ? Promise.resolve({ ok: true }) : new Promise(resolve => { resolveRead = resolve; }));
    const read = h.refresh();
    await h.ignore('scheduled-1');
    resolveRead([booking()]);
    await read;
    assert.equal(h.getBookings().length, 0);
  });

  test(`${client}: old user's feed cannot populate a new Driver session`, async () => {
    const h = createHarness();
    let resolveRead;
    h.api(() => new Promise(resolve => { resolveRead = resolve; }));
    const read = h.refresh();
    if (client === 'web') h.context.token = 'new-driver-token';
    else h.context.tokenRef.current = 'new-driver-token';
    resolveRead([booking()]);
    await read;
    assert.equal(h.getBookings().length, 0);
  });

  test(`${client}: malformed feed reports an error without erasing a committed assignment`, async () => {
    const h = createHarness();
    h.setBookings([booking({ status: 'assigned', driver: { id: 'driver-1' } })]);
    h.api(async () => ({ unexpected: true }));
    if (client === 'native') await assert.rejects(h.refresh(), /invalid response/);
    else {
      await h.refresh();
      assert.match(h.elements.get('driver-advance-booking-list').innerHTML, /invalid response/);
    }
    assert.equal(h.getBookings()[0].status, 'assigned');
  });
}

test('native scheduled card labels pickup prominently and keeps Accept/Ignore separate from optional counteroffers', () => {
  const actions = [];
  const context = vm.createContext({
    React: { createElement: (type, props, ...children) => ({ type, props: props || {}, children }) },
    useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect() {}, styles: new Proxy({}, { get: () => ({}) }),
    View: 'View', Text: 'Text', Pressable: 'Pressable', TextInput: 'TextInput', ActivityIndicator: 'ActivityIndicator', Ionicons: 'Ionicons',
  });
  const code = [
    between(screenSource, 'function formatDriverDateTime', 'function driverHistoryStatus'),
    between(screenSource, 'function DriverAdvanceBookingsPanel', 'function DriverBottomNavigation'),
    'globalThis.panel = DriverAdvanceBookingsPanel;',
  ].join('\n');
  vm.runInContext(ts.transpileModule(code, { fileName: 'scheduled-panel.tsx', compilerOptions: { target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.React } }).outputText, context);
  const tree = context.panel({
    colors: {}, bookings: [booking({ myOffer: { type: 'counter', price: 950 } })],
    loading: false, onRefresh() {}, onStart() {}, onCancel() {}, onCounter() {},
    onAccept: id => actions.push(['accept', id]), onDecline: id => actions.push(['ignore', id]),
  });
  const nodes = [];
  const visit = item => {
    if (Array.isArray(item)) return item.forEach(visit);
    if (!item || typeof item !== 'object') return;
    nodes.push(item);
    item.children?.forEach(visit);
  };
  visit(tree);
  assert.ok(nodes.some(node => node.props.testID === 'scheduled-ride-label-scheduled-1'));
  assert.ok(nodes.some(node => node.props.testID === 'scheduled-ride-pickup-scheduled-1' && node.children[0] === 'Pickup: '));
  nodes.find(node => node.props.testID === 'scheduled-ride-accept-scheduled-1').props.onPress();
  nodes.find(node => node.props.testID === 'scheduled-ride-ignore-scheduled-1').props.onPress();
  assert.deepEqual(actions, [['accept', 'scheduled-1'], ['ignore', 'scheduled-1']]);
  assert.match(screenSource, /!!runtime\.advanceBookings\?\.length && <DriverAdvanceBookingsPanel/);
});

test('web optional counter-offer retains direct Accept and Ignore', () => {
  const h = webHarness();
  h.event(booking({ myOffer: { type: 'counter', price: 950 } }));
  const html = h.elements.get('driver-scheduled-ride-list').innerHTML;
  assert.match(html, /Optional counter-offer sent/);
  assert.match(html, /acceptAdvanceBooking\('scheduled-1'\)/);
  assert.match(html, />Ignore<\/button>/);
});

test('native queued state updaters read the newest immutable lifecycle, not old pending snapshots', () => {
  for (const terminal of [false, true]) {
    const h = nativeHarness();
    const queued = [];
    const commit = h.context.setAdvanceBookings;
    h.context.setAdvanceBookings = next => queued.push(next);
    h.event(booking());
    h.event(booking({
      status: 'assigned', driver: { id: 'driver-1' },
      passenger: { id: 'customer-1', phone: '+923001234567' },
    }), 'assigned');
    h.event({ booking: booking({ fare: 123, driver: null }) });
    if (terminal) h.event({ bookingId: 'scheduled-1', status: 'converted' }, 'converted');
    queued.forEach(commit);
    if (terminal) assert.equal(h.getBookings().length, 0);
    else {
      assert.equal(h.getBookings()[0].status, 'assigned');
      assert.equal(h.getBookings()[0].fare, 850);
      assert.equal(h.getBookings()[0].passenger.phone, '+923001234567');
    }
  }
});