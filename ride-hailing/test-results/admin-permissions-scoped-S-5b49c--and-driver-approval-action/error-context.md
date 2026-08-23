# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: admin-permissions.spec.js >> scoped Sub-Admin browser permissions >> operations role sees only its sections and driver approval action
- Location: tests/admin-permissions.spec.js:87:3

# Error details

```
Error: expect(locator).toHaveCount(expected) failed

Locator:  locator('#req-tbody button.btn-red')
Expected: 0
Received: 1
Timeout:  5000ms

Call log:
  - Expect "toHaveCount" with timeout 5000ms
  - waiting for locator('#req-tbody button.btn-red')
    14 × locator resolved to 1 element
       - unexpected value "1"

```

# Test source

```ts
  1   | // @ts-check
  2   | 'use strict';
  3   | 
  4   | const { test, expect } = require('@playwright/test');
  5   | const bcrypt = require('bcryptjs');
  6   | const mongoose = require('mongoose');
  7   | const { MongoMemoryServer } = require('mongodb-memory-server');
  8   | 
  9   | const service = require('../server');
  10  | const { server, models } = service;
  11  | 
  12  | const PASSWORD = 'scoped-admin-password';
  13  | let baseURL;
  14  | 
  15  | function permissionSet(...keys) {
  16  |   return Object.fromEntries(keys.map(key => [key, true]));
  17  | }
  18  | 
  19  | async function login(page, username) {
  20  |   await page.goto(`${baseURL}/admin`);
  21  |   await page.getByRole('button', { name: 'Sub-Admin', exact: true }).click();
  22  |   await page.locator('#sa-username').fill(username);
  23  |   await page.locator('#sa-pass').fill(PASSWORD);
  24  |   await page.getByRole('button', { name: 'Sign In as Sub-Admin' }).click();
  25  |   await expect(page.locator('#admin-app')).toBeVisible();
  26  |   await expect(page.locator('#auth-overlay')).toBeHidden();
  27  |   await page.waitForFunction(() => document.querySelector('#admin-email-lbl')?.textContent?.includes('sub-admin'));
  28  | }
  29  | 
  30  | function display(page, selector) {
  31  |   return page.locator(selector).evaluate(el => getComputedStyle(el).display);
  32  | }
  33  | 
  34  | async function stubAdminData(page) {
  35  |   await page.route('**/api/admin/**', async route => {
  36  |     const url = new URL(route.request().url());
  37  |     const path = url.pathname;
  38  |     if (path === '/api/admin/sub-user/login' || path === '/api/admin/session') {
  39  |       await route.continue();
  40  |       return;
  41  |     }
  42  |     let body = [];
  43  |     if (path === '/api/admin/stats') body = {};
  44  |     else if (path === '/api/admin/drivers') {
  45  |       body = [{
  46  |         _id: 'driver-1', name: 'Pending Driver', phone: '+923001234567',
  47  |         vehicleType: 'Car Mini', accountStatus: 'pending', createdAt: '2026-01-01T00:00:00Z'
  48  |       }];
  49  |     } else if (path === '/api/admin/payments') {
  50  |       body = [{
  51  |         _id: 'payment-1', driver: { name: 'Driver One', phone: '+923001234567' },
  52  |         amount: 500, trxId: 'TRX-1', paymentType: 'jazzcash', status: 'pending',
  53  |         proofScreenshot: 'data:image/png;base64,proof', createdAt: '2026-01-01T00:00:00Z'
  54  |       }];
  55  |     } else if (path === '/api/admin/settings' || path === '/api/admin/ride-settings' ||
  56  |                path === '/api/admin/fare-settings' || path === '/api/admin/per-km-rates' ||
  57  |                path === '/api/admin/daily-fee-settings') {
  58  |       body = {};
  59  |     }
  60  |     await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  61  |   });
  62  | }
  63  | 
  64  | test.describe('scoped Sub-Admin browser permissions', () => {
  65  |   /** @type {MongoMemoryServer} */
  66  |   let mongo;
  67  | 
  68  |   test.beforeAll(async () => {
  69  |     mongo = await MongoMemoryServer.create();
  70  |     await mongoose.connect(mongo.getUri());
  71  |     const password = await bcrypt.hash(PASSWORD, 4);
  72  |     await models.SubAdmin.create([
  73  |       { username: 'ops-scope', password, permissions: permissionSet('viewOverview', 'viewDrivers', 'manageDriverApprovals', 'viewPayments') },
  74  |       { username: 'config-scope', password, permissions: permissionSet('manageRideSettings', 'manageFareSettings') },
  75  |       { username: 'proof-scope', password, permissions: permissionSet('viewPayments', 'viewPaymentProofs', 'approveWalletTopups') }
  76  |     ]);
  77  |     await new Promise(resolve => server.listen(0, resolve));
  78  |     baseURL = `http://127.0.0.1:${server.address().port}`;
  79  |   });
  80  | 
  81  |   test.afterAll(async () => {
  82  |     await new Promise(resolve => server.close(resolve));
  83  |     await mongoose.disconnect();
  84  |     await mongo.stop();
  85  |   });
  86  | 
  87  |   test('operations role sees only its sections and driver approval action', async ({ page }) => {
  88  |     await stubAdminData(page);
  89  |     await login(page, 'ops-scope');
  90  | 
  91  |     await expect(page.locator('[data-sec="overview"]')).toBeVisible();
  92  |     await expect(page.locator('[data-sec="drivers"]')).toBeVisible();
  93  |     await expect(page.locator('[data-sec="payments"]')).toBeVisible();
  94  |     await expect(page.locator('[data-sec="app-settings"]')).toBeHidden();
  95  |     await expect(page.locator('[data-sec="new-requests"]')).toBeVisible();
  96  | 
  97  |     await page.locator('[data-sec="new-requests"]').click();
  98  |     await expect(page.locator('#req-tbody')).toContainText('Pending Driver');
  99  |     await expect(page.locator('#req-tbody button.btn-green')).toHaveCount(1);
> 100 |     await expect(page.locator('#req-tbody button.btn-red')).toHaveCount(0);
      |                                                             ^ Error: expect(locator).toHaveCount(expected) failed
  101 | 
  102 |     await page.locator('[data-sec="payments"]').click();
  103 |     await expect(page.locator('#pay-list')).toContainText('TRX-1');
  104 |     await expect(page.locator('#pay-list a', { hasText: 'View Proof' })).toHaveCount(0);
  105 |     await expect(page.locator('#pay-list button', { hasText: 'Approve' })).toHaveCount(0);
  106 |   });
  107 | 
  108 |   test('configuration role sees only granted settings cards', async ({ page }) => {
  109 |     await stubAdminData(page);
  110 |     await login(page, 'config-scope');
  111 | 
  112 |     await expect(page.locator('[data-sec="app-settings"]')).toBeVisible();
  113 |     await page.locator('[data-sec="app-settings"]').click({ force: true });
  114 |     await expect(page.locator('#sec-app-settings')).toBeVisible();
  115 |     await expect(page.locator('#ride-settings-card')).toBeVisible();
  116 |     await expect(page.locator('#fare-settings-card')).toBeVisible();
  117 |     await expect(page.locator('#driver-fees-card')).toBeHidden();
  118 |     await expect(page.locator('#payment-settings-card')).toBeHidden();
  119 |     await expect(page.locator('[data-sec="drivers"]')).toBeHidden();
  120 |   });
  121 | 
  122 |   test('proof and approval permissions expose payment actions, and edits apply after refresh', async ({ page }) => {
  123 |     await stubAdminData(page);
  124 |     await login(page, 'proof-scope');
  125 |     await page.locator('[data-sec="payments"]').click({ force: true });
  126 |     await expect(page.locator('#pay-list a', { hasText: 'View Proof' })).toHaveCount(1);
  127 |     await expect(page.locator('#pay-list button', { hasText: 'Approve' })).toHaveCount(1);
  128 | 
  129 |     await models.SubAdmin.updateOne({ username: 'proof-scope' }, {
  130 |       $set: { permissions: permissionSet('viewPayments') }
  131 |     });
  132 |     await page.reload();
  133 |     await expect(page.locator('#admin-app')).toBeVisible();
  134 |     await page.locator('[data-sec="payments"]').click({ force: true });
  135 |     await expect(page.locator('#pay-list')).toContainText('TRX-1');
  136 |     await expect(page.locator('#pay-list a', { hasText: 'View Proof' })).toHaveCount(0);
  137 |     await expect(page.locator('#pay-list button', { hasText: 'Approve' })).toHaveCount(0);
  138 |   });
  139 | 
  140 |   test('restricted deep links stay on an allowed screen without loading restricted data', async ({ page }) => {
  141 |     const restrictedRequests = [];
  142 |     await page.route('**/api/admin/**', async route => {
  143 |       const path = new URL(route.request().url()).pathname;
  144 |       if (path === '/api/admin/audit-logs' || path === '/api/admin/fare-settings') {
  145 |         restrictedRequests.push(path);
  146 |       }
  147 |       await route.continue();
  148 |     });
  149 |     await stubAdminData(page);
  150 | 
  151 |     await page.goto(`${baseURL}/admin#audit-logs`);
  152 |     await page.getByRole('button', { name: 'Sub-Admin', exact: true }).click();
  153 |     await page.locator('#sa-username').fill('ops-scope');
  154 |     await page.locator('#sa-pass').fill(PASSWORD);
  155 |     await page.getByRole('button', { name: 'Sign In as Sub-Admin' }).click();
  156 |     await expect(page.locator('#admin-app')).toBeVisible();
  157 |     await expect(page.locator('#sec-overview')).toHaveClass(/active/);
  158 |     await expect(page.locator('#section-title')).toHaveText('Overview Dashboard');
  159 |     await expect(page).toHaveURL(/\/admin$/);
  160 |     await expect.poll(() => restrictedRequests).toEqual([]);
  161 | 
  162 |     await page.goto(`${baseURL}/admin#fare-settings`);
  163 |     await expect(page.locator('#admin-app')).toBeVisible();
  164 |     await expect(page.locator('#sec-overview')).toHaveClass(/active/);
  165 |     await expect(page.locator('#section-title')).toHaveText('Overview Dashboard');
  166 |     await expect(page).toHaveURL(/\/admin$/);
  167 |     await expect.poll(() => restrictedRequests).toEqual([]);
  168 |   });
  169 | });
```