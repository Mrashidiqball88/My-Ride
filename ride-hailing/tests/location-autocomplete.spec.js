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
});