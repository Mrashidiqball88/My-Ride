// @ts-check
'use strict';

const { test, expect } = require('@playwright/test');

async function prepareReadiness(page) {
  await page.goto('/customer');
  await page.evaluate(() => {
    document.getElementById('auth-screen').style.display = 'none';
    document.getElementById('app').style.display = 'flex';
    token = 'readiness-test-token';
    user = { name: 'Readiness Test Customer', role: 'customer' };
    customerReadinessInitialized = false;
    customerReadinessRun = 0;
    customerReadinessBusy = false;
    customerReadinessManualLocation = false;
    sessionStorage.removeItem('myride:customer-readiness');
    void initCustomerReadiness();
  });
  await expect(page.locator('#customer-readiness')).toHaveClass(/open/);
}

test.describe('Customer booking-tool readiness', () => {
  test('restores an active ride on launch and keeps booking locked on resume', async ({ page }) => {
    const activeRide = {
      _id: 'customer-recovery-ride',
      status: 'in-progress',
      fare: 850,
      pickupReachedAt: null,
      pickupLocation: { lat: 24.86, lng: 67.01, address: 'Pickup Street' },
      dropoffLocation: { lat: 24.87, lng: 67.02, address: 'Dropoff Avenue' },
      driverLocation: { lat: 24.865, lng: 67.015 },
      driver: {
        _id: 'recovery-driver',
        name: 'Recovered Driver',
        phone: '03001234567',
        vehicleType: 'Car Sedan',
        vehicleModel: 'Corolla',
        vehiclePlate: 'ABC-123',
        rating: 4.9
      }
    };
    let activeReadCount = 0;

    await page.addInitScript(() => {
      localStorage.setItem('rh_token', 'customer-recovery-token');
      localStorage.setItem('rh_user', JSON.stringify({
        name: 'Recovery Customer',
        role: 'customer',
        accountStatus: 'active'
      }));
      sessionStorage.setItem('myride:customer-readiness', '1');
    });
    await page.route('**/api/rides/active', async route => {
      activeReadCount++;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(activeRide) });
    });
    await page.route('**/api/rides/my', route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
    );
    await page.route('**/api/rides', route => {
      if (route.request().method() === 'POST') {
        throw new Error('A duplicate booking request was sent while the active ride was restored');
      }
      return route.fallback();
    });

    await page.goto('/customer');
    await expect(page.locator('#active-ride')).toBeVisible();
    await expect(page.locator('#bottom-panel')).toBeHidden();
    await expect(page.locator('#ar-status-text')).toHaveText('Ride in progress 🚗');
    await expect(page.locator('#ar-driver-name')).toHaveText('Recovered Driver');
    await expect(page.locator('#ar-driver-vehicle')).toHaveText('Car Sedan · Corolla');
    await expect(page.locator('#ar-driver-plate')).toHaveText('ABC-123');

    await page.waitForTimeout(1300);
    await page.evaluate(() => {
      window.dispatchEvent(new Event('focus'));
      return bookRide();
    });
    await expect.poll(() => activeReadCount).toBeGreaterThanOrEqual(2);
    await expect(page.locator('#active-ride')).toBeVisible();
    await expect(page.locator('#bottom-panel')).toBeHidden();
    await expect.poll(() => page.evaluate(() => String(activeRide?._id))).toBe('customer-recovery-ride');
  });

  test('uses distinct and accurate artwork for the core vehicle categories', async ({ page }) => {
    await page.goto('/customer');

    const initialIcons = await page.evaluate(() => {
      const readIcon = category => {
        const icon = document.querySelector(`.vehicle-btn[data-type="${category}"] .v-icon`);
        return {
          html: icon?.innerHTML || '',
          text: icon?.textContent?.trim() || ''
        };
      };
      return {
        bike: readIcon('Bike'),
        miniAc: readIcon('Car Mini AC'),
        miniNonAc: readIcon('Car Mini Non-AC'),
        oldCars: readIcon('Old Cars'),
        caryDibba: readIcon('Cary Dibba'),
        electricScooty: readIcon('Electric Scooty')
      };
    });

    expect(initialIcons.bike.html).toContain('viewBox="0 0 80 44"');
    expect(initialIcons.bike.html).toContain('#e85d4a');
    expect(initialIcons.bike.html).not.toContain('M16 32 27 18h12l7 14');
    expect(initialIcons.bike.text).toBe('');
    expect(initialIcons.miniAc.text).toBe('🚙');
    expect(initialIcons.miniNonAc.html).toContain('#d95c55');
    expect(initialIcons.oldCars.html).toContain('#a77b4d');
    expect(initialIcons.caryDibba.html).toContain('#3a9b83');
    expect(initialIcons.electricScooty.text).toBe('🛵');

    const markerIcons = await page.evaluate(() => ({
      bike: customerVehicleIconMarkup('Bike', { marker: true }),
      nonAc: customerVehicleIconMarkup('Car Mini Non-AC', { marker: true }),
      oldCars: customerVehicleIconMarkup('Old Cars', { marker: true }),
      caryDibba: customerVehicleIconMarkup('Cary Dibba', { marker: true }),
      electricScooty: customerVehicleIconMarkup('Electric Scooty', { marker: true })
    }));
    expect(markerIcons.bike).toContain('vehicle-icon--marker');
    expect(markerIcons.nonAc).toContain('vehicle-icon--marker');
    expect(markerIcons.oldCars).toContain('vehicle-icon--marker');
    expect(markerIcons.caryDibba).toContain('vehicle-icon--marker');
    expect(markerIcons.electricScooty).toContain('vehicle-icon--marker');

    await page.evaluate(() => {
      renderCustomerVehicleCategories([
        { category: 'Bike', active: true },
        { category: 'Car Mini AC', active: true },
        { category: 'Car Mini Non-AC', active: true },
        { category: 'Old Cars', active: true },
        { category: 'Cary Dibba', active: true },
        { category: 'Electric Scooty', active: true }
      ]);
    });

    await expect(page.locator('.vehicle-btn[data-type="Bike"] .v-name')).toHaveText('Motor Bike');
    await expect(page.locator('.vehicle-btn[data-type="Bike"] .vehicle-icon--svg')).toHaveCount(1);
    await expect(page.locator('.vehicle-btn[data-type="Car Mini Non-AC"] .vehicle-icon--svg')).toHaveCount(1);
    await expect(page.locator('.vehicle-btn[data-type="Old Cars"] .vehicle-icon--svg')).toHaveCount(1);
    await expect(page.locator('.vehicle-btn[data-type="Cary Dibba"] .vehicle-icon--svg')).toHaveCount(1);
    await expect(page.locator('.vehicle-btn[data-type="Car Mini AC"] .vehicle-icon--emoji')).toHaveText('🚙');
    await expect(page.locator('.vehicle-btn[data-type="Electric Scooty"] .vehicle-icon--emoji')).toHaveText('🛵');
  });

  test('Continue dismisses the modal after permission prompts hang', async ({ page }) => {
    await page.addInitScript(() => {
      window.__CUSTOMER_PERMISSION_TIMEOUT_MS = 40;
      Object.defineProperty(navigator, 'geolocation', {
        configurable: true,
        value: { getCurrentPosition() {}, watchPosition() { return 1; }, clearWatch() {} }
      });
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: { getUserMedia: () => new Promise(() => {}) }
      });
      if ('Notification' in window) {
        Object.defineProperty(Notification, 'requestPermission', {
          configurable: true,
          value: () => new Promise(() => {})
        });
      }
    });

    await prepareReadiness(page);
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.locator('#customer-readiness')).not.toHaveClass(/open/);
    await expect.poll(() => page.evaluate(() => ({
      acknowledged: sessionStorage.getItem('myride:customer-readiness'),
      busy: customerReadinessBusy,
      manual: customerReadinessManualLocation
    }))).toEqual({ acknowledged: '1', busy: false, manual: true });
  });

  test('Skip for now closes immediately without requesting permissions', async ({ page }) => {
    await page.addInitScript(() => {
      window.__CUSTOMER_PERMISSION_TIMEOUT_MS = 1000;
    });

    await prepareReadiness(page);
    await page.getByRole('button', { name: 'Skip for now' }).click();
    await expect(page.locator('#customer-readiness')).not.toHaveClass(/open/);
    await expect.poll(() => page.evaluate(() => ({
      acknowledged: sessionStorage.getItem('myride:customer-readiness'),
      manual: customerReadinessManualLocation
    }))).toEqual({ acknowledged: '1', manual: true });
  });

  test('Continue dismisses cleanly when permissions are denied', async ({ page }) => {
    await page.addInitScript(() => {
      window.__CUSTOMER_PERMISSION_TIMEOUT_MS = 1000;
      Object.defineProperty(navigator, 'geolocation', {
        configurable: true,
        value: {
          getCurrentPosition(_success, error) { error({ code: 1, message: 'Permission denied' }); },
          watchPosition() { return 1; },
          clearWatch() {}
        }
      });
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: { getUserMedia: () => Promise.reject(Object.assign(new Error('Blocked'), { name: 'NotAllowedError' })) }
      });
      if ('Notification' in window) {
        Object.defineProperty(Notification, 'requestPermission', {
          configurable: true,
          value: () => Promise.resolve('denied')
        });
      }
    });

    await prepareReadiness(page);
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.locator('#customer-readiness')).not.toHaveClass(/open/);
    await expect.poll(() => page.evaluate(() => ({
      acknowledged: sessionStorage.getItem('myride:customer-readiness'),
      busy: customerReadinessBusy,
      manual: customerReadinessManualLocation
    }))).toEqual({ acknowledged: '1', busy: false, manual: true });
  });
});
