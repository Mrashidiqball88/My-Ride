'use strict';

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const service = require('../server');

const original = {
  userFind: service.models.User.find,
  userFindById: service.models.User.findById,
  settingsFindOne: service.models.Settings.findOne,
  ioTo: service.io.to,
};

afterEach(() => {
  service.models.User.find = original.userFind;
  service.models.User.findById = original.userFindById;
  service.models.Settings.findOne = original.settingsFindOne;
  service.io.to = original.ioTo;
});

function queryReturning(value) {
  return {
    select() { return this; },
    lean: async () => value,
  };
}

test('advance-booking broadcast persists and emits the complete feed to matching online Drivers', async () => {
  const bookingId = '507f1f77bcf86cd799439021';
  const customerId = '507f1f77bcf86cd799439022';
  const matchingDrivers = [
    {
      _id: '507f1f77bcf86cd799439031',
      role: 'driver',
      name: 'Exact category Driver',
      vehicleType: 'Car Mini Non-AC',
      isOnline: true,
      accountStatus: 'active',
      lastOnlineHeartbeat: new Date(),
      ridePreference: 'Long Range Only',
      longRangeEnabled: false,
    },
    {
      _id: '507f1f77bcf86cd799439032',
      role: 'driver',
      name: 'Legacy category Driver',
      vehicleType: 'Car Mini',
      isOnline: true,
      accountStatus: 'active',
      lastOnlineHeartbeat: new Date(),
    },
    {
      _id: '507f1f77bcf86cd799439033',
      role: 'driver',
      name: 'Different category Driver',
      vehicleType: 'Car Mini AC',
      isOnline: true,
      accountStatus: 'active',
      lastOnlineHeartbeat: new Date(),
    },
  ];
  let capturedFilter = null;
  let saved = false;
  const emitted = [];

  service.models.User.find = filter => {
    capturedFilter = filter;
    return queryReturning(matchingDrivers);
  };
  service.models.User.findById = () => queryReturning({ name: 'Customer Example' });
  service.models.Settings.findOne = () => queryReturning({ value: {} });
  service.io.to = room => ({
    emit(event, payload) {
      emitted.push({ room, event, payload });
    },
  });

  const booking = {
    _id: bookingId,
    passenger: customerId,
    pickupLocation: { lat: 31.52, lng: 74.35, address: 'Pickup' },
    dropoffLocation: { lat: 31.55, lng: 74.37, address: 'Drop-off' },
    passengerCount: 2,
    scheduledFor: new Date(Date.now() + 60 * 60 * 1000),
    broadcastExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    fare: 850,
    distance: 12.5,
    durationMinutes: 35,
    vehicleType: 'Car Mini Non-AC',
    isLongRange: false,
    counterOffers: [],
    declinedDriverIds: [],
    notifiedDriverIds: [],
    save: async function save() {
      saved = true;
      return this;
    },
  };

  const result = await service.broadcastAdvanceBooking(booking);

  assert.equal(capturedFilter.vehicleType.$in.includes('Car Mini Non-AC'), true);
  assert.equal(capturedFilter.vehicleType.$in.includes('Car Mini'), true);
  assert.equal(saved, true);
  assert.deepEqual(
    booking.notifiedDriverIds.map(String),
    matchingDrivers.slice(0, 2).map(driver => driver._id),
  );
  assert.deepEqual(
    result.drivers.map(driver => String(driver._id)),
    matchingDrivers.slice(0, 2).map(driver => driver._id),
  );
  assert.deepEqual(
    emitted.map(item => item.room),
    matchingDrivers.slice(0, 2).map(driver => `user:${driver._id}`),
  );
  assert.ok(emitted.every(item => item.event === 'advance-booking:new'));
  assert.ok(emitted.every(item =>
    item.payload.advanceBookingId === bookingId
    && item.payload.pickupLocation.address === 'Pickup'
    && item.payload.dropoffLocation.address === 'Drop-off'
    && item.payload.fare === 850
    && item.payload.passengerCount === 2
  ));
});