const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const transpile = source => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const context = { exports: {} };
vm.runInNewContext(transpile(fs.readFileSync(path.join(root, 'lib/ride-contact.ts'), 'utf8')), context);
const { passengerContactUrls, participantId, ridePassengerId, rideContactPhone, mergeRideContact } = context.exports;
for (const phone of ['0300 1234567', '3001234567', '+92 (300) 123-4567', '923001234567', '00923001234567']) {
  assert.equal(passengerContactUrls(phone)?.tel, '+923001234567');
}
for (const phone of ['', '0003001234567', '+9203001234567', '123', '030012345678', 'abc03001234567', '03001234567;123', '+13001234567', {}, null]) {
  assert.equal(passengerContactUrls(phone), null);
}
const previous = {
  id: 'a', fare: 50,
  passenger: { _id: 'participant-id', name: 'Passenger', phone: '03001234567' },
  contact: { id: 'participant-id', name: 'Passenger', phone: '03001234567' },
  passengerPhone: '03001234567', contactPhone: '03001234567',
};
assert.equal(rideContactPhone({ passenger: { phone: 'bad' }, contactPhone: '+923001234567' }), '+923001234567');
for (const status of ['accepted', 'arrived', 'in-progress']) {
  const merged = mergeRideContact({ id: 'a', fare: 50, status, passenger: 'participant-id' }, previous);
  assert.equal(merged.passenger.phone, '+923001234567');
  assert.equal(merged.passenger.name, 'Passenger');
}
assert.equal(mergeRideContact({ id: 'b', fare: 50 }, previous).passenger, undefined);
assert.equal(mergeRideContact({ id: 'a', fare: 50, passenger: { phone: 'bad' } }, previous).passenger.phone, '+923001234567');
assert.equal(mergeRideContact({ id: 'a', fare: 50, contact: { phone: '03111234567' } }, previous).passenger.phone, '+923111234567');
for (const passenger of ['participant-b', { _id: 'participant-b' }, { id: 'participant-b', name: 'B' }, null]) {
  const merged = mergeRideContact({ id: 'a', fare: 50, passenger }, previous);
  assert.equal(rideContactPhone(merged), '');
  assert.equal(merged.passengerPhone, undefined);
  assert.equal(merged.contactPhone, undefined);
  assert.equal(merged.contact, undefined);
  if (passenger === null) assert.equal(merged.passenger, null);
  else {
    assert.equal(merged.passenger.id, 'participant-b');
    assert.equal(merged.passenger._id, undefined);
    assert.notEqual(merged.passenger.name, 'Passenger');
  }
}
const changedWithAliases = mergeRideContact({
  ...previous, passenger: { _id: 'participant-b' },
}, previous);
assert.equal(rideContactPhone(changedWithAliases), '');
assert.equal(changedWithAliases.contact, undefined);
const changedWithContact = mergeRideContact({
  id: 'a', fare: 50, passenger: 'participant-b',
  contact: { _id: 'participant-b', name: 'B', phone: '03111234567' },
}, previous);
assert.equal(changedWithContact.passenger.id, 'participant-b');
assert.equal(changedWithContact.passenger._id, undefined);
assert.equal(changedWithContact.contact.id, 'participant-b');
assert.equal(changedWithContact.contact._id, undefined);
assert.equal(changedWithContact.passenger.phone, '+923111234567');
const sameParticipant = mergeRideContact({
  id: 'a', fare: 50, passenger: { id: 'participant-id' },
}, previous);
assert.equal(sameParticipant.passenger.id, 'participant-id');
assert.equal(sameParticipant.passenger._id, undefined);
assert.equal(sameParticipant.passenger.name, 'Passenger');
assert.equal(sameParticipant.passenger.phone, '+923001234567');
const conflictingContact = mergeRideContact({
  id: 'a', fare: 50, passenger: 'participant-id',
  contact: { id: 'participant-b', phone: '03111234567' },
  contactPhone: '03111234567',
}, previous);
assert.equal(conflictingContact.passenger.phone, '+923001234567');
assert.equal(conflictingContact.passenger.id, 'participant-id');
assert.equal(mergeRideContact({
  id: 'a', fare: 50, passenger: { id: 'participant-b', _id: 'participant-id', phone: '03111234567' },
}, previous).passenger, null);
assert.equal(participantId({ id: 'a', _id: 'b' }), null);
assert.equal(rideContactPhone({ passenger: null, contactPhone: '03001234567' }), '');

const runtimeSource = fs.readFileSync(path.join(root, 'context/DriverRuntime.tsx'), 'utf8');
const fetchSource = runtimeSource.slice(runtimeSource.indexOf('  const fetchRideContact ='), runtimeSource.indexOf('  const handleRideOffer ='));
const setterSource = runtimeSource.slice(runtimeSource.indexOf('  const setActiveRide ='), runtimeSource.indexOf('  const clearRideAlert ='));
async function testFetch() {
  let current = previous;
  let result = { contact: { id: 'participant-id', phone: '03111234567' } };
  const scope = {
    passengerContactUrls, participantId, ridePassengerId, rideContactPhone, mergeRideContact,
    tokenRef: { current: 'token' }, sessionRef: { current: 'session' },
    activeRideIdRef: { current: 'a' }, activeRideRef: { current: previous },
    activeRideParticipantVersionRef: { current: 0 },
    emergencyClearGeneration: { current: 0 },
    useCallback: fn => fn,
    api: async url => { assert.equal(url, '/api/rides/a/contact'); return result; },
    setActiveRideState: next => { current = next; },
  };
  vm.runInNewContext(transpile(setterSource + fetchSource + '\n globalThis.fetchContact = fetchRideContact; globalThis.setRide = setActiveRide;'), scope);
  assert.equal((await scope.fetchContact('a')).phone, '+923111234567');
  assert.equal(current.passenger.phone, '+923111234567');
  result = { contact: { id: 'participant-id', phone: 'invalid' } };
  assert.equal((await scope.fetchContact('a')).phone, '+923111234567');
  for (const contact of [
    { id: 'participant-b', phone: '03111234567' },
    { id: 'participant-id', _id: 'participant-b', phone: '03111234567' },
    { phone: '03111234567' },
  ]) {
    result = { contact };
    await assert.rejects(scope.fetchContact('a'), /identity does not match/);
  }
  for (const [passenger, responseId] of [
    ['participant-b', 'participant-id'], ['participant-b', 'participant-b'], [null, 'participant-id'],
  ]) {
    scope.setRide(previous);
    let resolve;
    scope.api = () => new Promise(done => { resolve = done; });
    const pending = scope.fetchContact('a');
    scope.setRide(mergeRideContact({ id: 'a', fare: 50, passenger }, previous));
    const assigned = current;
    resolve({ contact: { id: responseId, phone: '03001234567' } });
    await assert.rejects(pending, /passenger has changed/);
    assert.equal(current, assigned); // Stale response cannot restore A.
  }
  scope.setRide(previous);
  let resolve;
  scope.api = () => new Promise(done => { resolve = done; });
  const pending = scope.fetchContact('a');
  scope.setRide(mergeRideContact({ id: 'a', fare: 50, passenger: 'participant-b' }, previous));
  scope.setRide(previous);
  resolve({ contact: { id: 'participant-id', phone: '03001234567' } });
  await assert.rejects(pending, /passenger has changed/); // A→B→A also invalidates.
  scope.setRide({ id: 'a', fare: 50, passenger: null });
  await assert.rejects(scope.fetchContact('a'), /identity is unavailable/);
  scope.setRide(previous);
  scope.api = async () => { throw new Error('Contact lookup failed'); };
  await assert.rejects(scope.fetchContact('a'), /Contact lookup failed/);
  scope.api = async () => {
    scope.activeRideIdRef.current = 'b';
    return { contact: { phone: '03111234567' } };
  };
  await assert.rejects(scope.fetchContact('a'), /no longer available/);
  scope.activeRideIdRef.current = 'a';
  scope.api = async () => {
    scope.emergencyClearGeneration.current++;
    return { contact: { phone: '03111234567' } };
  };
  await assert.rejects(scope.fetchContact('a'), /no longer available/);
}

const homeSource = fs.readFileSync(path.join(root, 'app/index.tsx'), 'utf8');
const buttonSource = homeSource.slice(homeSource.indexOf('  const openActiveRideContact ='), homeSource.indexOf('  const longRangeVehicle ='));
async function testButton() {
  const opened = [];
  const alerts = [];
  const scope = {
    passengerContactUrls, contactOpening: { current: false },
    runtime: { activeRide: { id: 'a' }, fetchRideContact: async () => ({ phone: '03001234567' }) },
    Linking: { openURL: async url => { opened.push(url); if (url.startsWith('whatsapp:')) throw new Error('Not installed'); } },
    Alert: { alert: (...args) => alerts.push(args) },
  };
  vm.runInNewContext(transpile(buttonSource + '\n globalThis.openContact = openActiveRideContact;'), scope);
  await scope.openContact('Phone Call');
  assert.equal(opened[0], 'tel:+923001234567');
  await scope.openContact('WhatsApp');
  assert.deepEqual(opened.slice(1), ['whatsapp://send?phone=923001234567', 'https://wa.me/923001234567']);
  scope.runtime.fetchRideContact = async () => ({ phone: '123' });
  await scope.openContact('Phone Call');
  assert.equal(opened.length, 3);
  assert.equal(alerts.length, 1);
  scope.contactOpening.current = true;
  await scope.openContact('Phone Call');
  assert.equal(alerts.length, 1);
}
(async () => {
  await testFetch();
  await testButton();
  console.log('Driver contact normalization, same-ride merges, fetch guards, and Linking tests passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });