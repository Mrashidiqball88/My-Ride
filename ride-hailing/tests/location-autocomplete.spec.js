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

async function setSearch(page, value) {
  await page.evaluate(value => {
    const input = document.getElementById('pickup-input');
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}

async function visibleLocationNames(page) {
  return page.locator('#location-sheet-list [data-location-index] .sheet-item-primary').allTextContents();
}

test.describe('dynamic city location autocomplete', () => {
  test('allows one-letter search, prioritizes the active city, expands on scroll, and follows GPS city changes', async ({ page }) => {
    const requests = [];
    await page.route(/\/api\/geocode(?:\/reverse)?(?:\?|$)/, async route => {
      const url = new URL(route.request().url());
      requests.push(url);

      if (url.pathname.endsWith('/reverse')) {
        const isIslamabad = Number(url.searchParams.get('lat')) > 30;
        return route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            city: isIslamabad ? 'Islamabad Capital Territory' : 'Karachi',
            display_name: isIslamabad ? 'Blue Area, Islamabad, Pakistan' : 'Gulshan-e-Iqbal, Karachi, Pakistan',
            address: { city: isIslamabad ? 'Islamabad Capital Territory' : 'Karachi' }
          })
        });
      }

      const query = (url.searchParams.get('q') || '').toLocaleLowerCase();
      const broad = url.searchParams.get('broad') === '1';
      let results = [];
      if (query === 'g') {
        results = [
          geocodeResult('Gulshan-e-Iqbal', 'Karachi', 24.9161, 67.1025),
          geocodeResult('Gulberg', 'Lahore', 31.5100, 74.3500)
        ];
      } else if (query === 'b') {
        results = [
          geocodeResult('Blue Area', 'Islamabad', 33.7077, 73.0500),
          geocodeResult('Bahria Town Lahore', 'Lahore', 31.3680, 74.1880)
        ];
      } else if (query.includes('lahore')) {
        results = [geocodeResult('Gulberg', 'Lahore', 31.5100, 74.3500)];
      }

      if (broad && query === 'g') {
        results.push(geocodeResult('Gulberg', 'Lahore', 31.5100, 74.3500));
      }

      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(results)
      });
    });

    await page.goto('/customer');
    await page.evaluate(() => {
      customerActiveCity = 'Karachi';
      customerCityLocation = { lat: 24.8607, lng: 67.0011 };
    });

    await setSearch(page, 'g');
    await expect.poll(() => visibleLocationNames(page)).toEqual(['Gulshan-e-Iqbal']);
    await expect(page.locator('#location-sheet-list')).not.toContainText('Gulberg');
    await expect.poll(() => requests.some(url =>
      url.pathname.endsWith('/api/geocode') && url.searchParams.get('city') === 'Karachi'
    )).toBe(true);
    const localSearchRequest = requests.find(url =>
      url.pathname.endsWith('/api/geocode') && url.searchParams.get('city') === 'Karachi'
    );
    expect(localSearchRequest.searchParams.get('lat')).toBe('24.8607');
    expect(localSearchRequest.searchParams.get('lng')).toBe('67.0011');
    expect(localSearchRequest.searchParams.get('radiusKm')).toBeNull();
    expect(localSearchRequest.searchParams.get('viewbox')).toBeNull();
    expect(localSearchRequest.searchParams.get('bounded')).toBeNull();

    const firstName = await page.locator('#location-sheet-list [data-location-index] .sheet-item-primary').first().textContent();
    expect(firstName).toBe('Gulshan-e-Iqbal');

    const resultList = page.locator('#location-sheet-list');
    await resultList.evaluate(list => {
      list.scrollTop = list.scrollHeight;
      list.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    await expect(page.locator('#location-sheet-list')).toContainText('Gulberg');
    await expect.poll(() => requests.some(url =>
      url.pathname.endsWith('/api/geocode')
      && url.searchParams.get('broad') === '1'
    )).toBe(true);

    await setSearch(page, 'Lahore');
    await expect.poll(() => visibleLocationNames(page)).not.toHaveLength(0);
    const explicitCityResults = await visibleLocationNames(page);
    expect(explicitCityResults[0]).toMatch(/Lahore/i);
    const explicitResultCards = await page.locator('#location-sheet-list [data-location-index]').evaluateAll(
      cards => cards.every(card => /Lahore/i.test(card.textContent || ''))
    );
    expect(explicitResultCards).toBe(true);
    await expect(page.locator('#location-sheet-list')).not.toContainText('Gulshan-e-Iqbal');

    await page.evaluate(async () => {
      customerCityLocation = null;
      await detectCustomerActiveCity(33.6844, 73.0479);
    });
    await setSearch(page, 'b');
    await expect.poll(() => visibleLocationNames(page)).toContain('Blue Area');
    await expect(page.locator('#location-sheet-list [data-location-index] .sheet-item-primary').first()).toHaveText('Blue Area');
    await expect.poll(() => requests.some(url =>
      url.pathname.endsWith('/api/geocode') && url.searchParams.get('city') === 'Islamabad'
    )).toBe(true);
  });

  test('matches a phonetic misspelling and explains voice fallback', async ({ page }) => {
    await page.goto('/customer');
    await page.evaluate(() => {
      customerActiveCity = 'Lahore';
      customerCityLocation = { lat: 31.5204, lng: 74.3587 };
    });

    await setSearch(page, 'gulbur');
    await expect(page.locator('#location-sheet-list')).toContainText('Gulberg');

    await setSearch(page, 'Islamabad');
    await expect(page.locator('#location-sheet-list')).toContainText('F-7 Markaz');
    await expect(page.locator('#location-sheet-list')).toContainText('G-9 Markaz');

    await setSearch(page, 'packages Mall');
    await expect(page.locator('#location-sheet-list')).toContainText('Packages Mall');

    await setSearch(page, 'PACAGES');
    await expect(page.locator('#location-sheet-list')).toContainText('Packages Mall');

    await setSearch(page, 'PAKGS');
    await expect(page.locator('#location-sheet-list')).toContainText('Packages Mall');

    await setSearch(page, 'PACAG');
    await expect(page.locator('#location-sheet-list')).toContainText('Packages Mall');

    await setSearch(page, 'PAKAG');
    await expect(page.locator('#location-sheet-list')).toContainText('Packages Mall');

    await page.evaluate(() => {
      window.SpeechRecognition = undefined;
      window.webkitSpeechRecognition = undefined;
      startVoiceSearch('pickup');
    });
    await expect(page.locator('#location-voice-status')).toContainText('not supported');
  });

  test('keeps the spoken location visible after recognition ends', async ({ page }) => {
    await page.addInitScript(() => {
      window.__recognition = null;
      window.SpeechRecognition = class {
        constructor() { window.__recognition = this; }
        start() { this.onstart?.(); }
        abort() {}
        stop() { this.onend?.(); }
      };
    });

    await page.goto('/customer');
    await page.evaluate(() => {
      customerActiveCity = 'Lahore';
      customerCityLocation = { lat: 31.5204, lng: 74.3587 };
      startVoiceSearch('pickup');
    });
    await page.evaluate(() => {
      window.__recognition.onresult({ results: [[{ transcript: 'PACAG' }]] });
      window.__recognition.onend();
    });

    await expect(page.locator('#pickup-input')).toHaveValue('Packages Mall');
    await expect(page.locator('#location-sheet-list')).toContainText('Packages Mall');
    await expect(page.locator('#location-voice-status')).toContainText('Found');
    await expect(page.locator('#location-voice-status')).toContainText('Packages Mall');
  });

  test('renders rich Lahore landmark cards from voice search and pins the selected drop-off', async ({ page }) => {
    await page.addInitScript(() => {
      window.__recognition = null;
      window.SpeechRecognition = class {
        constructor() { window.__recognition = this; }
        start() { this.onstart?.(); }
        abort() {}
        stop() { this.onend?.(); }
      };
    });
    await page.goto('/customer');
    await page.evaluate(() => {
      document.getElementById('auth-screen').style.display = 'none';
      document.getElementById('app').style.display = 'flex';
      customerActiveCity = 'Lahore';
      customerCityLocation = { lat: 31.5204, lng: 74.3587 };
      startVoiceSearch('pickup');
    });
    await page.evaluate(() => {
      window.__recognition.onresult({ results: [[{ transcript: 'inshallah hospital' }]] });
      window.__recognition.onend();
    });

    await expect(page.locator('#pickup-input')).toHaveValue('Shalimar Hospital');
    await expect(page.locator('#location-sheet-list')).toContainText('Shalimar Hospital');
    await expect(page.locator('#location-sheet-list .sheet-item-tertiary').first())
      .toContainText('Lahore');
    await expect(page.locator('#location-sheet-list .sheet-item-coordinates').first())
      .toHaveText(/\d+\.\d{4},\s+\d+\.\d{4}/);
    await page.locator('#location-sheet-list [data-location-index]')
      .filter({ hasText: 'Shalimar Hospital' }).first().click();
    await expect.poll(() => page.evaluate(() => pickup)).toMatchObject({
      lat: 31.5822,
      lng: 74.3921
    });

    await page.evaluate(() => {
      const input = document.getElementById('stop-0-input');
      input.value = 'Chowk Yateem Khana';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await expect(page.locator('#location-sheet-list')).toContainText('Chowk Yateem Khana');
    await page.locator('#location-sheet-list [data-location-index]').filter({ hasText: 'Chowk Yateem Khana' }).first().click();
    await expect.poll(() => page.evaluate(() => ({
      dropoff: dropoffs[0],
      mode: mapMode,
      input: document.getElementById('stop-0-input').value
    }))).toMatchObject({
      dropoff: { lat: 31.5089, lng: 74.2817 },
      mode: 'idle',
      input: 'Chowk Yateem Khana'
    });
  });

  test('uses the first valid GPS fix as pickup, then preserves a manual clear', async ({ page }) => {
    await page.goto('/customer');
    await page.evaluate(() => {
      document.getElementById('auth-screen').style.display = 'none';
      document.getElementById('app').style.display = 'flex';
      if (!map) initMap();
    });
    await expect.poll(() => page.evaluate(() => Boolean(map))).toBe(true);
    await page.evaluate(() => {
      pickup = null;
      customerGpsHasFix = false;
      customerAutoPickupEnabled = true;
      applyCustomerGpsPosition({ coords: { latitude: 31.5822, longitude: 74.3921 } });
    });
    await expect.poll(() => page.evaluate(() => pickup)).toMatchObject({
      lat: 31.5822,
      lng: 74.3921
    });
    await expect.poll(() => page.evaluate(() => mapMode)).toBe('stop-0');
    await page.evaluate(() => clearLocation('pickup'));
    await page.evaluate(() => {
      applyCustomerGpsPosition({ coords: { latitude: 31.5832, longitude: 74.3931 } });
    });
    await expect.poll(() => page.evaluate(() => pickup)).toBeNull();
  });

  test('uses the first pickup pin to replace the active city and prioritize the matching DHA', async ({ page }) => {
    const requests = [];
    await page.route(/\/api\/geocode(?:\/reverse)?(?:\?|$)/, async route => {
      const url = new URL(route.request().url());
      requests.push(url);
      if (url.pathname.endsWith('/reverse')) {
        return route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            city: 'Karachi',
            display_name: 'DHA Phase 6, Karachi, Pakistan',
            address: { city: 'Karachi' }
          })
        });
      }
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify([
          geocodeResult('DHA Phase 6', 'Karachi', 24.7915, 67.0648),
          geocodeResult('DHA Phase 5', 'Lahore', 31.4697, 74.4087)
        ])
      });
    });

    await page.goto('/customer');
    await page.evaluate(async () => {
      customerActiveCity = 'Lahore';
      customerCityLocation = { lat: 31.5204, lng: 74.3587 };
      pickup = { lat: 24.7915, lng: 67.0648, address: 'DHA Phase 6' };
      setCustomerPickupCityContext(24.7915, 67.0648);
      await new Promise(resolve => setTimeout(resolve, 20));
    });
    await expect.poll(() => page.evaluate(() => customerActiveCity)).toBe('Karachi');

    await setSearch(page, 'DHA');
    await expect.poll(() => visibleLocationNames(page)).not.toHaveLength(0);
    await expect(page.locator('#location-sheet-list [data-location-index] .sheet-item-primary').first())
      .toHaveText('DHA Phase 6');
    expect(await page.evaluate(() => pickup)).toMatchObject({ lat: 24.7915, lng: 67.0648 });
    await expect.poll(() => requests.some(url => url.pathname.endsWith('/api/geocode'))).toBe(true);
    const searchRequest = requests.find(url => url.pathname.endsWith('/api/geocode'));
    expect(searchRequest.searchParams.get('city')).toBe('Karachi');
    expect(searchRequest.searchParams.get('lat')).toBe('24.7915');
    expect(searchRequest.searchParams.get('lng')).toBe('67.0648');
  });

  test('shows actionable capability states and keeps the search sheet usable', async ({ page }) => {
    await page.goto('/customer');
    await page.evaluate(() => {
      customerReadinessState = {
        location: 'denied',
        microphone: 'denied',
        notifications: 'unavailable',
        audio: 'ready'
      };
      customerReadinessManualLocation = true;
      renderCustomerReadiness();
      document.getElementById('app').style.display = 'flex';
      document.getElementById('customer-readiness').classList.add('open');
    });

    await expect(page.locator('.customer-permission-row')).toHaveCount(4);
    await expect(page.locator('[data-permission="location"] .customer-permission-state')).toHaveText('Manual pin');
    await expect(page.locator('[data-permission="microphone"] .customer-permission-state')).toHaveText('Blocked');
    await expect(page.locator('#customer-readiness-continue')).toHaveText('Continue');

    await setSearch(page, 'g');
    await expect(page.locator('#location-sheet')).toHaveClass(/open/, { timeout: 5000 });
    const sheetBox = await page.locator('#location-sheet').boundingBox();
    const inputBox = await page.locator('#location-search-slot .location-input').boundingBox();
    expect(sheetBox).not.toBeNull();
    expect(inputBox).not.toBeNull();
    expect(inputBox.height).toBeGreaterThan(0);
    expect(await page.locator('#location-search-slot').evaluate(element =>
      getComputedStyle(element).position
    )).toBe('sticky');
  });

  test('clears stale results and resets the search state after the deadline', async ({ page }) => {
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
    await setSearch(page, 'unknown remote landmark');
    await expect.poll(() => page.evaluate(() => locationSearchError)).toContain('timed out');
    await expect(page.locator('#location-sheet-list')).toContainText('timed out');
    await expect.poll(() => page.evaluate(() => ({
      loading: locationSearchLoading,
      aborted: locSearchAbort.pickup === null
    }))).toEqual({ loading: false, aborted: true });
  });

  test('auto-resets a stuck voice session and allows the next attempt', async ({ page }) => {
    await page.addInitScript(() => {
      window.__CUSTOMER_SEARCH_TIMEOUT_MS = 40;
      let starts = 0;
      window.SpeechRecognition = class {
        start() { starts += 1; window.voiceStartCount = starts; }
        abort() {}
        stop() {}
      };
    });

    await page.goto('/customer');
    await page.evaluate(() => {
      document.getElementById('app').style.display = 'flex';
      document.getElementById('auth-screen').style.display = 'none';
      setBookingSheetExpanded(true);
    });
    await page.locator('.btn-voice[aria-label="Search pickup by voice"]').click();
    await expect.poll(() => page.evaluate(() => ({
      recognition: voiceRecognition,
      type: voiceSearchType,
      starts: window.voiceStartCount,
      listening: document.querySelectorAll('.btn-voice.listening').length,
      input: document.getElementById('pickup-input').value
    }))).toEqual({
      recognition: null,
      type: null,
      starts: 1,
      listening: 0,
      input: ''
    });
    await expect(page.locator('#location-voice-status')).toContainText('timed out');

    await page.locator('.btn-voice[aria-label="Search pickup by voice"]').click();
    await expect.poll(() => page.evaluate(() => window.voiceStartCount)).toBe(2);
  });
});