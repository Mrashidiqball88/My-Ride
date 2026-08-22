# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: document-upload.spec.js >> Slow-socket upload — live server accepts slow continuous body within configured timeout >> slow ~4 s upload of ~100 KB body succeeds — server holds connection open within the configured 8 s budget
- Location: tests/document-upload.spec.js:448:3

# Error details

```
Error: expect(received).toContain(expected) // indexOf

Expected value: 400
Received array: [201, 409, 500]
```

# Test source

```ts
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
  451 |       test.setTimeout(25_000);
  452 | 
  453 |       // 25 chunks × 160 ms ≈ 4 000 ms  — crosses a sub-4 s "formerly too-short"
  454 |       // threshold but stays within the configured 8 000 ms test-mode budget.
  455 |       const { status, bodyBytesReceived } = await sendSlowChunked(
  456 |         3000,
  457 |         '/api/auth/register',
  458 |         SLOW_UPLOAD_BODY,
  459 |         { chunkSize: 4_096, delayMs: 160 }
  460 |       );
  461 | 
  462 |       // The server must have received the full body before replying.
  463 |       expect(bodyBytesReceived).toBe(Buffer.byteLength(SLOW_UPLOAD_BODY));
  464 | 
  465 |       // Any HTTP status proves the server kept the connection alive.
  466 |       // 201 = registration success, 409 = duplicate phone, 500 = DB unavailable.
> 467 |       expect([201, 409, 500]).toContain(status);
      |                               ^ Error: expect(received).toContain(expected) // indexOf
  468 |     }
  469 |   );
  470 | });
  471 | 
  472 | // ── Registration failure tests ────────────────────────────────────────────────
  473 | 
  474 | test.describe('Registration failures — 409 duplicate phone and network error', () => {
  475 |   /**
  476 |    * Sets up all the standard stub routes except /api/auth/register so each
  477 |    * test can install its own register handler.
  478 |    */
  479 |   async function setupRoutesWithoutRegister(page) {
  480 |     await page.route('**/socket.io/**', (route) => {
  481 |       if (route.request().url().endsWith('.js')) {
  482 |         route.continue();
  483 |       } else {
  484 |         route.abort();
  485 |       }
  486 |     });
  487 |     await page.route('**/api/auth/me', (route) =>
  488 |       route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"unauthorized"}' })
  489 |     );
  490 |     await page.route('**/api/wallet**', (route) =>
  491 |       route.fulfill({ status: 200, contentType: 'application/json', body: '{"balance":0,"transactions":[]}' })
  492 |     );
  493 |     await page.route('**/api/rides/my**', (route) =>
  494 |       route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
  495 |     );
  496 |     await page.route('**/api/settings/payment**', (route) =>
  497 |       route.fulfill({ status: 200, contentType: 'application/json', body: '{"accounts":{}}' })
  498 |     );
  499 |     await page.route('**/api/support/**', (route) =>
  500 |       route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
  501 |     );
  502 |   }
  503 | 
  504 |   // ---------------------------------------------------------------------------
  505 |   test(
  506 |     '409 duplicate phone — overlay hides and error message appears in #auth-error',
  507 |     async ({ page }) => {
  508 |       await setupRoutesWithoutRegister(page);
  509 | 
  510 |       // Register endpoint returns 409 with a descriptive error body.
  511 |       await page.route('**/api/auth/register', async (route) => {
  512 |         await new Promise((r) => setTimeout(r, 100));
  513 |         await route.fulfill({
  514 |           status: 409,
  515 |           contentType: 'application/json',
  516 |           body: JSON.stringify({ error: 'Phone number already registered' }),
  517 |         });
  518 |       });
  519 | 
  520 |       await page.goto('/driver');
  521 |       await fillStep1(page);
  522 |       await uploadPhotos(page);
  523 |       await page.locator('#reg-submit-btn').click();
  524 | 
  525 |       // Overlay should appear while the request is in-flight…
  526 |       const overlay = page.locator('#upload-progress-screen');
  527 |       await expect(overlay).toBeVisible({ timeout: 8_000 });
  528 | 
  529 |       // …then hide once the 409 is received (no 600 ms success delay).
  530 |       await expect(overlay).toBeHidden({ timeout: 8_000 });
  531 | 
  532 |       // Auth screen must still be visible (driver was NOT logged in).
  533 |       await expect(page.locator('#auth-screen')).toBeVisible();
  534 |       await expect(page.locator('#app')).toBeHidden();
  535 | 
  536 |       // The exact server error message must appear in #auth-error.
  537 |       await expect(page.locator('#auth-error')).toHaveText(
  538 |         'Phone number already registered',
  539 |         { timeout: 3_000 }
  540 |       );
  541 |     }
  542 |   );
  543 | 
  544 |   // ---------------------------------------------------------------------------
  545 |   test(
  546 |     'network failure — overlay hides and network error message appears in #auth-error',
  547 |     async ({ page }) => {
  548 |       await setupRoutesWithoutRegister(page);
  549 | 
  550 |       // Abort the connection to simulate a network drop / offline condition.
  551 |       // A small delay lets the overlay appear before onerror fires so we can
  552 |       // assert the in-flight state reliably.
  553 |       await page.route('**/api/auth/register', async (route) => {
  554 |         await new Promise((r) => setTimeout(r, 200));
  555 |         await route.abort('failed');
  556 |       });
  557 | 
  558 |       await page.goto('/driver');
  559 |       await fillStep1(page);
  560 |       await uploadPhotos(page);
  561 |       await page.locator('#reg-submit-btn').click();
  562 | 
  563 |       // Overlay should appear while the XHR is in-flight…
  564 |       const overlay = page.locator('#upload-progress-screen');
  565 |       await expect(overlay).toBeVisible({ timeout: 8_000 });
  566 | 
  567 |       // …then hide once xhr.onerror fires.
```