'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const tick = () => new Promise(setImmediate);
for (const role of ['customer', 'driver']) {
  const customer = role === 'customer';
  const participant = customer ? 'driver' : 'passenger';
  const prefix = customer ? 'Customer' : 'Driver';
  const handler = `open${prefix}RideContact`;
  const merge = `merge${prefix}RideContact`;
  const panel = customer ? 'showMatchedPanel' : 'showActivePanel';
  const html = fs.readFileSync(`${__dirname}/../public/${role}.html`, 'utf8');
  const code = html.slice(html.indexOf(`function ${handler}`), html.indexOf(`function ${panel}`));
  const panelStart = html.indexOf(`function ${panel}`);
  const panelEnd = html.indexOf('\nfunction ', panelStart + 1);
  const initial = () => ({
    _id: 'ride-1', status: 'accepted',
    [participant]: { _id: 'person-1', phone: '0300-1234567' }
  });
  function harness(ride = initial()) {
    const elements = new Map();
    const messages = [], errors = [];
    const context = vm.createContext({
      console: { warn() {} }, activeRide: ride, activeDriverInfo: null,
      window: { location: { href: '' } },
      document: { getElementById(id) {
        if (!elements.has(id)) elements.set(id, { style: {}, classList: { add() {} }, replaceChildren() {} });
        return elements.get(id);
      } },
      apiCall: async () => { throw new Error('offline'); },
      showToast: message => errors.push(message),
      localStorage: { setItem() {} }, DRIVER_ACTIVE_RIDE_STORAGE_KEY: 'active',
      requestAnimationFrame() {}, map: null,
      setupCustomerActiveRideSheet() {}, setCustomerActiveRideSheetState() {},
      renderActiveWaitingFare() {}, updateCustomerCancellationControl() {}, updateActiveSheetSummary() {},
      hideIdleInfoPanel() {}, setupActiveRideSheet() {}, setActiveRideSheetState() {},
      updateNavigationDetails() {}, renderActiveButtons() {}, startActiveRideLocationSync() {},
      pendingVerificationPin: null, hideRidePin() {}
    });
    vm.runInContext(code, context);
    return { context, elements, messages, errors };
  }
  const anchor = action => ({ dataset: { contactAction: action }, getAttribute: () => '#' });

  test(`${role} contact: known number launches synchronously offline and stops bridge propagation`, () => {
    const { context, errors } = harness();
    let calls = 0, stopped = 0, prevented = 0;
    context.apiCall = async () => { calls++; throw new Error('offline'); };
    context[handler]({ preventDefault() { prevented++; }, stopPropagation() { stopped++; } }, anchor('call'));
    assert.equal(context.window.location.href, 'tel:+923001234567');
    assert.equal(context.activeRide[participant].phone, '+923001234567');
    assert.equal(calls, 0);
    assert.equal(stopped, 1);
    assert.equal(prevented, 1);
    assert.deepEqual(errors, []);
    if (customer) {
      context.window.location.href = '';
      context.window.ReactNativeWebView = { postMessage: message => errors.push(JSON.parse(message)) };
      context[handler](null, anchor('whatsapp'));
      assert.equal(context.window.location.href, '');
      assert.deepEqual(errors, [{ type: 'contact', url: 'https://wa.me/923001234567' }]);
    }
  });

  test(`${role} contact: identity-scoped snapshots recover blanks/zero but never another participant or ride`, () => {
    const { context } = harness();
    for (const phone of ['', ' ', null, undefined, 0, '0', 'invalid']) {
      const merged = context[merge]({ _id: 'ride-1', [participant]: { id: 'person-1', phone } });
      assert.equal(merged[participant].phone, '+923001234567');
    }
    for (const incoming of [
      { _id: 'ride-2', [participant]: { id: 'person-1' } },
      { _id: 'ride-1', [participant]: { id: 'person-2' } },
      { _id: 'ride-1', [participant]: null },
      { _id: 'ride-1', [participant]: { name: 'Identity unknown' } }
    ]) {
      const merged = context[merge](incoming);
      assert.equal(merged.contactPhone, '');
      assert.equal(merged.contact, null);
      assert.ok(!merged[participant]?.phone);
    }
    assert.equal(context[merge]({ _id: 'ride-1', [participant]: 'person-1' })[participant].phone, '+923001234567');
  });

  test(`${role} contact: missing number looks up API once, normalizes state and updates rendered targets`, async () => {
    const { context, elements, errors } = harness({ _id: 'ride-1', [participant]: { id: 'person-1', phone: 0 } });
    let calls = 0;
    context.apiCall = async path => {
      calls++;
      assert.equal(path, '/api/rides/ride-1/contact');
      return { contact: { id: 'person-1', phone: '0092 301 1234567' } };
    };
    context[handler](null, anchor('whatsapp'));
    assert.equal(context.window.location.href, '');
    await tick();
    assert.equal(calls, 1);
    assert.equal(context.activeRide[participant].phone, '+923011234567');
    assert.equal(context.window.location.href, 'https://wa.me/923011234567');
    assert.equal(elements.get('call-btn').href, 'tel:+923011234567');
    assert.equal(elements.get('whatsapp-btn').href, 'https://wa.me/923011234567');
    assert.deepEqual(errors, []);
  });

  test(`${role} contact: network, authorization, unavailable and invalid responses fail explicitly without placeholder navigation`, async () => {
    for (const failure of [
      new Error('Network unavailable'), Object.assign(new Error('Forbidden'), { status: 403 }),
      Object.assign(new Error('Contact unavailable'), { status: 422 }),
      { contact: { id: 'person-1', phone: 0 } },
      { contact: { id: 'person-2', phone: '03011234567' } }
    ]) {
      const { context, errors } = harness({ _id: 'ride-1', [participant]: { id: 'person-1' } });
      context.apiCall = async () => { if (failure instanceof Error) throw failure; return failure; };
      context[handler](null, anchor('call'));
      await tick();
      assert.equal(context.window.location.href, '');
      assert.equal(errors.length, 1);
    }
    const { context } = harness();
    context[handler](null, '#');
    assert.equal(context.window.location.href, '');
  });

  test(`${role} contact: delayed response/rejection cannot affect another ride or reassigned participant`, async () => {
    for (const change of ['ride', 'participant']) {
      for (const reject of [false, true]) {
        const { context, errors } = harness({ _id: 'ride-1', [participant]: { id: 'person-1' } });
        let finish;
        context.apiCall = () => new Promise((resolve, rejectPromise) => { finish = reject ? rejectPromise : resolve; });
        context[handler](null, anchor('call'));
        context.activeRide = change === 'ride'
          ? { _id: 'ride-2', [participant]: { id: 'person-1' } }
          : { _id: 'ride-1', [participant]: { id: 'person-2' } };
        finish(reject ? new Error('Late failure') : { contact: { id: 'person-1', phone: '03011234567' } });
        await tick();
        assert.equal(context.window.location.href, '');
        assert.ok(!context.activeRide[participant].phone);
        assert.deepEqual(errors, []);
      }
    }
  });

  test(`${role} contact: all assigned states render valid links or keyboard-operable actions, never tel:0 or href="#"`, () => {
    for (const status of ['accepted', 'arrived', 'in-progress']) {
      for (const phone of [0, '0', '03001234567']) {
        const { context, elements } = harness({ _id: 'ride-1', status, [participant]: { id: 'person-1', phone } });
        vm.runInContext(html.slice(panelStart, panelEnd), context);
        if (customer) context[panel](context.activeRide.driver, 100, status);
        else context[panel](context.activeRide);
        const rendered = elements.get(customer ? 'ar-contact-btns' : 'ap-call-passenger').innerHTML;
        assert.doesNotMatch(rendered, /href="#"|tel:0|wa\.me\/0/);
        if (phone === '03001234567') assert.match(rendered, /href="tel:\+923001234567"/);
        else {
          assert.doesNotMatch(rendered, /href=/);
          assert.match(rendered, /role="button" tabindex="0"/);
          assert.match(rendered, /onkeydown=/);
        }
      }
    }
  });

  test(`${role} contact: actual restore/reconnect path retains only same-ride participant number`, async () => {
    const { context } = harness();
    function load(name) {
      const start = html.indexOf(`function ${name}`);
      const rest = html.slice(start);
      const next = /\n(?:async )?function /.exec(rest);
      vm.runInContext(`${name.startsWith('reconcile') ? 'async ' : ''}${rest.slice(0, next ? next.index : rest.length)}`, context);
    }
    if (customer) {
      context.CUSTOMER_ACTIVE_RIDE_STATUSES = new Set(['accepted', 'arrived', 'in-progress']);
      context.customerOffersFromRide = () => [];
      context.connectToRideRoom = () => {};
      context.showMatchedPanel = () => {};
      load('renderRestoredCustomerRide');
      context.renderRestoredCustomerRide({ _id: 'ride-1', status: 'arrived', driver: { id: 'person-1', phone: '0' } });
      assert.equal(context.activeRide.driver.phone, '+923001234567');
      assert.equal(context.activeDriverInfo.phone, '+923001234567');
      context.renderRestoredCustomerRide({ _id: 'ride-2', status: 'in-progress', driver: { id: 'person-1', phone: '0' } });
      assert.equal(context.activeRide.driver.phone, '');
    } else {
      vm.runInContext(html.slice(panelStart, panelEnd), context);
      context.socket = null;
      context.showRideOnMap = () => {};
      context.apiCall = async () => ({ ride: { _id: 'ride-1', status: 'arrived', passenger: { id: 'person-1', phone: 0 } } });
      load('reconcileActiveRideAfterReconnect');
      await context.reconcileActiveRideAfterReconnect();
      assert.equal(context.activeRide.passenger.phone, '+923001234567');
      context.apiCall = async () => ({ ride: { _id: 'ride-1', status: 'in-progress', passenger: { id: 'person-2', phone: 0 } } });
      await context.reconcileActiveRideAfterReconnect();
      assert.equal(context.activeRide.passenger.phone, '');
    }
  });

  if (customer) {
    test('customer contact: accepted socket profile is persisted, not just rendered or leaked from previous driver', () => {
      const { context } = harness();
      let accepted;
      context.socket = { on(event, handler) { assert.equal(event, 'ride:accepted'); accepted = handler; } };
      context.showMatchedPanel = driver => { assert.equal(driver, context.activeRide.driver); };
      const start = html.indexOf("socket.on('ride:accepted', ({ driver, rideId: acceptedRideId })");
      const end = html.indexOf("socket.on('ride:pickup-reached'", start);
      vm.runInContext(html.slice(start, end), context);
      accepted({ rideId: 'ride-1', driver: { id: 'person-2', phone: '03021234567' } });
      assert.equal(context.activeRide.driver.phone, '+923021234567');
      assert.equal(context.activeDriverInfo, context.activeRide.driver);
      accepted({ rideId: 'ride-1', driver: { id: 'person-3', phone: 0 } });
      assert.equal(context.activeRide.driver.phone, '');
      assert.equal(context.activeRide.contactPhone, '');
    });
  } else {
    for (const entry of ['bootApp', 'recoverDriverConnection']) {
      test(`driver contact: ${entry} hydrates accepted ride while offline and socket client unavailable`, async () => {
        const { context, elements } = harness(null);
        Object.assign(context, {
          token: 'test-session', user: { role: 'driver', name: 'Driver' }, isOnline: false, socket: null,
          loadDriverAdvanceBookings() {}, handleDriverNotificationHash() {},
          loadStats() {}, loadDailyFeeSettings() {}, initTodayFareWidget() {},
          loadDriverFareSettings() {}, loadLongRangeState() {}, loadDriverTerms() {},
          showRideOnMap() {}, renderAvailabilityState() {},
          recoverDriverConnection() {},
          startDriverHeartbeat() { assert.fail('Active contact restore must not force availability online'); },
          reconcileRideRequestsAfterReconnect() { assert.fail('Offline drivers must not request new rides'); }
        });
        context.window.addEventListener = () => {};
        context.document.addEventListener = () => {};
        let lookups = 0;
        context.apiCall = async path => {
          assert.equal(path, '/api/driver/active-ride');
          lookups++;
          return { ride: { _id: 'ride-1', status: 'accepted', passenger: { id: 'person-1', phone: '03001234567' } } };
        };
        vm.runInContext(html.slice(panelStart, panelEnd), context);
        for (const name of ['reconcileActiveRideAfterReconnect', 'connectSocket', entry]) {
          const pattern = new RegExp(`(?:async )?function ${name}\\(`);
          const start = pattern.exec(html).index;
          const rest = html.slice(start);
          const next = /\n(?:async )?function /.exec(rest);
          vm.runInContext(rest.slice(0, next.index), context);
        }
        assert.doesNotThrow(() => context[entry]());
        await tick();
        assert.equal(lookups, 1, 'HTTP restore must not wait for a Socket.IO connect/online event');
        assert.equal(context.isOnline, false);
        assert.equal(context.activeRide.passenger.phone, '+923001234567');
        assert.equal(elements.get('active-panel').style.display, 'block');
        const contact = elements.get('ap-call-passenger').innerHTML;
        assert.match(contact, /data-contact-action="call"/);
        assert.match(contact, /data-contact-action="whatsapp"/);
        assert.match(contact, /href="tel:\+923001234567"/);
      });
    }
  }
}