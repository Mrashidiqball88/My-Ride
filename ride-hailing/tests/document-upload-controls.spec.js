// @ts-check
'use strict';

const { test, expect } = require('@playwright/test');

test.describe('document upload source controls', () => {
  test('Customer exposes camera and gallery actions for both ID sides', async ({ page }) => {
    await page.goto('/customer');

    const front = page.locator('#r-cnic-front');
    const back = page.locator('#r-cnic-back');
    await expect(page.locator('.document-source-btn', { hasText: 'Take Photo' })).toHaveCount(2);
    await expect(page.locator('.document-source-btn', { hasText: 'Choose from Gallery' })).toHaveCount(2);

    await page.evaluate(() => openDocumentSource('r-cnic-front', 'camera'));
    await expect(front).toHaveAttribute('capture', 'environment');
    await page.evaluate(() => openDocumentSource('r-cnic-front', 'gallery'));
    await expect(front).not.toHaveAttribute('capture');

    await page.evaluate(() => openDocumentSource('r-cnic-back', 'camera'));
    await expect(back).toHaveAttribute('capture', 'environment');
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