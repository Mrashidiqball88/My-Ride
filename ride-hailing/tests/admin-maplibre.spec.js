// @ts-check
'use strict';

const { test, expect } = require('@playwright/test');
const jwt = require('jsonwebtoken');

const ADMIN_TOKEN = jwt.sign(
  { id: 'admin-1', isAdmin: true, email: 'admin@example.test' },
  'ride-hailing-secret-fallback'
);

test.describe('Admin Mapbox maps and city-aware place search', () => {
  test('renders both Admin maps without Leaflet and prioritizes the GPS city', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const reverseRequests = [];
    const placeRequests = [];
    const forbiddenMapRequests = [];
    page.on('request', request => {
      if (/leaflet|maplibre|openfreemap|tile\.openstreetmap\.org|\.tile\.osm/i.test(request.url())) {
        forbiddenMapRequests.push(request.url());
      }
    });

    await page.addInitScript(({ token }) => {
      localStorage.setItem('admin_token', token);
      localStorage.setItem('admin_email', 'admin@example.test');
    }, { token: ADMIN_TOKEN });
    await page.context().grantPermissions(['geolocation']);
    await page.context().setGeolocation({ latitude: 33.6844, longitude: 73.0479 });

    await page.route(/\/api\/admin(?:\/[^?]*)?(?:\?|$)/, async route => {
      const path = new URL(route.request().url()).pathname;
      let body = [];
      if (path === '/api/admin/session') {
        body = { isSuperAdmin: true, email: 'admin@example.test', permissions: {} };
      } else if (path === '/api/admin/stats') {
        body = {
          todayEarnings: 0, pendingPayments: 0, pendingDrivers: 0,
          activeRides: 1, totalDrivers: 1, suspendedDrivers: 0,
          totalPassengers: 1, blockedPassengers: 0, unresolvedSOS: 0
        };
      } else if (path === '/api/admin/daily-income') {
        body = [];
      } else if (path === '/api/admin/support') {
        body = [];
      } else if (path === '/api/admin/live-locations') {
        body = [{
          _id: 'driver-1',
          name: 'Fresh Driver',
          role: 'driver',
          phone: '03001234567',
          vehicleType: 'Car Mini',
          status: 'online',
          location: { lat: 33.6844, lng: 73.0479 },
          updatedAt: new Date().toISOString()
        }];
      } else if (path === '/api/admin/map-location/driver-1') {
        body = {
          _id: 'driver-1',
          name: 'Fresh Driver',
          role: 'driver',
          status: 'online',
          location: { lat: 33.6844, lng: 73.0479 },
          updatedAt: new Date().toISOString()
        };
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(body)
      });
    });

    await page.route(/\/api\/geocode(?:\/reverse)?(?:\?|$)/, async route => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith('/reverse')) {
        reverseRequests.push(url);
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ city: 'Islamabad', address: {}, display_name: 'Islamabad' })
        });
        return;
      }

      placeRequests.push(url);
      const broad = url.searchParams.get('broad') === '1';
      const query = url.searchParams.get('q');
      const results = query === 'lahore'
        ? [{
            lat: '31.5204', lon: '74.3587', display_name: 'Lahore Ring Road, Lahore, Pakistan',
            address: { road: 'Lahore Ring Road', city: 'Lahore' }, type: 'road', class: 'highway'
          }]
        : [
            {
              lat: '33.7077', lon: '73.0511', display_name: 'Blue Area, Islamabad, Pakistan',
              address: { suburb: 'Blue Area', city: 'Islamabad' }, type: 'suburb'
            },
            ...(broad ? [{
              lat: '24.9161', lon: '67.1025', display_name: 'Bahadurabad, Karachi, Pakistan',
              address: { suburb: 'Bahadurabad', city: 'Karachi' }, type: 'suburb'
            }] : [])
          ];
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(results)
      });
    });

    await page.goto('/admin');
    await expect(page.locator('#admin-app')).toBeVisible();
    await expect.poll(() => reverseRequests.length).toBeGreaterThan(0);
    await expect(page.locator('#admin-live-map .mapboxgl-canvas')).toBeVisible();
    await expect.poll(() => page.evaluate(() => ({
      hasMapbox: Boolean(window.mapboxgl),
      hasLeaflet: Boolean(window.L),
      markerCount: adminLiveMarkers.size
    }))).toEqual({ hasMapbox: true, hasLeaflet: false, markerCount: 1 });
    expect(forbiddenMapRequests).toEqual([]);

    const placeInput = page.locator('#admin-place-search-input');
    await placeInput.fill('b');
    await expect.poll(() => placeRequests.some(url =>
      url.pathname === '/api/geocode' && url.searchParams.get('city') === 'Islamabad'
    )).toBe(true);
    await expect(page.locator('#admin-place-search-results')).toContainText('Blue Area');
    await expect(page.locator('#admin-place-search-results')).not.toContainText('Bahadurabad');

    await page.locator('#admin-place-expand').click();
    await expect.poll(() => placeRequests.some(url =>
      url.pathname === '/api/geocode' && url.searchParams.get('broad') === '1'
    )).toBe(true);
    await expect(page.locator('#admin-place-search-results')).toContainText('Bahadurabad');

    await placeInput.fill('lahore');
    await expect.poll(() => placeRequests.some(url =>
      url.pathname === '/api/geocode' && url.searchParams.get('city') === 'Lahore'
    )).toBe(true);
    await expect(page.locator('#admin-place-search-results')).toContainText('Lahore Ring Road');

    await page.evaluate(() => openLiveLocationMap('driver-1'));
    await expect(page.locator('#live-location-modal')).toHaveClass(/open/);
    await expect(page.locator('#live-location-map .mapboxgl-canvas')).toBeVisible();
    await expect.poll(() => page.evaluate(() => Boolean(liveLocationMap))).toBe(true);
    await page.evaluate(() => closeLiveLocationMap());
    await expect.poll(() => page.evaluate(() => liveLocationMap === null)).toBe(true);
  });
});