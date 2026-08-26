# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: document-upload.spec.js >> Document upload flow — large photos (~1.7 MB each) >> keeps the wallet recharge amount editable and shows Daily Fee separately
- Location: tests/document-upload.spec.js:206:3

# Error details

```
Error: expect(locator).not.toHaveAttribute(expected) failed

Locator:  locator('#trx-amount-input')
Expected: not ""
Received: ""
Timeout:  5000ms

Call log:
  - Expect "not toHaveAttribute" with timeout 5000ms
  - waiting for locator('#trx-amount-input')
    14 × locator resolved to <input readonly min="0.01" step="0.01" type="number" class="trx-input" id="trx-amount-input" placeholder="Loading Daily Fee…"/>
       - unexpected value ""

```

```yaml
- img "My Ride Driver"
- text: My RideDRIVER
- paragraph: Driver Portal
- button "Sign In"
- button "Register"
- text: Phone or Email
- textbox "03001234567 or email"
- text: Password
- textbox "••••••••"
- button "👁"
- button "Sign In"
- button "Forgot Password?"
```

# Test source

```ts
  107 |   ].join('.'),
  108 |   sessionToken: 'fakesessiontoken1234567890abcdef',
  109 |   user: {
  110 |     id:            '660000000000000000000000',
  111 |     name:          'Test Driver',
  112 |     email:         '',
  113 |     phone:         '+923001234999',
  114 |     role:          'driver',
  115 |     accountStatus: 'pending',   // new drivers always start as pending
  116 |     vehicleType:   'Car Mini',
  117 |     vehicleModel:  'Suzuki Cultus 2020',
  118 |     vehiclePlate:  'LHR-9999',
  119 |     lastDailyFeePaidAt: null,
  120 |     dailyFeeAmount: 200,
  121 |   },
  122 | };
  123 | 
  124 | // ── Helpers ───────────────────────────────────────────────────────────────────
  125 | 
  126 | /**
  127 |  * Intercept the register API and silence unrelated boot-time requests.
  128 |  *
  129 |  * IMPORTANT: the socket.io *client JS file* must load so that `io` is defined
  130 |  * when connectSocket() runs inside bootApp().  Only socket.io connection/
  131 |  * polling requests are aborted.
  132 |  */
  133 | async function setupRoutes(page, delay = 250) {
  134 |   await page.route('**/api/auth/register', async (route) => {
  135 |     await new Promise((r) => setTimeout(r, delay));
  136 |     await route.fulfill({
  137 |       status: 201,
  138 |       contentType: 'application/json',
  139 |       body: JSON.stringify(MOCK_REGISTER_RESPONSE),
  140 |     });
  141 |   });
  142 | 
  143 |   // Allow the socket.io *script* to load; abort only connection requests.
  144 |   await page.route('**/socket.io/**', (route) => {
  145 |     if (route.request().url().endsWith('.js')) {
  146 |       route.continue();
  147 |     } else {
  148 |       route.abort();   // server will also reject the fake JWT on connect_error
  149 |     }
  150 |   });
  151 | 
  152 |   // Stub boot-time API calls so they resolve cleanly without touching the DB.
  153 |   await page.route('**/api/auth/me', (route) =>
  154 |     route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"unauthorized"}' })
  155 |   );
  156 |   await page.route('**/api/wallet**', (route) =>
  157 |     route.fulfill({ status: 200, contentType: 'application/json', body: '{"balance":0,"transactions":[]}' })
  158 |   );
  159 |   await page.route('**/api/rides/my**', (route) =>
  160 |     route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
  161 |   );
  162 |   await page.route('**/api/settings/payment**', (route) =>
  163 |     route.fulfill({ status: 200, contentType: 'application/json', body: '{"accounts":{}}' })
  164 |   );
  165 |   await page.route('**/api/support/**', (route) =>
  166 |     route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
  167 |   );
  168 | }
  169 | 
  170 | /** Fill Step 1 of the registration form and advance to Step 2. */
  171 | async function fillStep1(page, { phone = '+923001234999' } = {}) {
  172 |   await page.getByRole('button', { name: 'Register' }).click();
  173 |   await expect(page.locator('#register-form')).toBeVisible();
  174 | 
  175 |   await page.locator('#r-name').fill('Test Driver');
  176 |   await page.locator('#r-phone').fill(phone);
  177 |   await page.locator('#r-email').fill(`driver-${phone.replace(/\D/g, '')}@example.test`);
  178 |   await page.locator('#r-pass').fill('password123');
  179 |   await page.locator('#r-vehicle').selectOption('Car Mini');
  180 |   await page.locator('#r-vehicle-model').fill('Suzuki Cultus 2020');
  181 |   await page.locator('#r-plate').fill('LHR-9999');
  182 | 
  183 |   await page.getByRole('button', { name: /Continue.*Upload Documents/i }).click();
  184 |   await expect(page.locator('#reg-step2')).toBeVisible();
  185 | }
  186 | 
  187 | /** Attach the required driver documents to the file inputs. */
  188 | async function uploadPhotos(page) {
  189 |   await page.locator('#r-profile-photo').setInputFiles(FIXTURES.profile);
  190 |   await page.locator('#r-license-photo').setInputFiles(FIXTURES.license);
  191 |   await page.locator('#r-cnic-front').setInputFiles(FIXTURES.cnicFront);
  192 |   await page.locator('#r-cnic-back').setInputFiles(FIXTURES.cnicBack);
  193 |   // The fixture set predates the vehicle-registration field. Reuse the
  194 |   // license image; this test exercises upload orchestration, not document OCR.
  195 |   await page.locator('#r-vehicle-reg').setInputFiles(FIXTURES.license);
  196 | }
  197 | 
  198 | // ── Tests ─────────────────────────────────────────────────────────────────────
  199 | 
  200 | test.describe('Document upload flow — large photos (~1.7 MB each)', () => {
  201 |   test.beforeEach(async ({ page }) => {
  202 |     await setupRoutes(page);
  203 |     await page.goto('/driver');
  204 |   });
  205 | 
  206 |   test('keeps the wallet recharge amount editable and shows Daily Fee separately', async ({ page }) => {
> 207 |     await expect(page.locator('#trx-amount-input')).not.toHaveAttribute('readonly', '');
      |                                                         ^ Error: expect(locator).not.toHaveAttribute(expected) failed
  208 |     await expect(page.locator('#trx-amount-input')).toHaveAttribute('placeholder', 'Enter amount to add to wallet');
  209 |     await expect(page.locator('#fee-rate-text')).toContainText('Daily Fee');
  210 |   });
  211 | 
  212 |   // ---------------------------------------------------------------------------
  213 |   test(
  214 |     'upload progress overlay appears, reaches 100 %, hides, and driver app loads',
  215 |     async ({ page }) => {
  216 |       await fillStep1(page);
  217 |       await uploadPhotos(page);
  218 | 
  219 |       // ── Submit ──────────────────────────────────────────────────────────
  220 |       await page.locator('#reg-submit-btn').click();
  221 | 
  222 |       // ── Assert 1: upload-progress overlay becomes visible ───────────────
  223 |       const overlay = page.locator('#upload-progress-screen');
  224 |       await expect(overlay).toBeVisible({ timeout: 8_000 });
  225 | 
  226 |       // ── Assert 2: progress bar reaches 100 % ────────────────────────────
  227 |       // xhr.onload sets the bar to 100 % on a 2xx response.
  228 |       await expect(page.locator('#upload-progress-pct')).toHaveText('100%', { timeout: 15_000 });
  229 | 
  230 |       const barWidth = await page.locator('#upload-progress-bar').evaluate(
  231 |         (el) => el.style.width
  232 |       );
  233 |       expect(barWidth).toBe('100%');
  234 | 
  235 |       // ── Assert 3: overlay hides after the 600 ms post-success delay ─────
  236 |       await expect(overlay).toBeHidden({ timeout: 5_000 });
  237 | 
  238 |       // ── Assert 4: auth screen is gone, driver app is now the active view ─
  239 |       await expect(page.locator('#auth-screen')).toBeHidden({ timeout: 3_000 });
  240 |       await expect(page.locator('#app')).toBeVisible({ timeout: 3_000 });
  241 | 
  242 |       // ── Assert 5: pending-approval card is rendered ──────────────────────
  243 |       // bootApp() sets #pending-card display:block synchronously when
  244 |       // user.accountStatus === 'pending'.  The daily-fee modal (position:fixed,
  245 |       // z-index:3000) may visually cover it, so we check computed style rather
  246 |       // than Playwright's full visibility check.
  247 |       const pendingCardDisplay = await page.locator('#pending-card').evaluate(
  248 |         (el) => window.getComputedStyle(el).display
  249 |       );
  250 |       expect(pendingCardDisplay).not.toBe('none');
  251 | 
  252 |       const pendingCardTitle = await page.locator('.pending-card-title').evaluate(
  253 |         (el) => el.textContent
  254 |       );
  255 |       expect(pendingCardTitle).toContain('Documents Under Admin Review');
  256 |     }
  257 |   );
  258 | 
  259 |   // ---------------------------------------------------------------------------
  260 |   test(
  261 |     'changing vehicle requires a replacement document and immediately shows pending review',
  262 |     async ({ page }) => {
  263 |       let submittedBody;
  264 |       await page.route('**/api/user/update-profile', async (route) => {
  265 |         submittedBody = route.request().postDataJSON();
  266 |         await route.fulfill({
  267 |           status: 200,
  268 |           contentType: 'application/json',
  269 |           body: JSON.stringify({
  270 |             message: 'Vehicle details and document submitted for Admin review. You are offline until approval.',
  271 |             user: {
  272 |               ...MOCK_REGISTER_RESPONSE.user,
  273 |               vehicleModel: 'Toyota Yaris 2024',
  274 |               vehiclePlate: 'LHR-2024',
  275 |               accountStatus: 'pending',
  276 |               identityVerificationStatus: 'pending',
  277 |               isOnline: false,
  278 |               longRangeEnabled: false,
  279 |             },
  280 |           }),
  281 |         });
  282 |       });
  283 | 
  284 |       await page.evaluate((session) => window.saveSession(session), {
  285 |         ...MOCK_REGISTER_RESPONSE,
  286 |         user: { ...MOCK_REGISTER_RESPONSE.user, accountStatus: 'active' },
  287 |       });
  288 |       await expect(page.locator('#app')).toBeVisible();
  289 | 
  290 |       await page.evaluate(() => window.openChangeVehicleModal());
  291 |       await page.locator('#cv-current').fill('password123');
  292 |       await page.locator('#cv-model').fill('Toyota Yaris 2024');
  293 |       await page.locator('#cv-plate').fill('lhr-2024');
  294 |       await page.locator('#cv-btn').click();
  295 |       await expect(page.locator('#cv-err')).toContainText(/Upload the new vehicle registration/i);
  296 | 
  297 |       await page.locator('#cv-vehicle-reg').setInputFiles(FIXTURES.license);
  298 |       await page.locator('#cv-type').selectOption('Toyota Highroof');
  299 |       await page.locator('#cv-btn').click();
  300 |       await expect.poll(() => submittedBody).toBeTruthy();
  301 |       expect(submittedBody.vehicleModel).toBe('Toyota Yaris 2024');
  302 |       expect(submittedBody.vehiclePlate).toBe('LHR-2024');
  303 |       expect(submittedBody.vehicleType).toBe('Toyota Highroof');
  304 |       expect(submittedBody.vehicleRegPhoto).toMatch(/^data:image\/jpeg;base64,/);
  305 |       await expect(page.locator('#change-vehicle-modal')).toBeHidden();
  306 | 
  307 |       const renderedState = await page.evaluate(() => ({
```