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

function photonFeature(name, city, osmKey, osmValue, lat, lon, extra = {}) {
  return {
    type: 'Feature',
    properties: {
      osm_type: 'N',
      osm_id: 123,
      osm_key: osmKey,
      osm_value: osmValue,
      type: 'house',
      name,
      city,
      state: 'Punjab',
      country: 'Pakistan',
      countrycode: 'PK',
      ...extra
    },
    geometry: {
      type: 'Point',
      coordinates: [lon, lat]
    }
  };
}

function assertNationwideQuery(url, query) {
  assert.equal(url.searchParams.get('q'), query);
  assert.equal(url.searchParams.get('limit'), '50');
  assert.equal(url.searchParams.get('countrycodes'), null);
  for (const forbidden of [
    'city', 'radius', 'viewbox', 'bounded', 'featuretype', 'type',
    'class', 'amenity', 'lat', 'lon', 'lng'
  ]) {
    assert.equal(url.searchParams.get(forbidden), null, `${forbidden} must not narrow Customer search`);
  }
}

test('Photon search maps valid Pakistan GeoJSON features and preserves POI metadata', async () => {
  process.env.LOCATIONIQ_KEY = 'must-not-be-used-for-photon-search';
  let requested;
  const features = [
    photonFeature('جناح بین الاقوامی ہوائی اڈہ', 'کراچی', 'aeroway', 'aerodrome', 24.9058, 67.1614, {
      street: 'New Terminal Road',
      locality: 'ڈرگ کالونی'
    }),
    photonFeature('Shifa International Hospital', 'Islamabad', 'amenity', 'hospital', 33.7069, 73.0498),
    photonFeature('Jinnah Street', 'Rawalpindi', 'highway', 'residential', 33.5968, 73.1330),
    photonFeature('جناح بین الاقوامی ہوائی اڈہ', 'کراچی', 'aeroway', 'aerodrome', 24.9058, 67.1614, {
      street: 'New Terminal Road',
      locality: 'ڈرگ کالونی'
    }),
    photonFeature('Outside Pakistan', 'Delhi', 'amenity', 'hospital', 28.6139, 77.2090, {
      country: 'India',
      countrycode: 'IN'
    }),
    photonFeature('Bad coordinates', 'Lahore', 'amenity', 'hospital', 0, 0),
    { type: 'Feature', properties: { countrycode: 'PK' }, geometry: { type: 'LineString', coordinates: [] } }
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
    assert.deepEqual(result.body.map(item => item.type), ['aerodrome', 'hospital', 'residential']);
    assert.equal(result.body[0].providerType, 'aerodrome');
    assert.equal(result.body[0].address.city, 'کراچی');
    assert.match(result.body[0].display_name, /New Terminal Road/);
    assert.equal(result.body[1].address.amenity, 'hospital');
    assert.equal(result.body[2].address.highway, 'residential');
    assert.equal(requested.options.headers['User-Agent'], 'MyRide-App/1.0 (ride-hailing)');
    assert.equal(requested.options.headers['Accept-Language'], 'en,ur,pa,hi,sd');
    assert.equal(requested.url.origin, 'https://photon.komoot.io');
    assert.equal(requested.url.pathname, '/api/');
    assertNationwideQuery(requested.url, query);
  });
});

test('Photon keeps mixed-language queries unchanged and returns a clear upstream failure', async () => {
  delete process.env.LOCATIONIQ_KEY;
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
    assertNationwideQuery(requested.url, query);
    assert.equal(requested.url.searchParams.get('key'), null);
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
