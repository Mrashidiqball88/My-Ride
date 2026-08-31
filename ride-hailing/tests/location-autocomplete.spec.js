// @ts-check
'use strict';

const { test, expect } = require('@playwright/test');

function geocodeResult(primary, city, lat, lon, kind = 'suburb') {
  return {
    display_name: `${primary}, ${city}, Pakistan`,
    lat: String(lat),
    lon: String(lon),
    type: kind,
    address: {
      [kind === 'road' ? 'road' : 'suburb']: primary,
      city
    }
  };
}

function poiResult(primary, city, lat, lon, type, extra = {}) {
  return {
    display_name: `${primary}, ${city}, Pakistan`,
    lat: String(lat),
    lon: String(lon),
    type,
    ...extra,
    address: {
      city,
      ...(extra.address || {})
    }
  };
}

async function setSearch(page, value, inputId = 'pickup-input') {
  await page.evaluate(({ value, inputId }) => {
    const input = document.getElementById(inputId);
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, { value, inputId });
}

async function visibleLocationNames(page) {
  return page.locator('#location-sheet-list [data-location-index] .sheet-item-primary').allTextContents();
}

test.describe('live nationwide location autocomplete', () => {
  test('renders arbitrary live provider places nationwide without local lists or city filtering', async ({ page }) => {
    const requests = [];
    await page.route(/\/api\/geocode(?:\?|$)/, async route => {
      const url = new URL(route.request().url());
      requests.push(url);
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify([
          geocodeResult('National Textile Innovation Park', 'Faisalabad', 31.4504, 73.1350, 'road'),
          geocodeResult('Quetta Arts University', 'Quetta', 30.1798, 66.9750),
          { display_name: 'Invalid provider record', lat: 'not-a-number', lon: '0' }
        ])
      });
    });

    await page.goto('/customer');
    await page.evaluate(() => {
      customerActiveCity = 'Karachi';
      customerCityLocation = { lat: 24.8607, lng: 67.0011 };
    });
    await setSearch(page, 'textile innovation park');

    await expect.poll(() => visibleLocationNames(page)).toHaveLength(2);
    const names = await visibleLocationNames(page);
    expect(names).toEqual(expect.arrayContaining([
      'National Textile Innovation Park',
      'Quetta Arts University'
    ]));
    expect(await page.locator('#location-sheet-list').textContent()).not.toContain('Invalid provider record');
    expect(requests).toHaveLength(1);
    expect(requests[0].searchParams.get('q')).toBe('textile innovation park');
    expect(requests[0].searchParams.get('city')).toBeNull();
    expect(requests[0].searchParams.get('broad')).toBeNull();
    expect(requests[0].searchParams.get('global')).toBeNull();
  });

  test('keeps live results from other cities and ignores stale responses after rapid typing', async ({ page }) => {
    const requests = [];
    await page.route(/\/api\/geocode(?:\?|$)/, async route => {
      const url = new URL(route.request().url());
      const query = url.searchParams.get('q');
      requests.push(query);
      if (query === 'old place') {
        await new Promise(resolve => setTimeout(resolve, 180));
        return route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify([geocodeResult('Old Live Place', 'Lahore', 31.5204, 74.3587)])
        });
      }
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify([geocodeResult('Fresh Live University', 'Peshawar', 34.0151, 71.5249)])
      });
    });

    await page.goto('/customer');
    await page.evaluate(() => {
      customerActiveCity = 'Karachi';
      customerCityLocation = { lat: 24.8607, lng: 67.0011 };
    });
    await setSearch(page, 'old place');
    await expect.poll(() => requests).toContain('old place');
    await setSearch(page, 'fresh university');

    await expect.poll(() => visibleLocationNames(page)).toEqual(['Fresh Live University']);
    await expect(page.locator('#location-sheet-list')).not.toContainText('Old Live Place');
    expect(requests).toContain('fresh university');
  });

  test('uses live provider results for voice input and preserves the spoken transcript', async ({ page }) => {
    await page.addInitScript(() => {
      window.__recognition = null;
      window.SpeechRecognition = class {
        constructor() { window.__recognition = this; }
        start() { this.onstart?.(); }
        abort() {}
        stop() { this.onend?.(); }
      };
    });
    await page.route(/\/api\/geocode(?:\?|$)/, route => route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify([
        geocodeResult('Shalimar Hospital', 'Lahore', 31.5822, 74.3921, 'hospital')
      ])
    }));

    await page.goto('/customer');
    await page.evaluate(() => {
      customerActiveCity = 'Karachi';
      startVoiceSearch('pickup');
    });
    await page.evaluate(() => {
      window.__recognition.onresult({ results: [[{ transcript: 'Shalimar Hospital' }]] });
      window.__recognition.onend();
    });

    await expect(page.locator('#pickup-input')).toHaveValue('Shalimar Hospital');
    await expect(page.locator('#location-sheet-list')).toContainText('Shalimar Hospital');
    await expect(page.locator('#location-sheet-list .sheet-item-tertiary').first()).toContainText('Lahore');
    await expect(page.locator('#location-sheet-list .sheet-item-coordinates').first())
      .toHaveText(/\d+\.\d{4},\s+\d+\.\d{4}/);
  });

  test('preserves mixed Urdu and English input for the live provider query', async ({ page }) => {
    let requestedQuery;
    await page.route(/\/api\/geocode(?:\?|$)/, async route => {
      requestedQuery = new URL(route.request().url()).searchParams.get('q');
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify([
          poiResult('Jinnah International Airport', 'Karachi', 24.9058, 67.1614, 'aerodrome')
        ])
      });
    });

    await page.goto('/customer');
    const query = 'جناح  airport';
    await setSearch(page, query);

    await expect(page.locator('#location-sheet-list')).toContainText('Jinnah International Airport');
    expect(requestedQuery).toBe(query);
  });

  test('keeps vital POI categories from multiple cities and labels provider metadata', async ({ page }) => {
    const requests = [];
    await page.route(/\/api\/geocode(?:\?|$)/, async route => {
      const url = new URL(route.request().url());
      requests.push(url);
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify([
          poiResult('Allama Iqbal International Airport', 'Lahore', 31.5216, 74.4036, 'aerodrome'),
          poiResult('Daewoo Bus Terminal', 'Karachi', 24.8947, 67.0632, 'bus_station'),
          poiResult('Aga Khan University Hospital', 'Karachi', 24.8934, 67.0746, 'hospital'),
          poiResult('Government College University', 'Faisalabad', 31.4180, 73.0790, 'college'),
          poiResult('University of Peshawar', 'Peshawar', 34.0209, 71.4874, 'university'),
          poiResult('Liberty Chowk', 'Lahore', 31.5107, 74.3441, 'place', { name: 'Liberty Chowk' }),
          poiResult('Pakistan Monument', 'Islamabad', 33.6938, 73.0652, 'monument'),
          poiResult('Unknown Community Place', 'Quetta', 30.1798, 66.9750, 'community_centre')
        ])
      });
    });

    await page.goto('/customer');
    await page.evaluate(() => {
      customerActiveCity = 'Karachi';
      pickup = { lat: 24.8607, lng: 67.0011 };
    });
    await setSearch(page, 'important places');

    await expect.poll(() => visibleLocationNames(page)).toHaveLength(8);
    const sheet = page.locator('#location-sheet-list');
    await expect(sheet).toContainText('Airport');
    await expect(sheet).toContainText('Bus terminal / station');
    await expect(sheet).toContainText('Healthcare');
    await expect(sheet).toContainText('College');
    await expect(sheet).toContainText('University');
    await expect(sheet).toContainText('Intersection / chowk');
    await expect(sheet).toContainText('Landmark');
    await expect(sheet).toContainText('Community Centre');
    expect(requests).toHaveLength(1);
    expect(requests[0].searchParams.get('q')).toBe('important places');
    expect(requests[0].searchParams.get('countrycodes')).toBeNull();
    expect(requests[0].searchParams.get('city')).toBeNull();
    expect(requests[0].searchParams.get('radius')).toBeNull();
    expect(requests[0].searchParams.get('viewbox')).toBeNull();
    expect(requests[0].searchParams.get('bounded')).toBeNull();
    expect(requests[0].searchParams.get('type')).toBeNull();
  });

  test('uses the live customer pin before pickup and omits proximity without either pin', async ({ page }) => {
    let requestedUrl;
    await page.route(/\/api\/geocode(?:\?|$)/, async route => {
      requestedUrl = new URL(route.request().url());
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify([
          poiResult('Jinnah International Airport', 'Karachi', 24.9065, 67.1608, 'airport'),
          poiResult('Khyber Medical University', 'Peshawar', 34.0151, 71.5249, 'university')
        ])
      });
    });

    await page.goto('/customer');
    await page.evaluate(() => {
      pickup = null;
      customerLocation = { lat: 24.8607, lng: 67.0011 };
      customerCityLocation = { lat: 33.6844, lng: 73.0479 };
      customerActiveCity = 'Islamabad';
    });
    await setSearch(page, 'airport');

    await expect.poll(() => visibleLocationNames(page)).toHaveLength(2);
    expect(requestedUrl.searchParams.get('q')).toBe('airport');
    expect(requestedUrl.searchParams.get('proximity')).toBe('67.0011,24.8607');

    await page.evaluate(() => {
      pickup = null;
      customerLocation = null;
    });
    await setSearch(page, 'airport without pin');
    await expect.poll(() => requestedUrl.searchParams.get('q')).toBe('airport without pin');
    expect(requestedUrl.searchParams.get('proximity')).toBeNull();
  });

  test('sends the active pickup pin and refreshes proximity after the pin changes', async ({ page }) => {
    const requests = [];
    await page.route(/\/api\/geocode(?:\?|$)/, async route => {
      const url = new URL(route.request().url());
      requests.push(url);
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify([
          poiResult('Nearby provider result', 'Pakistan', 30, 70, 'place')
        ])
      });
    });

    await page.goto('/customer');
    await page.evaluate(() => {
      pickup = { lat: 31.5204, lng: 74.3587 };
      customerLocation = { lat: 24.8607, lng: 67.0011 };
    });
    await setSearch(page, 'first pickup area');
    await expect.poll(() => requests).toHaveLength(1);
    expect(requests[0].searchParams.get('proximity')).toBe('74.3587,31.5204');

    await page.evaluate(() => {
      pickup = { lat: 24.8607, lng: 67.0011 };
    });
    await setSearch(page, 'second pickup area');
    await expect.poll(() => requests).toHaveLength(2);
    expect(requests[1].searchParams.get('proximity')).toBe('67.0011,24.8607');
  });

  test('selects live pickup and drop-off results and pins their coordinates', async ({ page }) => {
    await page.route(/\/api\/geocode(?:\?|$)/, async route => {
      const url = new URL(route.request().url());
      const query = url.searchParams.get('q');
      const result = query === 'new pickup'
        ? geocodeResult('New Pickup Plaza', 'Multan', 30.1575, 71.5249, 'road')
        : geocodeResult('New Drop-off Chowk', 'Rawalpindi', 33.5651, 73.0169);
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify([result])
      });
    });

    await page.goto('/customer');
    await page.evaluate(() => {
      document.getElementById('auth-screen').style.display = 'none';
      document.getElementById('app').style.display = 'flex';
    });
    await setSearch(page, 'new pickup');
    await expect(page.locator('#location-sheet-list')).toContainText('New Pickup Plaza');
    await page.locator('#location-sheet-list [data-location-index]').first().click();
    await expect.poll(() => page.evaluate(() => pickup)).toMatchObject({
      lat: 30.1575,
      lng: 71.5249
    });
    await expect(page.locator('#customer-center-pin')).toHaveClass(/visible/);
    expect(await page.locator('#customer-center-pin').evaluate(element => {
      const mapRect = document.getElementById('map').getBoundingClientRect();
      const pinRect = element.getBoundingClientRect();
      return {
        position: getComputedStyle(element).position,
        horizontalOffset: Math.abs((pinRect.left + pinRect.width / 2) - (mapRect.left + mapRect.width / 2)),
        tipOffset: Math.abs(pinRect.bottom - (mapRect.top + mapRect.height / 2))
      };
    })).toMatchObject({ position: 'absolute', horizontalOffset: 0, tipOffset: 0 });

    await setSearch(page, 'new drop-off', 'stop-0-input');
    await expect(page.locator('#location-sheet-list')).toContainText('New Drop-off Chowk');
    await page.locator('#location-sheet-list [data-location-index]').first().click();
    await expect.poll(() => page.evaluate(() => ({
      dropoff: dropoffs[0],
      mode: mapMode,
      input: document.getElementById('stop-0-input').value
    }))).toMatchObject({
      dropoff: { lat: 33.5651, lng: 73.0169 },
      mode: 'idle',
      input: 'New Drop-off Chowk'
    });
    await expect(page.locator('#customer-center-pin')).not.toHaveClass(/visible/);
  });

  test('commits the fixed center pin after a customer map drag', async ({ page }) => {
    await page.goto('/customer');
    const selected = await page.evaluate(() => {
      const previousMap = map;
      const previousSetPickup = setPickup;
      let result = null;
      mapMode = 'pickup';
      customerMapSelectionGesture = true;
      map = { getCenter: () => ({ lat: 31.5204, lng: 74.3587 }) };
      setPickup = (lat, lng) => { result = { lat, lng }; };
      selectCustomerMapCenter();
      setPickup = previousSetPickup;
      map = previousMap;
      return result;
    });
    expect(selected).toEqual({ lat: 31.5204, lng: 74.3587 });
  });

  test('shows an actionable provider error and clears stale results', async ({ page }) => {
    let shouldFail = false;
    await page.route(/\/api\/geocode(?:\?|$)/, route => {
      if (shouldFail) {
        return route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Geocoding is temporarily unavailable' })
        });
      }
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify([geocodeResult('First Live Result', 'Lahore', 31.5204, 74.3587)])
      });
    });

    await page.goto('/customer');
    await setSearch(page, 'first live');
    await expect(page.locator('#location-sheet-list')).toContainText('First Live Result');
    shouldFail = true;
    await setSearch(page, 'provider outage');
    await expect(page.locator('#location-sheet-list')).toContainText('Location search is unavailable right now');
    await expect(page.locator('#location-sheet-list')).not.toContainText('First Live Result');
  });

  test('recovers cleanly from a provider timeout', async ({ page }) => {
    await page.addInitScript(() => {
      window.__CUSTOMER_SEARCH_TIMEOUT_MS = 40;
    });
    await page.route(/\/api\/geocode(?:\?|$)/, route => new Promise(resolve => {
      setTimeout(() => resolve(route.fulfill({
        contentType: 'application/json',
        body: '[]'
      })), 200);
    }));

    await page.goto('/customer');
    await setSearch(page, 'remote timeout place');
    await expect.poll(() => page.evaluate(() => locationSearchError)).toContain('timed out');
    await expect(page.locator('#location-sheet-list')).toContainText('timed out');
    await expect.poll(() => page.evaluate(() => ({
      loading: locationSearchLoading,
      aborted: locSearchAbort.pickup === null
    }))).toEqual({ loading: false, aborted: true });
  });
});