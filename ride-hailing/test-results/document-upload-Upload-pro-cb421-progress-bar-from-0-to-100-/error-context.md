# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: document-upload.spec.js >> Upload progress UI — progress bar advances and overlay hides correctly >> synthetic upload events advance the progress bar from 0 % to 100 %
- Location: tests/document-upload.spec.js:309:3

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator:  locator('#upload-progress-screen')
Expected: visible
Received: hidden
Timeout:  10000ms

Call log:
  - Expect "toBeVisible" with timeout 10000ms
  - waiting for locator('#upload-progress-screen')
    24 × locator resolved to <div id="upload-progress-screen">…</div>
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
> 350 |       await expect(overlay).toBeVisible({ timeout: 10_000 });
      |                             ^ Error: expect(locator).toBeVisible() failed
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
  374 |         timeout: 15_000,
  375 |       });
  376 |       expect(
  377 |         await page.locator('#upload-progress-bar').evaluate(
  378 |           (el) => el.style.width
  379 |         )
  380 |       ).toBe('100%');
  381 | 
  382 |       // ── Assert 4: overlay hides after the 600 ms post-success delay ───
  383 |       await expect(overlay).toBeHidden({ timeout: 5_000 });
  384 | 
  385 |       // ── Assert 5: driver app is the active screen ─────────────────────
  386 |       await expect(page.locator('#auth-screen')).toBeHidden({ timeout: 5_000 });
  387 |       await expect(page.locator('#app')).toBeVisible({ timeout: 5_000 });
  388 | 
  389 |       // ── Assert 6: pending-approval card is rendered in the DOM ────────
  390 |       const pendingCardDisplay = await page.locator('#pending-card').evaluate(
  391 |         (el) => window.getComputedStyle(el).display
  392 |       );
  393 |       expect(pendingCardDisplay).not.toBe('none');
  394 |     }
  395 |   );
  396 | });
  397 | 
  398 | // ── Slow-socket integration tests ─────────────────────────────────────────────
  399 | 
  400 | /**
  401 |  * Shared JSON body for the slow-socket tests.
  402 |  * Mirrors a real doRegister() payload: four 25 000-char base64 image fields
  403 |  * ≈ four ~18 KB compressed photos ≈ ~100 KB total.
  404 |  */
  405 | const SLOW_UPLOAD_BODY = JSON.stringify({
  406 |   name:         'Slow Upload Driver',
  407 |   phone:        '+923009999000',
  408 |   password:     'password123',
  409 |   role:         'driver',
  410 |   vehicleType:  'Car Mini',
  411 |   vehicleModel: 'Toyota Corolla 2022',
  412 |   vehiclePlate: 'TEST-SLW',
  413 |   profilePhoto: 'data:image/jpeg;base64,' + 'A'.repeat(25_000),
  414 |   licensePhoto: 'data:image/jpeg;base64,' + 'B'.repeat(25_000),
  415 |   cnicFront:    'data:image/jpeg;base64,' + 'C'.repeat(25_000),
  416 |   cnicBack:     'data:image/jpeg;base64,' + 'D'.repeat(25_000),
  417 | });
  418 | 
  419 | // ── Real-server slow-upload test ──────────────────────────────────────────────
  420 | 
  421 | test.describe('Slow-socket upload — live server accepts slow continuous body within configured timeout', () => {
  422 |   /**
  423 |    * Context
  424 |    * -------
  425 |    * server.requestTimeout controls how long the http.Server allows for a
  426 |    * request to be received.  The default (Node 18+: 300 000 ms) is sufficient
  427 |    * for slow mobile uploads but is left implicit and can be overridden
  428 |    * accidentally by a framework upgrade or misconfiguration to a value too
  429 |    * short for 2G/3G uploads.
  430 |    *
  431 |    * The server now sets server.requestTimeout explicitly to 600 000 ms and
  432 |    * exposes it via REQUEST_TIMEOUT_MS.  playwright.config.js sets
  433 |    * REQUEST_TIMEOUT_MS=8 000 ms so tests use an 8 s budget.
  434 |    *
  435 |    * What this test proves
  436 |    * ---------------------
  437 |    * A ~100 KB body streamed in 4 KB chunks with 160 ms gaps takes roughly
  438 |    * 4 s — a duration that would be rejected by any timeout set below ~4 s
  439 |    * (the "formerly too-short" threshold).  The test sends this body to the
  440 |    * real /api/auth/register endpoint and asserts any HTTP response arrives,
  441 |    * confirming the server held the TCP connection open and received the
  442 |    * complete body within the 8 s configured budget.
  443 |    *
  444 |    * A socket error (ECONNRESET / ETIMEDOUT) or zero-byte body would mean the
  445 |    * server dropped the slow upload — the test would throw/fail.
  446 |    */
  447 | 
  448 |   test(
  449 |     'slow ~4 s upload of ~100 KB body succeeds — server holds connection open within the configured 8 s budget',
  450 |     async () => {
```