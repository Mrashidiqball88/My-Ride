# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: document-upload.spec.js >> Document upload flow — large photos (~1.7 MB each) >> upload overlay remains visible during transfer, then hides on success
- Location: tests/document-upload.spec.js:250:3

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
  214 |       await expect(overlay).toBeVisible({ timeout: 8_000 });
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
> 273 |       await expect(page.locator('#upload-progress-screen')).toBeVisible({ timeout: 8_000 });
      |                                                             ^ Error: expect(locator).toBeVisible() failed
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
  315 |       // addInitScript() runs the function in the page context on every
  316 |       // navigation, before any page scripts execute.
  317 |       await page.addInitScript(() => {
  318 |         const _realSend = XMLHttpRequest.prototype.send;
  319 |         XMLHttpRequest.prototype.send = function (body) {
  320 |           const upload = this.upload;
  321 |           // Measure the serialised body so progress ratios are realistic.
  322 |           const total = body ? new Blob([body]).size : 1;
  323 |           // Fire 5 synthetic progress events spread across 1.5 s.
  324 |           [0.2, 0.4, 0.6, 0.8, 0.95].forEach((ratio, i) => {
  325 |             setTimeout(() => {
  326 |               upload.dispatchEvent(
  327 |                 new ProgressEvent('progress', {
  328 |                   bubbles: false,
  329 |                   lengthComputable: true,
  330 |                   loaded: Math.floor(ratio * total),
  331 |                   total,
  332 |                 })
  333 |               );
  334 |             }, (i + 1) * 300); // 300 ms, 600 ms, 900 ms, 1 200 ms, 1 500 ms
  335 |           });
  336 |           _realSend.call(this, body);
  337 |         };
  338 |       });
  339 | 
  340 |       // ── 2. Register stub routes; hold the register response for 4 s ───
  341 |       await setupRoutes(page, 4_000);
  342 |       await page.goto('/driver');
  343 | 
  344 |       await fillStep1(page, { phone: '+923001234996' });
  345 |       await uploadPhotos(page);
  346 |       await page.locator('#reg-submit-btn').click();
  347 | 
  348 |       // ── Assert 1: upload-progress overlay appears ─────────────────────
  349 |       const overlay = page.locator('#upload-progress-screen');
  350 |       await expect(overlay).toBeVisible({ timeout: 10_000 });
  351 | 
  352 |       // ── Assert 2: progress bar advances past 0 % BEFORE upload ends ───
  353 |       // The first synthetic event fires at ~300 ms after send(); the route
  354 |       // mock holds the response for 4 s, so there is a clear window where
  355 |       // pct is in the range (0, 100).
  356 |       await page.waitForFunction(
  357 |         () => {
  358 |           const el = document.querySelector('#upload-progress-pct');
  359 |           if (!el) return false;
  360 |           const pct = parseInt(el.textContent, 10);
  361 |           return !isNaN(pct) && pct > 0 && pct < 100;
  362 |         },
  363 |         { timeout: 15_000 }
  364 |       );
  365 | 
  366 |       // Snapshot the mid-flight value — it must be strictly positive.
  367 |       const midPct = await page.locator('#upload-progress-pct').evaluate(
  368 |         (el) => parseInt(el.textContent, 10)
  369 |       );
  370 |       expect(midPct).toBeGreaterThan(0);
  371 | 
  372 |       // ── Assert 3: progress bar reaches 100 % once the response lands ──
  373 |       await expect(page.locator('#upload-progress-pct')).toHaveText('100%', {
```