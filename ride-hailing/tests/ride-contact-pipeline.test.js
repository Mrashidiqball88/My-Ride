'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { app, models } = require('../server');
let mongo, server, customer, driver, ride;
before(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  customer = new mongoose.Types.ObjectId();
  driver = new mongoose.Types.ObjectId();
  ride = new mongoose.Types.ObjectId();
  await models.Customer.collection.insertOne({ _id: customer, phone: '0300-1234567', activeSessionToken: 'contact-test' });
  await models.Driver.collection.insertOne({ _id: driver, phone: '+92 301 1234567', activeSessionToken: 'contact-test' });
  await models.Ride.collection.insertOne({ _id: ride, passenger: customer, driver, status: 'accepted' });
  server = app.listen(0);
});
after(async () => {
  await new Promise(resolve => server.close(resolve));
  await mongoose.disconnect();
  await mongo.stop();
});
async function request(id, role) {
  const token = jwt.sign({ id: String(id), role }, process.env.JWT_SECRET || 'ride-hailing-secret-fallback');
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/rides/${ride}/contact`, {
    headers: { authorization: `Bearer ${token}`, 'x-session-token': 'contact-test' }
  });
  return { status: response.status, body: await response.json() };
}
test('authenticated participants receive the opposite primary phone; blanks recover from legacy or fail explicitly', async () => {
  assert.equal((await request(customer, 'customer')).body.contact.phone, '+923011234567');
  assert.equal((await request(driver, 'driver')).body.contact.phone, '+923001234567');
  await models.LegacyUser.collection.insertOne({ _id: driver, role: 'driver', phone: '0092 302 1234567' });
  for (const phone of ['', '   ', null, 'invalid']) {
    await models.Driver.collection.updateOne({ _id: driver }, { $set: { phone } });
    const result = await request(customer, 'customer');
    assert.equal(result.status, 200);
    assert.equal(result.body.contact.phone, '+923021234567');
  }
  await models.Driver.collection.updateOne({ _id: driver }, { $unset: { phone: '' } });
  assert.equal((await request(customer, 'customer')).body.contact.phone, '+923021234567');
  await models.LegacyUser.collection.deleteOne({ _id: driver });
  const missing = await request(customer, 'customer');
  assert.equal(missing.status, 422);
  assert.equal(missing.body.code, 'CONTACT_PHONE_UNAVAILABLE');
  const outsider = new mongoose.Types.ObjectId();
  await models.Customer.collection.insertOne({ _id: outsider, activeSessionToken: 'contact-test' });
  assert.equal((await request(outsider, 'customer')).status, 403);
});

for (const role of ['customer', 'driver']) {
  const isCustomer = role === 'customer';
  const handler = isCustomer ? 'openCustomerRideContact' : 'openDriverRideContact';
  const extractor = isCustomer ? 'extractCustomerDriverPhone' : 'extractDriverPassengerPhone';
  const participant = isCustomer ? 'driver' : 'passenger';
  const end = isCustomer ? 'function showMatchedPanel' : 'function showActivePanel';
  const html = fs.readFileSync(`${__dirname}/../public/${role}.html`, 'utf8');
  const code = html.slice(html.indexOf(`function ${handler}`), html.indexOf(end));
  test(`${role}: real handler preserves valid state, normalizes links and ignores stale responses`, async () => {
    let resolve, response = {}, requests = 0;
    const context = vm.createContext({
      console: { warn() {} }, window: { location: { href: '' } },
      activeRide: { _id: 'ride-1', [participant]: { phone: '0300-1234567' } },
      activeDriverInfo: null, showToast() {},
      apiCall: async () => { requests++; return response; }
    });
    vm.runInContext(code, context);
    for (const value of ['03001234567', '+923001234567', '00923001234567', '92 300 1234567', '(0300) 123-4567']) {
      assert.equal(context[extractor](value).whatsapp, '923001234567');
    }
    for (const value of ['', null, undefined, 'abc03001234567', '030012345678', '+12345678901', {}]) {
      assert.equal(context[extractor](value), null);
    }
    for (const phone of ['', '   ', null, undefined, 'invalid', '+92 300 1234567']) {
      response = { contact: { phone } };
      context[handler]({ preventDefault() {} }, { dataset: { contactAction: 'whatsapp' } });
      await new Promise(setImmediate);
      assert.equal(context.activeRide[participant].phone, '+923001234567');
      assert.equal(context.window.location.href, 'https://wa.me/923001234567');
    }
    context[handler](null, { dataset: { contactAction: 'call' } });
    await new Promise(setImmediate);
    assert.equal(context.window.location.href, 'tel:+923001234567');
    assert.equal(requests, 7);
    context.apiCall = () => new Promise(r => { resolve = r; });
    context[handler](null, { dataset: { contactAction: 'call' } });
    context.activeRide = { _id: 'ride-2' };
    context.window.location.href = '';
    resolve({ contact: { phone: '03031234567' } });
    await new Promise(setImmediate);
    assert.equal(context.window.location.href, '');
    assert.equal(context.activeRide._id, 'ride-2');
  });
}