// @ts-check
'use strict';

const { test, expect } = require('@playwright/test');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const fare = require('../server');
const { server, models, FARE_VEHICLE_CATEGORIES } = fare;

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

async function openBrowserSocket(page, baseURL, authToken, room) {
  await page.goto(`${baseURL}/customer`);
  await page.waitForFunction(() => typeof window.io === 'function');
  await page.evaluate(({ authToken: socketToken, room: socketRoom }) => {
    window.__fareEvents = [];
    const socket = window.io({ auth: { token: socketToken } });
    window.__fareSocket = socket;
    socket.on('ride:fare-updated', payload => window.__fareEvents.push(payload));
    if (socketRoom) socket.on('connect', () => socket.emit('ride:join', socketRoom));
  }, { authToken, room });
  await page.waitForFunction(() => window.__fareSocket?.connected === true);
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
      accountStatus: 'active'
    });
    otherDriver = await models.User.create({
      name: 'Other Driver',
      email: 'fare-live-other@example.test',
      password: 'not-used',
      role: 'driver',
      vehicleType: 'Bike',
      isOnline: true,
      accountStatus: 'active'
    });
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
      expect((await models.Settings.findOne({ key: 'daily_fare_settings' }).lean()).value['Car Mini'].baseFare)
        .toBe(200);

      const rideResponse = await request.post('/api/rides', {
        headers: { authorization: `Bearer ${customerToken}` },
        data: {
          pickupLocation: { lat: 1, lng: 2, address: 'Live pickup' },
          dropoffLocation: { lat: 3, lng: 4, address: 'Live dropoff' },
          distance: 7,
          vehicleType: 'Car Mini',
          fare: 1
        }
      });
      expect(rideResponse.status()).toBe(201);
      const ride = await rideResponse.json();
      expect(ride.fare).toBe(300);

      await Promise.all([
        openBrowserSocket(matchingPage, baseURL, matchingToken),
        openBrowserSocket(otherPage, baseURL, otherToken),
        openBrowserSocket(customerPage, baseURL, customerToken, ride._id)
      ]);

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
      expect(customerEvents[0]).toMatchObject({ id: ride._id, fare: 625 });
      expect(matchingEvents[0]).toMatchObject({ id: ride._id, fare: 625 });
      expect((await models.Ride.findById(ride._id).lean()).fare).toBe(625);
      expect((await models.Settings.findOne({ key: 'daily_fare_settings' }).lean()).value['Car Mini'])
        .toMatchObject({ baseFare: 500 });
    } finally {
      await Promise.all([matchingPage.close(), otherPage.close(), customerPage.close()]);
      await request.dispose();
    }
  });
});