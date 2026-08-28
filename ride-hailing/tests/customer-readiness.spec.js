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
