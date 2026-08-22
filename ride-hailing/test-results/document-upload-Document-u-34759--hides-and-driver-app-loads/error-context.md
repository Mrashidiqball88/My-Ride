# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: document-upload.spec.js >> Document upload flow — large photos (~1.7 MB each) >> upload progress overlay appears, reaches 100 %, hides, and driver app loads
- Location: tests/document-upload.spec.js:203:3

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator:  locator('#upload-progress-screen')
Expected: visible
Received: hidden
Timeout:  8000ms

Call log:
  - Expect "toBeVisible" with timeout 8000ms
  - waiting for locator('#upload-progress-screen')
    20 × locator resolved to <div id="upload-progress-screen">…</div>
       - unexpected value "hidden"

```

```yaml
- img "My Ride Driver"
- text: My RideDRIVER
- paragraph: Driver Portal
- button "Sign In"
- button "Register"
- text: ✓ 2
- paragraph: Step 2 of 2 — Required Documents
- text: Profile Photo *
- img
- button "Choose File"
- text: Driving License (Front) *
- img
- button "Choose File"
- text: CNIC Front *
- img
- button "Choose File"
- text: CNIC Back *
- img
- button "Choose File"
- text: Vehicle Registration Book / Documents *
- button "Choose File"
- button "← Back"
- button "Create Driver Account"
- text: Vehicle registration document is required
```

# Test source

```ts
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
  177 |   await page.locator('#r-pass').fill('password123');
  178 |   await page.locator('#r-vehicle').selectOption('Car Mini');
  179 |   await page.locator('#r-vehicle-model').fill('Suzuki Cultus 2020');
  180 |   await page.locator('#r-plate').fill('LHR-9999');
  181 | 
  182 |   await page.getByRole('button', { name: /Continue.*Upload Documents/i }).click();
  183 |   await expect(page.locator('#reg-step2')).toBeVisible();
  184 | }
  185 | 
  186 | /** Attach the four large test-fixture photos to the file inputs. */
  187 | async function uploadPhotos(page) {
  188 |   await page.locator('#r-profile-photo').setInputFiles(FIXTURES.profile);
  189 |   await page.locator('#r-license-photo').setInputFiles(FIXTURES.license);
  190 |   await page.locator('#r-cnic-front').setInputFiles(FIXTURES.cnicFront);
  191 |   await page.locator('#r-cnic-back').setInputFiles(FIXTURES.cnicBack);
  192 | }
  193 | 
  194 | // ── Tests ─────────────────────────────────────────────────────────────────────
  195 | 
  196 | test.describe('Document upload flow — large photos (~1.7 MB each)', () => {
  197 |   test.beforeEach(async ({ page }) => {
  198 |     await setupRoutes(page);
  199 |     await page.goto('/driver');
  200 |   });
  201 | 
  202 |   // ---------------------------------------------------------------------------
  203 |   test(
  204 |     'upload progress overlay appears, reaches 100 %, hides, and driver app loads',
  205 |     async ({ page }) => {
  206 |       await fillStep1(page);
  207 |       await uploadPhotos(page);
  208 | 
  209 |       // ── Submit ──────────────────────────────────────────────────────────
  210 |       await page.locator('#reg-submit-btn').click();
  211 | 
  212 |       // ── Assert 1: upload-progress overlay becomes visible ───────────────
  213 |       const overlay = page.locator('#upload-progress-screen');
> 214 |       await expect(overlay).toBeVisible({ timeout: 8_000 });
      |                             ^ Error: expect(locator).toBeVisible() failed
  215 | 
  216 |       // ── Assert 2: progress bar reaches 100 % ────────────────────────────
  217 |       // xhr.onload sets the bar to 100 % on a 2xx response.
  218 |       await expect(page.locator('#upload-progress-pct')).toHaveText('100%', { timeout: 15_000 });
  219 | 
  220 |       const barWidth = await page.locator('#upload-progress-bar').evaluate(
  221 |         (el) => el.style.width
  222 |       );
  223 |       expect(barWidth).toBe('100%');
  224 | 
  225 |       // ── Assert 3: overlay hides after the 600 ms post-success delay ─────
  226 |       await expect(overlay).toBeHidden({ timeout: 5_000 });
  227 | 
  228 |       // ── Assert 4: auth screen is gone, driver app is now the active view ─
  229 |       await expect(page.locator('#auth-screen')).toBeHidden({ timeout: 3_000 });
  230 |       await expect(page.locator('#app')).toBeVisible({ timeout: 3_000 });
  231 | 
  232 |       // ── Assert 5: pending-approval card is rendered ──────────────────────
  233 |       // bootApp() sets #pending-card display:block synchronously when
  234 |       // user.accountStatus === 'pending'.  The daily-fee modal (position:fixed,
  235 |       // z-index:3000) may visually cover it, so we check computed style rather
  236 |       // than Playwright's full visibility check.
  237 |       const pendingCardDisplay = await page.locator('#pending-card').evaluate(
  238 |         (el) => window.getComputedStyle(el).display
  239 |       );
  240 |       expect(pendingCardDisplay).not.toBe('none');
  241 | 
  242 |       const pendingCardTitle = await page.locator('.pending-card-title').evaluate(
  243 |         (el) => el.textContent
  244 |       );
  245 |       expect(pendingCardTitle).toContain('Documents Under Admin Review');
  246 |     }
  247 |   );
  248 | 
  249 |   // ---------------------------------------------------------------------------
  250 |   test(
  251 |     'upload overlay remains visible during transfer, then hides on success',
  252 |     async ({ page }) => {
  253 |       // Use a longer hold so we can assert the in-flight state explicitly.
  254 |       await page.unroute('**/api/auth/register');
  255 |       await page.route('**/api/auth/register', async (route) => {
  256 |         await new Promise((r) => setTimeout(r, 1_500));   // 1.5 s hold
  257 |         await route.fulfill({
  258 |           status: 201,
  259 |           contentType: 'application/json',
  260 |           body: JSON.stringify({
  261 |             ...MOCK_REGISTER_RESPONSE,
  262 |             user: { ...MOCK_REGISTER_RESPONSE.user, phone: '+923001234998' },
  263 |           }),
  264 |         });
  265 |       });
  266 | 
  267 |       await fillStep1(page, { phone: '+923001234998' });
  268 |       await uploadPhotos(page);
  269 |       await page.locator('#reg-submit-btn').click();
  270 | 
  271 |       // Overlay must appear immediately (showUploadProgress() is synchronous
  272 |       // inside doRegister(), called before the XHR is even sent).
  273 |       await expect(page.locator('#upload-progress-screen')).toBeVisible({ timeout: 8_000 });
  274 | 
  275 |       // After the 1.5 s server delay + 600 ms post-success timeout, it hides.
  276 |       await expect(page.locator('#upload-progress-screen')).toBeHidden({ timeout: 15_000 });
  277 | 
  278 |       // Driver app is the active screen.
  279 |       await expect(page.locator('#auth-screen')).toBeHidden();
  280 |       await expect(page.locator('#app')).toBeVisible();
  281 | 
  282 |       // pending-approval card is rendered in the DOM.
  283 |       const pendingCardDisplay = await page.locator('#pending-card').evaluate(
  284 |         (el) => window.getComputedStyle(el).display
  285 |       );
  286 |       expect(pendingCardDisplay).not.toBe('none');
  287 |     }
  288 |   );
  289 | });
  290 | 
  291 | // ── Slow-network tests ────────────────────────────────────────────────────────
  292 | 
  293 | test.describe('Upload progress UI — progress bar advances and overlay hides correctly', () => {
  294 |   /**
  295 |    * Verifies the client-side progress bar DOM behaviour when upload.progress
  296 |    * events fire mid-flight.
  297 |    *
  298 |    * Background: CDP Network.emulateNetworkConditions throttles at the real
  299 |    * socket layer, but Playwright's page.route() intercepts requests before they
  300 |    * reach the network socket — so xhr.upload.progress never fires naturally for
  301 |    * mocked routes.  To exercise the UI handler in isolation we monkey-patch
  302 |    * XMLHttpRequest.prototype.send to dispatch five synthetic ProgressEvents
  303 |    * (20 %, 40 %, 60 %, 80 %, 95 % of the real body size) spread over 1.5 s.
  304 |    * The route mock holds for 4 s, so these events land before xhr.onload fires.
  305 |    *
  306 |    * This test covers client UI behaviour only.  For server-side slow-upload
  307 |    * reliability see the "Slow-socket upload" suite below.
  308 |    */
  309 |   test(
  310 |     'synthetic upload events advance the progress bar from 0 % to 100 %',
  311 |     async ({ page }) => {
  312 |       test.setTimeout(60_000);
  313 | 
  314 |       // ── 1. Inject the XHR shim BEFORE page load ───────────────────────
```