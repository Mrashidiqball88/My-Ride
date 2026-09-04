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
      const records = [
        {
          _id: 'driver-1', name: 'Active Driver', phone: '+923001234567',
          vehicleType: 'Car Mini', accountStatus: 'active', createdAt: '2026-01-01T00:00:00Z'
        },
        {
          _id: 'driver-2', name: 'Pending Driver', phone: '+923001234568',
          vehicleType: 'Car Mini', accountStatus: 'pending', createdAt: '2026-01-02T00:00:00Z'
        }
      ];
      body = url.searchParams.get('includeCounts') === 'true'
        ? { records, counts: { all: 4, active: 2, pending: 1, suspended: 1, blocked: 0 } }
        : url.searchParams.get('status') === 'pending'
          ? records.filter(record => record.accountStatus === 'pending')
          : records;
    } else if (path === '/api/admin/passengers') {
      const records = [
        {
          _id: 'customer-1', name: 'Active Customer', phone: '+923001234569',
          accountStatus: 'active', createdAt: '2026-01-03T00:00:00Z'
        },
        {
          _id: 'customer-2', name: 'Blocked Customer', phone: '+923001234570',
          accountStatus: 'blocked', createdAt: '2026-01-04T00:00:00Z'
        }
      ];
      body = url.searchParams.get('includeCounts') === 'true'
        ? { records, counts: { all: 5, active: 3, pending: 0, suspended: 0, blocked: 2 } }
        : records;
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
      { username: 'proof-scope', password, permissions: permissionSet('viewPayments', 'viewPaymentProofs', 'approveWalletTopups') },
      { username: 'management-scope', password, permissions: permissionSet('viewDrivers', 'viewCustomers') }
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
    await expect(page.locator('#req-tbody button.btn-red')).toHaveCount(1);

    await page.locator('[data-sec="payments"]').click();
    await expect(page.locator('#pay-list')).toContainText('TRX-1');
    await expect(page.locator('#pay-list a', { hasText: 'View Proof' })).toHaveCount(0);
    await expect(page.locator('#pay-list button', { hasText: 'Approve' })).toHaveCount(0);
  });

  test('management filters show live state counts and serial numbers in both panels', async ({ page }) => {
    await stubAdminData(page);
    await login(page, 'management-scope');

    await page.locator('[data-sec="drivers"]').click();
    await expect(page.locator('#driver-count-all')).toHaveText('4');
    await expect(page.locator('#driver-count-active')).toHaveText('2');
    await expect(page.locator('#driver-count-pending')).toHaveText('1');
    await expect(page.locator('#driver-count-suspended')).toHaveText('1');
    await expect(page.locator('#driver-count-blocked')).toHaveText('0');
    await expect(page.locator('#drivers-tbody .table-serial')).toHaveText(['1', '2']);

    await page.locator('[data-sec="passengers"]').click();
    await expect(page.locator('#customer-count-all')).toHaveText('5');
    await expect(page.locator('#customer-count-active')).toHaveText('3');
    await expect(page.locator('#customer-count-pending')).toHaveText('0');
    await expect(page.locator('#customer-count-suspended')).toHaveText('0');
    await expect(page.locator('#customer-count-blocked')).toHaveText('2');
    await expect(page.locator('#pass-tbody .table-serial')).toHaveText(['1', '2']);
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

  test('Admin Logout is visible at the bottom of the sidebar and clears the session', async ({ page }) => {
    await stubAdminData(page);
    await login(page, 'ops-scope');

    const logout = page.getByRole('button', { name: /Logout from Admin panel/i });
    await expect(logout).toBeVisible();
    await expect(logout).toHaveText(/Logout/);
    await logout.click();

    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.locator('#auth-overlay')).toBeVisible();
    await expect(page.locator('#admin-app')).toBeHidden();
    await expect(await page.evaluate(() => ({
      adminToken: localStorage.getItem('admin_token'),
      adminEmail: localStorage.getItem('admin_email')
    }))).toEqual({ adminToken: null, adminEmail: null });
  });

  test('a stale saved Admin session returns to the login form', async ({ page }) => {
    await page.addInitScript(() => {
      if (!sessionStorage.getItem('stale-admin-session-test')) {
        sessionStorage.setItem('stale-admin-session-test', '1');
        localStorage.setItem('admin_token', 'stale-admin-token');
        localStorage.setItem('admin_email', 'stale-admin@example.test');
      }
    });
    await page.route('**/api/admin/session', async route => {
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Invalid or expired Admin session' })
      });
    });

    await page.goto(`${baseURL}/admin`);
    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.locator('#auth-overlay')).toBeVisible();
    await expect(page.locator('#admin-app')).toBeHidden();
    await expect(await page.evaluate(() => ({
      adminToken: localStorage.getItem('admin_token'),
      adminEmail: localStorage.getItem('admin_email')
    }))).toEqual({ adminToken: null, adminEmail: null });
  });

  test('the login and recovery forms load the live Admin email', async ({ page }) => {
    await page.route('**/api/admin/login-config', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ email: 'atlas-admin@example.test' })
      });
    });

    await page.goto(`${baseURL}/admin`);
    await expect(page.locator('#a-email')).toHaveValue('atlas-admin@example.test');
    await page.getByRole('button', { name: 'Forgot Password?' }).click();
    await expect(page.locator('#recovery-email')).toHaveValue('atlas-admin@example.test');
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