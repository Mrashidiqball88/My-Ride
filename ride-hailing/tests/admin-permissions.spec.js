// @ts-check
'use strict';

const { test, expect } = require('@playwright/test');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const service = require('../server');
const { server, models } = service;

const PASSWORD = 'scoped-admin-password';
let baseURL;

function permissionSet(...keys) {
  return Object.fromEntries(keys.map(key => [key, true]));
}

async function login(page, username) {
  await page.goto(`${baseURL}/admin`);
  await page.getByRole('button', { name: 'Sub-Admin', exact: true }).click();
  await page.locator('#sa-username').fill(username);
  await page.locator('#sa-pass').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign In as Sub-Admin' }).click();
  await expect(page.locator('#admin-app')).toBeVisible();
  await expect(page.locator('#auth-overlay')).toBeHidden();
  await page.waitForFunction(() => document.querySelector('#admin-email-lbl')?.textContent?.includes('sub-admin'));
}

function display(page, selector) {
  return page.locator(selector).evaluate(el => getComputedStyle(el).display);
}

async function stubAdminData(page) {
  await page.route('**/api/admin/**', async route => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === '/api/admin/sub-user/login' || path === '/api/admin/session') {
      await route.continue();
      return;
    }
    let body = [];
    if (path === '/api/admin/stats') body = {};
    else if (path === '/api/admin/drivers') {
      body = [{
        _id: 'driver-1', name: 'Pending Driver', phone: '+923001234567',
        vehicleType: 'Car Mini', accountStatus: 'pending', createdAt: '2026-01-01T00:00:00Z'
      }];
    } else if (path === '/api/admin/payments') {
      body = [{
        _id: 'payment-1', driver: { name: 'Driver One', phone: '+923001234567' },
        amount: 500, trxId: 'TRX-1', paymentType: 'jazzcash', status: 'pending',
        proofScreenshot: 'data:image/png;base64,proof', createdAt: '2026-01-01T00:00:00Z'
      }];
    } else if (path === '/api/admin/settings' || path === '/api/admin/ride-settings' ||
               path === '/api/admin/fare-settings' || path === '/api/admin/per-km-rates' ||
               path === '/api/admin/daily-fee-settings') {
      body = {};
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
}

test.describe('scoped Sub-Admin browser permissions', () => {
  /** @type {MongoMemoryServer} */
  let mongo;

  test.beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    const password = await bcrypt.hash(PASSWORD, 4);
    await models.SubAdmin.create([
      { username: 'ops-scope', password, permissions: permissionSet('viewOverview', 'viewDrivers', 'manageDriverApprovals', 'viewPayments') },
      { username: 'config-scope', password, permissions: permissionSet('manageRideSettings', 'manageFareSettings') },
      { username: 'proof-scope', password, permissions: permissionSet('viewPayments', 'viewPaymentProofs', 'approveWalletTopups') }
    ]);
    await new Promise(resolve => server.listen(0, resolve));
    baseURL = `http://127.0.0.1:${server.address().port}`;
  });

  test.afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
    await mongoose.disconnect();
    await mongo.stop();
  });

  test('operations role sees only its sections and driver approval action', async ({ page }) => {
    await stubAdminData(page);
    await login(page, 'ops-scope');

    await expect(page.locator('[data-sec="overview"]')).toBeVisible();
    await expect(page.locator('[data-sec="drivers"]')).toBeVisible();
    await expect(page.locator('[data-sec="payments"]')).toBeVisible();
    await expect(page.locator('[data-sec="app-settings"]')).toBeHidden();
    await expect(page.locator('[data-sec="new-requests"]')).toBeVisible();

    await page.locator('[data-sec="new-requests"]').click();
    await expect(page.locator('#req-tbody')).toContainText('Pending Driver');
    await expect(page.locator('#req-tbody button.btn-green')).toHaveCount(1);
    await expect(page.locator('#req-tbody button.btn-red')).toHaveCount(0);

    await page.locator('[data-sec="payments"]').click();
    await expect(page.locator('#pay-list')).toContainText('TRX-1');
    await expect(page.locator('#pay-list a', { hasText: 'View Proof' })).toHaveCount(0);
    await expect(page.locator('#pay-list button', { hasText: 'Approve' })).toHaveCount(0);
  });

  test('configuration role sees only granted settings cards', async ({ page }) => {
    await stubAdminData(page);
    await login(page, 'config-scope');

    await expect(page.locator('[data-sec="app-settings"]')).toBeVisible();
    await page.locator('[data-sec="app-settings"]').click({ force: true });
    await expect(page.locator('#sec-app-settings')).toBeVisible();
    await expect(page.locator('#ride-settings-card')).toBeVisible();
    await expect(page.locator('#fare-settings-card')).toBeVisible();
    await expect(page.locator('#driver-fees-card')).toBeHidden();
    await expect(page.locator('#payment-settings-card')).toBeHidden();
    await expect(page.locator('[data-sec="drivers"]')).toBeHidden();
  });

  test('proof and approval permissions expose payment actions, and edits apply after refresh', async ({ page }) => {
    await stubAdminData(page);
    await login(page, 'proof-scope');
    await page.locator('[data-sec="payments"]').click({ force: true });
    await expect(page.locator('#pay-list a', { hasText: 'View Proof' })).toHaveCount(1);
    await expect(page.locator('#pay-list button', { hasText: 'Approve' })).toHaveCount(1);

    await models.SubAdmin.updateOne({ username: 'proof-scope' }, {
      $set: { permissions: permissionSet('viewPayments') }
    });
    await page.reload();
    await expect(page.locator('#admin-app')).toBeVisible();
    await page.locator('[data-sec="payments"]').click({ force: true });
    await expect(page.locator('#pay-list')).toContainText('TRX-1');
    await expect(page.locator('#pay-list a', { hasText: 'View Proof' })).toHaveCount(0);
    await expect(page.locator('#pay-list button', { hasText: 'Approve' })).toHaveCount(0);
  });

  test('restricted deep links stay on an allowed screen without loading restricted data', async ({ page }) => {
    const restrictedRequests = [];
    await page.route('**/api/admin/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/admin/audit-logs' || path === '/api/admin/fare-settings') {
        restrictedRequests.push(path);
      }
      await route.continue();
    });
    await stubAdminData(page);

    await page.goto(`${baseURL}/admin#audit-logs`);
    await page.getByRole('button', { name: 'Sub-Admin', exact: true }).click();
    await page.locator('#sa-username').fill('ops-scope');
    await page.locator('#sa-pass').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign In as Sub-Admin' }).click();
    await expect(page.locator('#admin-app')).toBeVisible();
    await expect(page.locator('#sec-overview')).toHaveClass(/active/);
    await expect(page.locator('#section-title')).toHaveText('Overview Dashboard');
    await expect(page).toHaveURL(/\/admin$/);
    await expect.poll(() => restrictedRequests).toEqual([]);

    await page.goto(`${baseURL}/admin#fare-settings`);
    await expect(page.locator('#admin-app')).toBeVisible();
    await expect(page.locator('#sec-overview')).toHaveClass(/active/);
    await expect(page.locator('#section-title')).toHaveText('Overview Dashboard');
    await expect(page).toHaveURL(/\/admin$/);
    await expect.poll(() => restrictedRequests).toEqual([]);
  });
});