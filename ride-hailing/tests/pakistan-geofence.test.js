const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PAKISTAN_ONLY_MESSAGE,
  isWithinPakistan
} = require('../public/pakistan-geofence');

test('Pakistan geofence accepts representative locations inside Pakistan', () => {
  const insidePakistan = [
    { lat: 31.5204, lng: 74.3587 }, // Lahore
    { lat: 24.8607, lng: 67.0011 }, // Karachi
    { lat: 33.6844, lng: 73.0479 }, // Islamabad
    { lat: 30.1798, lng: 66.9750 }, // Quetta
    { lat: 34.0151, lng: 71.5249 }  // Peshawar
  ];

  insidePakistan.forEach(location => assert.equal(isWithinPakistan(location), true));
});

test('Pakistan geofence rejects neighboring-country and malformed coordinates', () => {
  const outsidePakistan = [
    { lat: 31.6340, lng: 74.8723 }, // Amritsar, India
    { lat: 28.6139, lng: 77.2090 }, // Delhi, India
    { lat: 34.5553, lng: 69.2075 }, // Kabul, Afghanistan
    { lat: 35.6892, lng: 51.3890 }, // Tehran, Iran
    { lat: 0, lng: 0 },
    { lat: 91, lng: 74.3587 }
  ];

  outsidePakistan.forEach(location => assert.equal(isWithinPakistan(location), false));
  assert.equal(PAKISTAN_ONLY_MESSAGE, 'Please select a location inside Pakistan.');
});