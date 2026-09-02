'use strict';

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

const {
  app,
  normalizeCustomerLocationAliasText,
  customerLocationAliasMatch
} = require('../server');

const originalFetch = global.fetch;
const httpFetch = global.fetch;
const originalMapboxAccessToken = process.env.MAPBOX_ACCESS_TOKEN;
const originalMapboxPublicToken = process.env.MAPBOX_PUBLIC_TOKEN;
const originalNominatimMinInterval = process.env.NOMINATIM_MIN_INTERVAL_MS;

afterEach(() => {
  global.fetch = originalFetch;
  if (originalMapboxAccessToken === undefined) delete process.env.MAPBOX_ACCESS_TOKEN;
  else process.env.MAPBOX_ACCESS_TOKEN = originalMapboxAccessToken;
  if (originalMapboxPublicToken === undefined) delete process.env.MAPBOX_PUBLIC_TOKEN;
  else process.env.MAPBOX_PUBLIC_TOKEN = originalMapboxPublicToken;
  if (originalNominatimMinInterval === undefined) delete process.env.NOMINATIM_MIN_INTERVAL_MS;
  else process.env.NOMINATIM_MIN_INTERVAL_MS = originalNominatimMinInterval;
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

function mapboxFeature(name, city, type, category, lat, lon, extra = {}) {
  return {
    type: 'Feature',
    id: `${type}.123`,
    text: name,
    place_name: `${name}, ${city}, Pakistan`,
    place_type: [type],
    properties: { category, ...extra },
    geometry: {
      type: 'Point',
      coordinates: [lon, lat]
    },
    context: [
      { id: 'street.1', text: 'New Terminal Road' },
      { id: 'neighborhood.1', text: 'Durg Colony' },
      { id: 'place.1', text: city },
      { id: 'region.1', text: 'Punjab' },
      { id: 'country.1', short_code: 'pk', text: 'Pakistan' }
    ]
  };
}

function assertMapboxQuery(url, query) {
  assert.equal(url.searchParams.get('access_token'), 'test-mapbox-token');
  assert.equal(url.searchParams.get('autocomplete'), 'true');
  assert.equal(url.searchParams.get('country'), 'pk');
  assert.equal(url.searchParams.get('language'), 'en');
  assert.equal(url.searchParams.get('limit'), '10');
  assert.equal(url.searchParams.get('types'), 'address,poi,neighborhood,locality,place,postcode');
  assert.doesNotMatch(url.searchParams.get('types'), /street/);
  assert.equal(url.searchParams.get('proximity'), null);
  assert.equal(decodeURIComponent(url.pathname).includes(query), true);
}

test('Mapbox search maps valid Pakistan features and preserves POI metadata', async () => {
  process.env.MAPBOX_PUBLIC_TOKEN = 'test-mapbox-token';
  process.env.NOMINATIM_MIN_INTERVAL_MS = '0';
  let mapboxRequested;
  let nominatimRequested;
  const features = [
    mapboxFeature('جناح بین الاقوامی ہوائی اڈہ', 'کراچی', 'poi', 'airport', 24.9058, 67.1614),
    mapboxFeature('Shifa International Hospital', 'Islamabad', 'poi', 'hospital', 33.7069, 73.0498),
    mapboxFeature('Jinnah Street', 'Rawalpindi', 'street', 'street', 33.5968, 73.1330),
    mapboxFeature('جناح بین الاقوامی ہوائی اڈہ', 'کراچی', 'poi', 'airport', 24.9058, 67.1614),
    Object.assign(
      mapboxFeature('Outside Pakistan', 'Delhi', 'poi', 'hospital', 28.6139, 77.2090),
      { context: [{ id: 'country.1', short_code: 'in', text: 'India' }] }
    ),
    mapboxFeature('Bad coordinates', 'Lahore', 'poi', 'hospital', 0, 0),
    { type: 'Feature', geometry: { type: 'LineString', coordinates: [] }, context: [] }
  ];
  global.fetch = async (url, options) => {
    const request = { url: new URL(url), options };
    if (request.url.origin === 'https://api.mapbox.com') mapboxRequested = request;
    if (request.url.origin === 'https://nominatim.openstreetmap.org') nominatimRequested = request;
    return {
      ok: true,
      json: async () => request.url.origin === 'https://api.mapbox.com'
        ? { type: 'FeatureCollection', features }
        : []
    };
  };

  await withServer(async server => {
    const query = 'airport  جناح';
    const result = await request(server, `/api/geocode?q=${encodeURIComponent(query)}`);
    assert.equal(result.response.status, 200);
    assert.equal(result.body.length, 3);
    assert.deepEqual(result.body.map(item => item.type), ['airport', 'hospital', 'street']);
    assert.equal(result.body[0].providerType, 'airport');
    assert.equal(result.body[0].address.city, 'کراچی');
    assert.equal(result.body[0].address.road, 'New Terminal Road');
    assert.equal(result.body[0].display_name, 'جناح بین الاقوامی ہوائی اڈہ, کراچی, Pakistan');
    assert.equal(result.body[1].address.category, 'hospital');
    assert.equal(mapboxRequested.options.headers['Accept-Language'], 'en');
    assert.equal(mapboxRequested.url.origin, 'https://api.mapbox.com');
    assert.match(mapboxRequested.url.pathname, /\/geocoding\/v5\/mapbox\.places\//);
    assertMapboxQuery(mapboxRequested.url, query);
    assert.equal(nominatimRequested.url.searchParams.get('countrycodes'), 'pk');
    assert.equal(nominatimRequested.url.searchParams.get('accept-language'), 'ur,en');
    assert.equal(nominatimRequested.options.headers['User-Agent'], 'MyRide/1.0 (Pakistan ride-hailing location search)');
  });
});

test('Mapbox preserves mixed-language queries and returns a clear upstream failure', async () => {
  process.env.MAPBOX_PUBLIC_TOKEN = 'test-mapbox-token';
  process.env.NOMINATIM_MIN_INTERVAL_MS = '0';
  let mapboxRequested;
  global.fetch = async (url, options) => {
    const request = { url: new URL(url), options };
    if (request.url.origin === 'https://api.mapbox.com') mapboxRequested = request;
    return { ok: false, status: 429, json: async () => ({}) };
  };

  await withServer(async server => {
    const query = ' جناح  ائیرپورٹ ';
    const result = await request(server, `/api/geocode?q=${encodeURIComponent(query)}`);
    assert.equal(result.response.status, 502);
    assert.equal(result.body.error, 'Internal server error');
    assertMapboxQuery(mapboxRequested.url, query);
  });
});

test('Mapbox access token takes precedence over the public-token fallback', async () => {
  process.env.MAPBOX_ACCESS_TOKEN = 'access-token';
  process.env.MAPBOX_PUBLIC_TOKEN = 'public-token';
  process.env.NOMINATIM_MIN_INTERVAL_MS = '0';
  let mapboxRequested;
  global.fetch = async url => {
    const requested = new URL(url);
    if (requested.origin === 'https://api.mapbox.com') mapboxRequested = requested;
    return { ok: true, json: async () => ({ features: [] }) };
  };

  await withServer(async server => {
    const result = await request(server, '/api/geocode?q=Karachi');
    assert.equal(result.response.status, 200);
    assert.equal(mapboxRequested.searchParams.get('access_token'), 'access-token');
    assert.equal(mapboxRequested.searchParams.get('language'), 'en');
  });
});

test('Customer search passes Mapbox proximity in longitude,latitude order without narrowing nationwide results', async () => {
  process.env.MAPBOX_PUBLIC_TOKEN = 'test-mapbox-token';
  process.env.NOMINATIM_MIN_INTERVAL_MS = '0';
  let mapboxRequested;
  global.fetch = async url => {
    const requested = new URL(url);
    if (requested.origin === 'https://api.mapbox.com') mapboxRequested = requested;
    return { ok: true, json: async () => ({ features: [] }) };
  };

  await withServer(async server => {
    const result = await request(server, '/api/geocode?q=Lahore&proximity=74.3587,31.5204');
    assert.equal(result.response.status, 200);
    assert.equal(mapboxRequested.searchParams.get('proximity'), '74.3587,31.5204');
    assert.equal(mapboxRequested.searchParams.get('country'), 'pk');
    assert.equal(mapboxRequested.searchParams.get('city'), null);
    assert.equal(mapboxRequested.searchParams.get('radius'), null);
  });
});

test('Customer search omits invalid proximity coordinates', async () => {
  process.env.MAPBOX_PUBLIC_TOKEN = 'test-mapbox-token';
  process.env.NOMINATIM_MIN_INTERVAL_MS = '0';
  let mapboxRequested;
  global.fetch = async url => {
    const requested = new URL(url);
    if (requested.origin === 'https://api.mapbox.com') mapboxRequested = requested;
    return { ok: true, json: async () => ({ features: [] }) };
  };

  await withServer(async server => {
    const result = await request(server, '/api/geocode?q=airport&proximity=181,91');
    assert.equal(result.response.status, 200);
    assert.equal(mapboxRequested.searchParams.get('proximity'), null);
  });
});

test('Reverse geocoding falls back to a detailed local address when Mapbox is city-level', async () => {
  process.env.MAPBOX_PUBLIC_TOKEN = 'test-mapbox-token';
  process.env.NOMINATIM_MIN_INTERVAL_MS = '0';
  const requests = [];
  global.fetch = async url => {
    const parsed = new URL(url);
    requests.push(parsed);
    if (parsed.origin === 'https://api.mapbox.com') {
      return {
        ok: true,
        json: async () => ({
          features: [{
            type: 'Feature',
            id: 'place.lahore',
            text: 'Lahore',
            place_name: 'Lahore, Punjab, Pakistan',
            place_type: ['place'],
            geometry: { type: 'Point', coordinates: [74.3587, 31.5204] },
            context: [
              { id: 'region.1', text: 'Punjab' },
              { id: 'country.1', short_code: 'pk', text: 'Pakistan' }
            ]
          }]
        })
      };
    }
    return {
      ok: true,
      json: async () => ({
        lat: '31.5204',
        lon: '74.3587',
        display_name: 'House 22, Canal Bank Road, Shadman Colony, Lahore, Punjab, Pakistan',
        address: {
          house_number: '22',
          road: 'Canal Bank Road',
          suburb: 'Shadman Colony',
          city: 'Lahore',
          state: 'Punjab',
          country: 'Pakistan',
          country_code: 'pk'
        }
      })
    };
  };

  await withServer(async server => {
    const token = jwt.sign({ id: 'admin-1', isAdmin: true }, 'ride-hailing-secret-fallback');
    const response = await httpFetch(
      `http://127.0.0.1:${server.address().port}/api/geocode/reverse?lat=31.5204&lng=74.3587`,
      { headers: { authorization: `Bearer ${token}` } }
    );
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.provider, 'nominatim');
    assert.equal(body.display_name, '22 Canal Bank Road, Shadman Colony, Lahore, Punjab');
    assert.equal(body.address.road, 'Canal Bank Road');
    assert.equal(requests.some(url => url.origin === 'https://nominatim.openstreetmap.org'
      && url.pathname === '/reverse'), true);
  });
});

test('Nominatim normalization filters non-Pakistan and invalid-coordinate results while merging with Mapbox', async () => {
  process.env.MAPBOX_PUBLIC_TOKEN = 'test-mapbox-token';
  process.env.NOMINATIM_MIN_INTERVAL_MS = '0';
  process.env.NOMINATIM_USER_AGENT = 'MyRide test suite';
  const nominatimResults = [
    {
      place_id: 101,
      osm_type: 'node',
      osm_id: 202,
      lat: '31.5204',
      lon: '74.3587',
      name: 'Mall Road',
      display_name: 'Mall Road, Lahore, Punjab, Pakistan',
      type: 'road',
      address: {
        road: 'Mall Road',
        city: 'Lahore',
        state: 'Punjab',
        country: 'Pakistan',
        country_code: 'pk'
      }
    },
    {
      place_id: 102,
      lat: '28.6139',
      lon: '77.2090',
      display_name: 'Delhi, India',
      type: 'city',
      address: { city: 'Delhi', country: 'India', country_code: 'in' }
    },
    {
      place_id: 103,
      lat: '0',
      lon: '0',
      display_name: 'Invalid, Pakistan',
      type: 'place',
      address: { country: 'Pakistan', country_code: 'pk' }
    }
  ];
  const requests = [];
  global.fetch = async url => {
    const parsed = new URL(url);
    requests.push(parsed);
    return {
      ok: true,
      json: async () => parsed.origin === 'https://api.mapbox.com'
        ? { features: [] }
        : nominatimResults
    };
  };

  await withServer(async server => {
    const result = await request(server, '/api/geocode?q=Mall%20Road');
    assert.equal(result.response.status, 200);
    assert.equal(result.body.length, 1);
    assert.equal(result.body[0].provider, 'nominatim');
    assert.equal(result.body[0].address.city, 'Lahore');
    assert.equal(result.body[0].address.road, 'Mall Road');
    assert.equal(requests.filter(url => url.origin === 'https://nominatim.openstreetmap.org').length, 1);
    assert.equal(requests.find(url => url.origin === 'https://nominatim.openstreetmap.org').searchParams.get('limit'), '20');
  });
});

test('Customer alias matching is bilingual and independent of UI language selection', () => {
  const alias = {
    displayName: 'Jinnah Airport',
    canonicalQuery: 'Jinnah International Airport',
    variants: [
      normalizeCustomerLocationAliasText('Jinnah Airport'),
      normalizeCustomerLocationAliasText('جناح ائیرپورٹ')
    ],
    confidence: 1,
    enabled: true
  };

  assert.equal(customerLocationAliasMatch('Jinnah Airport', alias)?.exact, true);
  assert.equal(customerLocationAliasMatch('جناح ائیرپورٹ', alias)?.exact, true);
  assert.equal(customerLocationAliasMatch('جناح ائیرپورٹ\u200c', alias)?.exact, true);
});