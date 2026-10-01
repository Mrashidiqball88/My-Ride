'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// Execute the shipped Admin functions, not a second implementation of the UI.
// No server, database, browser workflow, or credentials are needed.
const html = fs.readFileSync(require.resolve('../public/admin.html'), 'utf8');
const stateSource = html.slice(html.indexOf('let currentAdvanceBookingStatus'), html.indexOf('let currentSOSFilter'));
const bookingSource = html.slice(html.indexOf('function resetAdvanceBookingState('), html.indexOf('function rideBadge('));
function functionSource(name) {
  const start = html.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.notEqual(start, -1);
  const rest = html.slice(start);
  return rest.slice(0, rest.search(/\n(?:\/\/ ──|(?:async )?function )/));
}

const BOOKING_ID = '507f1f77bcf86cd799439011';
const DRIVER_ID = '507f1f77bcf86cd799439012';
const nextTurn = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function booking(overrides = {}) {
  return {
    _id: BOOKING_ID, status: 'pending', reservationStatus: 'pending',
    scheduledFor: new Date(Date.now() + 3_600_000).toISOString(),
    customer: { name: 'Customer <One>', phone: '03000000000' }, driver: null,
    pickupLocation: { address: 'Pickup' }, dropoffLocation: { address: 'Destination' },
    passengerCount: 2, vehicleType: 'Car Mini', ...overrides
  };
}
const driver = {
  id: DRIVER_ID, name: 'Online Driver <One>', vehicleModel: 'Cultus',
  vehiclePlate: 'ABC-123', phone: '03001111111'
};

function attributes(source) {
  const result = Object.fromEntries([...source.matchAll(/([\w-]+)="([^"]*)"/g)].map(match => [match[1], match[2]]));
  if (/\bdisabled(?:\s|$|>)/.test(source)) result.disabled = true;
  return result;
}

// Small DOM adapter: HTML replacement detaches old children, and selects obey
// real option-value semantics. Tests exercise rendered controls and their actual
// inline handlers, including late responses targeting detached elements.
function harness({ permissions = ['viewAdvanceBookings', 'manageAdvanceBookings'], respond } = {}) {
  const elements = new Map(), requests = [], toasts = [], handlers = new Map(), timers = new Map();
  class Element {
    constructor(tag = 'div', attrs = {}) {
      this.tagName = tag;
      this.attrs = attrs;
      this.style = {};
      this.dataset = {};
      this.disabled = !!attrs.disabled;
      this.children = new Set();
      this.replacements = 0;
      this._html = '';
      this._value = '';
      this.textContent = '';
      const classes = new Set();
      this.classList = {
        contains: value => classes.has(value),
        toggle(value, enabled) { if (enabled) classes.add(value); else classes.delete(value); },
        add: value => classes.add(value), remove: value => classes.delete(value)
      };
    }
    set innerHTML(value) {
      this._html = value;
      this.replacements++;
      this.textContent = value.replace(/<[^>]+>/g, '');
      if (this.tagName === 'select') {
        this.optionValues = [...value.matchAll(/<option\b[^>]*value="([^"]*)"/g)].map(match => match[1]);
        this._value = this.optionValues[0] || '';
      }
      if (this === elements.get('advance-bookings-tbody')) {
        for (const id of this.children) elements.delete(id);
        this.children.clear();
        for (const match of value.matchAll(/<(select|button|span)\b([^>]*)>([\s\S]*?)<\/\1>/g)) {
          const attrs = attributes(match[2]);
          if (!attrs.id) continue;
          const child = new Element(match[1], attrs);
          child.innerHTML = match[3];
          elements.set(attrs.id, child);
          this.children.add(attrs.id);
        }
      }
    }
    get innerHTML() { return this._html; }
    set value(value) { this._value = this.optionValues?.includes(value) ? value : ''; }
    get value() { return this._value; }
  }
  for (const id of ['advance-bookings-tbody', 'advance-bookings-feedback', 'advance-booking-cnt', 'sec-advance-bookings']) {
    elements.set(id, new Element());
  }
  elements.get('sec-advance-bookings').classList.add('active');
  const tabs = ['all', 'pending', 'assigned', 'converted', 'cancelled'].map(status => {
    const tab = new Element();
    tab.dataset.advanceStatus = status;
    return tab;
  });
  let timerId = 0;
  const document = {
    visibilityState: 'visible',
    getElementById: id => elements.get(id) || null,
    querySelectorAll: selector => selector === '[data-advance-status]' ? tabs : []
  };
  const allowed = new Set(permissions);
  const context = vm.createContext({
    document, console,
    hasPermission: key => allowed.has(key),
    api: async (path, method = 'GET', body = null) => {
      requests.push({ path, method, body: body && JSON.parse(JSON.stringify(body)) });
      const response = respond ? await respond(path, method, body) : path.includes('assignment-options') ? [driver] : [];
      return JSON.parse(JSON.stringify(response));
    },
    showToast: (message, type) => toasts.push({ message, type }),
    fmtDate: value => new Date(value).toISOString(),
    confirm: () => true,
    setInterval: (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId; },
    clearInterval: id => timers.delete(id),
    io: () => ({ on: (event, callback) => handlers.set(event, callback) })
  });
  vm.runInContext(`let adminToken = 'admin-session'; let socket = null;\n${stateSource}\n${bookingSource}\n${functionSource('escHtml')}\n${functionSource('connectSocket')}`, context);
  return {
    context, elements, requests, toasts, handlers, timers, tabs, allowed, document,
    element: prefix => elements.get(`${prefix}-${BOOKING_ID}`),
    choose(id = DRIVER_ID) {
      const select = elements.get(`advance-driver-${BOOKING_ID}`);
      select.value = id;
      vm.runInContext(select.attrs.onchange, context);
    },
    click(prefix) {
      return vm.runInContext(elements.get(`${prefix}-${BOOKING_ID}`).attrs.onclick, context);
    }
  };
}

test('the complete Admin inline script parses', () => {
  const script = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].find(match => match[1].includes('const API ='));
  assert.ok(script);
  assert.doesNotThrow(() => new vm.Script(script[1]));
});

test('actual assignment controls stay disabled during options loading and require a selection', async () => {
  const options = deferred();
  const row = booking();
  const ui = harness({ respond: path => path.includes('assignment-options') ? options.promise : [row] });
  const loading = ui.context.loadAdvanceBookings();
  await nextTurn();
  assert.equal(ui.element('advance-driver').disabled, true);
  assert.equal(ui.element('advance-assign').disabled, true);
  assert.match(ui.element('advance-driver').innerHTML, /Loading available online Drivers/);
  await ui.context.assignAdvanceBooking(BOOKING_ID);
  assert.equal(ui.requests.filter(request => request.method === 'PATCH').length, 0);
  options.resolve([driver]);
  await loading;
  assert.equal(ui.element('advance-driver').disabled, false);
  assert.equal(ui.element('advance-assign').disabled, true);
  assert.match(ui.element('advance-driver').innerHTML, /Online Driver &lt;One&gt;/);
  assert.match(ui.element('advance-driver').innerHTML, /ABC-123.*03001111111/);
  ui.choose();
  assert.equal(ui.element('advance-assign').disabled, false);
});

test('option errors and empty options disable assignment but expose a working retry', async () => {
  let mode = 'error';
  const row = booking();
  const ui = harness({ respond: path => {
    if (!path.includes('assignment-options')) return [row];
    if (mode === 'error') throw new Error('Eligibility service unavailable');
    return mode === 'empty' ? [] : [driver];
  } });
  await ui.context.loadAdvanceBookings();
  assert.equal(ui.element('advance-assign').disabled, true);
  assert.equal(ui.element('advance-drivers-refresh').disabled, false);
  assert.match(ui.element('advance-assignment-feedback').textContent, /Eligibility service unavailable/);
  mode = 'empty';
  await ui.click('advance-drivers-refresh');
  assert.match(ui.element('advance-driver').innerHTML, /No available online Drivers/);
  assert.equal(ui.element('advance-driver').disabled, true);
  assert.equal(ui.element('advance-assignment-feedback').textContent, '');
  mode = 'available';
  await ui.click('advance-drivers-refresh');
  ui.choose();
  assert.equal(ui.element('advance-assign').disabled, false);
});

test('late list success or failure cannot overwrite the currently selected filter', async () => {
  for (const staleFails of [false, true]) {
    const old = deferred();
    const assigned = booking({ status: 'assigned', reservationStatus: 'assigned', driver: { id: DRIVER_ID, name: 'Assigned Driver' } });
    const ui = harness({ respond: path => path.endsWith('status=pending') ? old.promise : path.endsWith('status=assigned') ? [assigned] : [assigned] });
    const first = ui.context.loadAdvanceBookings('pending');
    await ui.context.loadAdvanceBookings('assigned');
    if (staleFails) old.reject(new Error('Old request failed'));
    else old.resolve([booking()]);
    await first;
    assert.match(ui.elements.get('advance-bookings-tbody').innerHTML, /Assigned Driver/);
    assert.doesNotMatch(ui.elements.get('advance-bookings-tbody').innerHTML, /Old request failed|advance-driver-/);
    assert.equal(ui.tabs.find(tab => tab.dataset.advanceStatus === 'assigned').classList.contains('active'), true);
  }
});

test('a late options response never enables or populates a replacement row', async () => {
  const old = deferred(), fresh = deferred();
  let optionRequest = 0;
  const row = booking();
  const ui = harness({ respond: path => path.includes('assignment-options') ? (++optionRequest === 1 ? old.promise : fresh.promise) : [row] });
  const first = ui.context.loadAdvanceBookings();
  await nextTurn();
  const detachedSelect = ui.element('advance-driver');
  const second = ui.context.loadAdvanceBookings();
  await nextTurn();
  const currentSelect = ui.element('advance-driver');
  assert.notEqual(currentSelect, detachedSelect);
  old.resolve([driver]);
  await first;
  assert.equal(currentSelect.disabled, true);
  assert.match(currentSelect.innerHTML, /Loading available online Drivers/);
  fresh.resolve([]);
  await second;
  assert.match(currentSelect.innerHTML, /No available online Drivers/);
  assert.equal(ui.element('advance-assign').disabled, true);
});

test('assignment sends the captured driverId once, locks pending controls, and renders success without a socket or successful refetch', async () => {
  const mutation = deferred();
  let listRequests = 0;
  const row = booking();
  const ui = harness({ respond: (path, method) => {
    if (method === 'PATCH') return mutation.promise;
    if (path.includes('assignment-options')) return [driver];
    if (++listRequests > 1) throw new Error('Refresh disconnected');
    return [row];
  } });
  await ui.context.loadAdvanceBookings();
  ui.choose();
  const assigning = ui.click('advance-assign');
  assert.equal(ui.element('advance-driver').disabled, true);
  assert.equal(ui.element('advance-assign').disabled, true);
  assert.equal(ui.element('advance-assign').textContent, 'Assigning…');
  assert.equal(ui.element('advance-drivers-refresh').disabled, true);
  await ui.context.assignAdvanceBooking(BOOKING_ID);
  const patches = ui.requests.filter(request => request.method === 'PATCH');
  assert.equal(patches.length, 1);
  assert.deepEqual(patches[0], { path: `/api/admin/advance-bookings/${BOOKING_ID}/assign`, method: 'PATCH', body: { driverId: DRIVER_ID } });
  mutation.resolve({ _id: BOOKING_ID, status: 'assigned', driver: { _id: DRIVER_ID, name: 'Chosen Driver' } });
  await assigning;
  assert.match(ui.elements.get('advance-bookings-tbody').innerHTML, /Chosen Driver|Accepted \/ Assigned/);
  assert.equal(ui.element('advance-assign'), undefined);
  assert.match(ui.elements.get('advance-bookings-feedback').textContent, /Refresh disconnected/);
  assert.ok(ui.toasts.some(toast => toast.type === 'success'));
});

test('an assignment conflict reports the server reason and refreshes the competing assignment', async () => {
  let assignedElsewhere = false;
  const pending = booking();
  const assigned = booking({ status: 'assigned', reservationStatus: 'assigned', driver: { id: DRIVER_ID, name: 'Other Admin Driver' } });
  const ui = harness({ respond: (path, method) => {
    if (method === 'PATCH') {
      assignedElsewhere = true;
      throw Object.assign(new Error('Advance booking was already assigned to another Driver'), { status: 409 });
    }
    if (path.includes('assignment-options')) return [driver];
    return [assignedElsewhere ? assigned : pending];
  } });
  await ui.context.loadAdvanceBookings();
  ui.choose();
  await ui.click('advance-assign');
  assert.ok(ui.toasts.some(toast => toast.type === 'error' && /already assigned/.test(toast.message)));
  assert.match(ui.elements.get('advance-bookings-tbody').innerHTML, /Other Admin Driver/);
  assert.equal(ui.element('advance-assign'), undefined);
});

test('a pre-mutation GET cannot restore an unassigned row after successful assignment', async () => {
  const stale = deferred();
  const pending = booking();
  const assigned = booking({ status: 'assigned', reservationStatus: 'assigned', driver: { id: DRIVER_ID, name: 'Confirmed Driver' } });
  let listRequests = 0;
  const ui = harness({ respond: (path, method) => {
    if (method === 'PATCH') return { status: 'assigned', driver: { _id: DRIVER_ID, name: 'Confirmed Driver' } };
    if (path.includes('assignment-options')) return [driver];
    if (++listRequests === 2) return stale.promise;
    return listRequests === 1 ? [pending] : [assigned];
  } });
  await ui.context.loadAdvanceBookings();
  ui.choose();
  const oldRefresh = ui.context.loadAdvanceBookings('all', { background: true });
  await ui.click('advance-assign');
  stale.resolve([pending]);
  await oldRefresh;
  assert.match(ui.elements.get('advance-bookings-tbody').innerHTML, /Confirmed Driver/);
  assert.equal(ui.element('advance-assign'), undefined);
});

test('successful assignment immediately removes the row from the Scheduled filter', async () => {
  let assigned = false;
  const pending = booking();
  const ui = harness({ respond: (path, method) => {
    if (method === 'PATCH') {
      assigned = true;
      return { status: 'assigned', driver: { _id: DRIVER_ID, name: 'Assigned Driver' } };
    }
    if (path.includes('assignment-options')) return [driver];
    if (assigned && path.endsWith('status=pending')) throw new Error('Follow-up GET failed');
    return [pending];
  } });
  await ui.context.loadAdvanceBookings('pending');
  ui.choose();
  await ui.click('advance-assign');
  assert.match(ui.elements.get('advance-bookings-tbody').innerHTML, /No scheduled bookings found/);
  assert.equal(ui.element('advance-assign'), undefined);
});

test('rejected offline Driver assignment refreshes eligibility and unlocks retry without hiding the error', async () => {
  let offline = false;
  const row = booking();
  const ui = harness({ respond: (path, method) => {
    if (method === 'PATCH') { offline = true; throw new Error('Selected Driver is offline'); }
    if (path.includes('assignment-options')) return offline ? [] : [driver];
    return [row];
  } });
  await ui.context.loadAdvanceBookings();
  ui.choose();
  await ui.click('advance-assign');
  assert.match(ui.element('advance-driver').innerHTML, /No available online Drivers/);
  assert.match(ui.element('advance-assignment-feedback').textContent, /Selected Driver is offline/);
  assert.equal(ui.element('advance-assign').disabled, true);
  assert.equal(ui.element('advance-drivers-refresh').disabled, false);
});

test('background refresh preserves selected Drivers and existing controls, but clears an ineligible selection', async () => {
  const rows = [booking()];
  let options = [driver];
  const ui = harness({ respond: path => path.includes('assignment-options') ? options : rows });
  await ui.context.loadAdvanceBookings();
  ui.choose();
  const select = ui.element('advance-driver');
  await ui.context.loadAdvanceBookings('all', { background: true });
  assert.equal(ui.element('advance-driver'), select, 'unchanged booking data does not replace an open control');
  assert.equal(select.value, DRIVER_ID);
  rows.push(booking({ _id: '507f1f77bcf86cd799439013' }));
  await ui.context.loadAdvanceBookings('all', { background: true });
  assert.match(ui.elements.get('advance-bookings-tbody').innerHTML, /row-advance-booking-507f1f77bcf86cd799439013/);
  assert.equal(ui.element('advance-driver').value, DRIVER_ID, 'new bookings preserve an in-progress selection');
  options = [];
  await ui.context.loadAdvanceBookings('all', { background: true });
  assert.equal(ui.element('advance-driver').value, '');
  assert.equal(ui.element('advance-assign').disabled, true);
});

test('Converted filter understands reservationStatus versus live ride status, and sidebar count is not filter-specific', async () => {
  const converted = booking({ status: 'in-progress', reservationStatus: 'converted', driver: { id: DRIVER_ID, name: 'Live Driver' } });
  const upcoming = booking();
  const ui = harness({ respond: path => path.endsWith('status=converted') ? [converted] : [upcoming, converted] });
  await ui.context.loadAdvanceBookings('converted');
  assert.match(ui.elements.get('advance-bookings-tbody').innerHTML, /Live Driver|In progress/);
  assert.equal(ui.elements.get('advance-booking-cnt').textContent, 1);
  assert.equal(ui.element('advance-assign'), undefined);
});

test('new, assigned, converted, and reconnect events refresh visible bookings; inactive sections only refresh the count', async () => {
  const rows = [];
  const ui = harness({ respond: () => rows });
  ui.context.connectSocket();
  rows.push(booking({ status: 'assigned', reservationStatus: 'assigned', driver: { id: DRIVER_ID, name: 'Realtime Driver' } }));
  for (const event of ['advance-booking:new', 'advance-booking:assigned', 'advance-booking:converted', 'connect']) {
    const before = ui.requests.length;
    ui.handlers.get(event)({ driver: { name: 'Realtime Driver' } });
    await nextTurn();
    assert.ok(ui.requests.length > before, `${event} triggers a real GET`);
    assert.match(ui.elements.get('advance-bookings-tbody').innerHTML, /Realtime Driver/);
  }
  ui.elements.get('sec-advance-bookings').classList.remove('active');
  const replacements = ui.elements.get('advance-bookings-tbody').replacements;
  ui.handlers.get('advance-booking:new')();
  await nextTurn();
  assert.equal(ui.elements.get('advance-bookings-tbody').replacements, replacements);
  assert.equal(ui.elements.get('advance-booking-cnt').textContent, 1);
});

test('view-only and forbidden Sub-Admins never fetch assignment options or perform manual assignment', async () => {
  for (const permissions of [['viewAdvanceBookings'], []]) {
    const ui = harness({ permissions, respond: () => [booking()] });
    await ui.context.loadAdvanceBookings();
    ui.context.connectSocket();
    ui.handlers.get('advance-booking:new')();
    await nextTurn();
    await ui.context.assignAdvanceBooking(BOOKING_ID);
    assert.equal(ui.requests.some(request => request.path.includes('assignment-options') || request.method === 'PATCH'), false);
    assert.equal(ui.element('advance-assign'), undefined);
    assert.doesNotMatch(ui.elements.get('advance-bookings-tbody').innerHTML, /Pickup time passed/);
    if (!permissions.length) assert.equal(ui.requests.length, 0);
  }
});

test('past pickup times cannot be assigned, and automatic refresh stops when the section closes', async () => {
  const ui = harness({ respond: () => [booking({ scheduledFor: new Date(Date.now() - 1000).toISOString() })] });
  await ui.context.loadAdvanceBookings();
  assert.equal(ui.element('advance-assign'), undefined);
  assert.match(ui.elements.get('advance-bookings-tbody').innerHTML, /Pickup time passed/);
  ui.context.setAdvanceBookingAutoRefresh();
  assert.equal(ui.timers.size, 1);
  const timer = [...ui.timers.values()][0];
  assert.equal(timer.delay, 20000);
  const before = ui.requests.length;
  ui.document.visibilityState = 'hidden';
  timer.callback();
  assert.equal(ui.requests.length, before);
  ui.document.visibilityState = 'visible';
  timer.callback();
  await nextTurn();
  assert.ok(ui.requests.length > before);
  ui.elements.get('sec-advance-bookings').classList.remove('active');
  ui.context.setAdvanceBookingAutoRefresh();
  assert.equal(ui.timers.size, 0);
});

test('logout invalidates pending list/options/mutation callbacks even if the same token is reused', async () => {
  const mutation = deferred();
  const row = booking();
  const ui = harness({ respond: (path, method) => method === 'PATCH' ? mutation.promise : path.includes('assignment-options') ? [driver] : [row] });
  await ui.context.loadAdvanceBookings();
  ui.choose();
  const assigning = ui.context.assignAdvanceBooking(BOOKING_ID);
  ui.context.resetAdvanceBookingState();
  const rendered = ui.elements.get('advance-bookings-tbody').innerHTML;
  mutation.resolve({ status: 'assigned', driver: { _id: DRIVER_ID, name: 'Expired Session Driver' } });
  await assigning;
  assert.equal(ui.elements.get('advance-bookings-tbody').innerHTML, rendered);
  assert.equal(ui.toasts.some(toast => toast.type === 'success'), false);
  const late = deferred();
  const staleUi = harness({ respond: () => late.promise });
  const loading = staleUi.context.loadAdvanceBookings();
  staleUi.context.resetAdvanceBookingState();
  late.resolve([row]);
  await loading;
  assert.match(staleUi.elements.get('advance-bookings-tbody').innerHTML, /Loading scheduled bookings/);
  const lateOptions = deferred();
  const optionsUi = harness({ respond: path => path.includes('assignment-options') ? lateOptions.promise : [row] });
  const optionsLoading = optionsUi.context.loadAdvanceBookings();
  await nextTurn();
  optionsUi.context.resetAdvanceBookingState();
  lateOptions.resolve([driver]);
  await optionsLoading;
  assert.match(optionsUi.element('advance-driver').innerHTML, /Loading available online Drivers/);
  assert.equal(optionsUi.element('advance-driver').disabled, true);
});