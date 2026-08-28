'use strict';

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { app } = require('../server');

const originalFetch = global.fetch;
const httpFetch = global.fetch;
const originalLocationIqKey = process.env.LOCATIONIQ_KEY;

afterEach(() => {
  global.fetch = originalFetch;
  if (originalLocationIqKey === undefined) delete process.env.LOCATIONIQ_KEY;
  else process.env.LOCATIONIQ_KEY = originalLocationIqKey;
});

async function request(server, path) {
  const response = await httpFetch(`http://127.0.0.1:${server.address().port}${path}`);
  return { response, body: await response.json() };
}

async function withServer(callback) {
  const server = app.listen(0);
  try {
    return await callback(server);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

function providerPoi(name, city, type, lat, lon) {
  return {
    display_name: `${name}, ${city}, Pakistan`,
    lat: String(lat),
    lon: String(lon),
    type,
    address: { city }
  };
}

function assertNationwideQuery(url, query) {
  assert.equal(url.searchParams.get('q'), query);
  assert.equal(url.searchParams.get('countrycodes'), 'pk');
  for (const forbidden of [
    'city', 'radius', 'viewbox', 'bounded', 'featuretype', 'type',
    'class', 'amenity', 'lat', 'lon', 'lng'
  ]) {
    assert.equal(url.searchParams.get(forbidden), null, `${forbidden} must not narrow Customer search`);
  }
}

test('Nominatim search keeps every valid nationwide POI category and metadata', async () => {
  delete process.env.LOCATIONIQ_KEY;
  let requested;
  const upstreamResults = [
    providerPoi('Islamabad International Airport', 'Islamabad', 'aerodrome', 33.5607, 72.8516),
    providerPoi('Daewoo Bus Terminal', 'Lahore', 'bus_station', 31.4686, 74.2728),
    providerPoi('Shifa International Hospital', 'Islamabad', 'hospital', 33.7069, 73.0498),
    providerPoi('Beaconhouse School', 'Karachi', 'school', 24.8607, 67.0011),
    providerPoi('Government College University', 'Faisalabad', 'college', 31.4180, 73.0790),
    providerPoi('University of Peshawar', 'Peshawar', 'university', 34.0209, 71.4874),
    providerPoi('Liberty Chowk', 'Lahore', 'junction', 31.5107, 74.3441),
    providerPoi('Pakistan Monument', 'Islamabad', 'monument', 33.6938, 73.0652),
    providerPoi('Unknown Community Place', 'Quetta', 'community_centre', 30.1798, 66.9750),
    { display_name: 'Bad coordinates', lat: 'not-a-number', lon: '0', type: 'hospital' }
  ];
  global.fetch = async (url, options) => {
    requested = { url: new URL(url), options };
    return { ok: true, json: async () => upstreamResults };
  };

  await withServer(async server => {
    const result = await request(server, `/api/geocode?q=${encodeURIComponent('airport hospital chowk')}`);
    assert.equal(result.response.status, 200);
    assert.equal(result.body.length, 9);
    assert.deepEqual(result.body.map(item => item.type), upstreamResults.slice(0, 9).map(item => item.type));
    assert.equal(result.body.find(item => item.type === 'aerodrome').providerType, 'aerodrome');
    assert.equal(result.body.find(item => item.type === 'community_centre').providerType, 'community_centre');
    assert.equal(requested.options.headers['User-Agent'], 'MyRide-App/1.0 (ride-hailing)');
    assert.equal(requested.options.headers['Accept-Language'], 'en,ur,pa,hi,sd');
    assert.equal(requested.url.searchParams.get('format'), 'json');
    assert.equal(requested.url.searchParams.get('limit'), '50');
    assert.equal(requested.url.searchParams.get('addressdetails'), '1');
    assert.equal(requested.url.searchParams.get('namedetails'), '1');
    assert.equal(requested.url.searchParams.get('extratags'), '1');
    assertNationwideQuery(requested.url, 'airport hospital chowk');
  });
});

test('LocationIQ search keeps provider categories without adding local narrowing', async () => {
  process.env.LOCATIONIQ_KEY = 'test-locationiq-key';
  let requested;
  global.fetch = async (url, options) => {
    requested = { url: new URL(url), options };
    return {
      ok: true,
      json: async () => [
        providerPoi('Jinnah International Airport', 'Karachi', 'airport', 24.9065, 67.1608),
        providerPoi('Aga Khan University Hospital', 'Karachi', 'hospital', 24.8934, 67.0746)
      ]
    };
  };

  await withServer(async server => {
    const result = await request(server, `/api/geocode?q=${encodeURIComponent('Jinnah airport')}`);
    assert.equal(result.response.status, 200);
    assert.equal(result.body.length, 2);
    assert.deepEqual(result.body.map(item => item.providerType), ['airport', 'hospital']);
    assert.deepEqual(requested.options.headers, {});
    assert.equal(requested.url.searchParams.get('key'), 'test-locationiq-key');
    assert.equal(requested.url.searchParams.get('format'), 'json');
    assert.equal(requested.url.searchParams.get('limit'), '50');
    assert.equal(requested.url.searchParams.get('addressdetails'), '1');
    assert.equal(requested.url.searchParams.get('namedetails'), '1');
    assertNationwideQuery(requested.url, 'Jinnah airport');
  });
});