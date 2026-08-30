'use strict';

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  app,
  normalizeCustomerLocationAliasText,
  customerLocationAliasMatch
} = require('../server');

const originalFetch = global.fetch;
const httpFetch = global.fetch;
const originalMapboxAccessToken = process.env.MAPBOX_ACCESS_TOKEN;
const originalMapboxPublicToken = process.env.MAPBOX_PUBLIC_TOKEN;

afterEach(() => {
  global.fetch = originalFetch;
  if (originalMapboxAccessToken === undefined) delete process.env.MAPBOX_ACCESS_TOKEN;
  else process.env.MAPBOX_ACCESS_TOKEN = originalMapboxAccessToken;
  if (originalMapboxPublicToken === undefined) delete process.env.MAPBOX_PUBLIC_TOKEN;
  else process.env.MAPBOX_PUBLIC_TOKEN = originalMapboxPublicToken;
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
  let requested;
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
    requested = { url: new URL(url), options };
    return { ok: true, json: async () => ({ type: 'FeatureCollection', features }) };
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
    assert.equal(requested.options.headers['Accept-Language'], 'en');
    assert.equal(requested.url.origin, 'https://api.mapbox.com');
    assert.match(requested.url.pathname, /\/geocoding\/v5\/mapbox\.places\//);
    assertMapboxQuery(requested.url, query);
  });
});

test('Mapbox preserves mixed-language queries and returns a clear upstream failure', async () => {
  process.env.MAPBOX_PUBLIC_TOKEN = 'test-mapbox-token';
  let requested;
  global.fetch = async (url, options) => {
    requested = { url: new URL(url), options };
    return { ok: false, status: 429, json: async () => ({}) };
  };

  await withServer(async server => {
    const query = ' جناح  ائیرپورٹ ';
    const result = await request(server, `/api/geocode?q=${encodeURIComponent(query)}`);
    assert.equal(result.response.status, 502);
    assert.equal(result.body.error, 'Internal server error');
    assertMapboxQuery(requested.url, query);
  });
});

test('Mapbox access token takes precedence over the public-token fallback', async () => {
  process.env.MAPBOX_ACCESS_TOKEN = 'access-token';
  process.env.MAPBOX_PUBLIC_TOKEN = 'public-token';
  let requested;
  global.fetch = async url => {
    requested = new URL(url);
    return { ok: true, json: async () => ({ features: [] }) };
  };

  await withServer(async server => {
    const result = await request(server, '/api/geocode?q=Karachi');
    assert.equal(result.response.status, 200);
    assert.equal(requested.searchParams.get('access_token'), 'access-token');
    assert.equal(requested.searchParams.get('language'), 'en');
  });
});

test('Customer search adds proximity for current pickup context without narrowing nationwide results', async () => {
  process.env.MAPBOX_PUBLIC_TOKEN = 'test-mapbox-token';
  let requested;
  global.fetch = async url => {
    requested = new URL(url);
    return { ok: true, json: async () => ({ features: [] }) };
  };

  await withServer(async server => {
    const result = await request(server, '/api/geocode?q=Lahore&lat=31.5204&lng=74.3587');
    assert.equal(result.response.status, 200);
    assert.equal(requested.searchParams.get('proximity'), '74.3587,31.5204');
    assert.equal(requested.searchParams.get('country'), 'pk');
    assert.equal(requested.searchParams.get('city'), null);
    assert.equal(requested.searchParams.get('radius'), null);
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