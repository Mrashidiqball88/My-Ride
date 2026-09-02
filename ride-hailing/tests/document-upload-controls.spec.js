// @ts-check
'use strict';

const { test, expect } = require('@playwright/test');

test.describe('document upload source controls', () => {
  test('Customer exposes camera and gallery actions for both ID sides', async ({ page }) => {
    await page.goto('/customer');

    const front = page.locator('#r-cnic-front');
    const back = page.locator('#r-cnic-back');
    await expect(page.locator('#register-form .document-upload-actions').nth(0).locator('.document-source-btn', { hasText: 'Take Photo' })).toHaveCount(1);
    await expect(page.locator('#register-form .document-upload-actions').nth(1).locator('.document-source-btn', { hasText: 'Take Photo' })).toHaveCount(1);
    await expect(page.locator('#register-form .document-upload-actions').nth(0).locator('.document-source-btn', { hasText: 'Choose from Gallery' })).toHaveCount(1);
    await expect(page.locator('#register-form .document-upload-actions').nth(1).locator('.document-source-btn', { hasText: 'Choose from Gallery' })).toHaveCount(1);
    await expect(page.locator('#r-student-id-image')).toHaveCount(1);

    await page.evaluate(() => openDocumentSource('r-cnic-front', 'camera'));
    await expect(front).toHaveAttribute('capture', 'environment');
    await page.evaluate(() => openDocumentSource('r-cnic-front', 'gallery'));
    await expect(front).not.toHaveAttribute('capture');

    await page.evaluate(() => openDocumentSource('r-cnic-back', 'camera'));
    await expect(back).toHaveAttribute('capture', 'environment');
  });

  test('Customer reveals mandatory Student verification fields only when selected', async ({ page }) => {
    await page.goto('/customer');
    await page.getByRole('button', { name: 'Register' }).click();

    const studentToggle = page.locator('#r-is-student');
    const studentFields = page.locator('#student-registration-fields');
    await expect(studentFields).toBeHidden();
    await studentToggle.check();
    await expect(studentFields).toBeVisible();
    await expect(page.locator('#r-student-id')).toBeVisible();
    await expect(page.locator('#r-student-institution')).toBeVisible();
    await expect(page.locator('#r-student-id-image')).toBeVisible();
    await expect(page.locator('#student-fare-breakdown')).toHaveCount(1);
    await studentToggle.uncheck();
    await expect(studentFields).toBeHidden();
  });

  test('Customer master Student feature toggle hides and disables signup controls when OFF', async ({ page }) => {
    let featureEnabled = false;
    await page.route('**/api/customer/fare-config', async route => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          perKmRates: {},
          longRangeSettings: { enabled: false, distanceCutoffKm: 100, perKmRates: {} },
          displaySettings: { showVehicleRates: true, showFareBreakdown: true },
          vehicleCategories: [],
          waitingRateSettings: {},
          studentFeatureEnabled: featureEnabled
        })
      });
    });

    await page.goto('/customer');
    await page.getByRole('button', { name: 'Register' }).click();
    await expect(page.locator('#r-is-student')).toBeHidden();
    await expect(page.locator('#r-is-student')).toBeDisabled();
    await expect(page.locator('#student-registration-fields')).toBeHidden();
    await expect(page.locator('#r-student-id-image')).toBeDisabled();

    featureEnabled = true;
    await page.reload();
    await page.getByRole('button', { name: 'Register' }).click();
    await expect(page.locator('#r-is-student')).toBeVisible();
    await expect(page.locator('#r-is-student')).toBeEnabled();
    await page.locator('#r-is-student').check();
    await expect(page.locator('#student-registration-fields')).toBeVisible();
    await expect(page.locator('#r-student-id-image')).toBeEnabled();
  });

  test('Driver exposes camera and gallery actions for registration and replacement documents', async ({ page }) => {
    await page.goto('/driver');

    const profile = page.locator('#r-profile-photo');
    const vehicle = page.locator('#cv-vehicle-reg');
    await expect(page.locator('.document-source-btn', { hasText: 'Take Photo' })).toHaveCount(6);
    await expect(page.locator('.document-source-btn', { hasText: 'Choose from Gallery' })).toHaveCount(6);

    await page.evaluate(() => openDocumentSource('r-profile-photo', 'camera', 'user'));
    await expect(profile).toHaveAttribute('capture', 'user');
    await page.evaluate(() => openDocumentSource('r-profile-photo', 'gallery'));
    await expect(profile).not.toHaveAttribute('capture');

    await page.evaluate(() => openDocumentSource('cv-vehicle-reg', 'camera'));
    await expect(vehicle).toHaveAttribute('capture', 'environment');
  });
});