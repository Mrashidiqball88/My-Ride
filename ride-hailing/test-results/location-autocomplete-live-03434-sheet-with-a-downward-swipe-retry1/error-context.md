# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: location-autocomplete.spec.js >> live nationwide location autocomplete >> dismisses the drop-off sheet with a downward swipe
- Location: tests/location-autocomplete.spec.js:360:3

# Error details

```
Error: expect(locator).toHaveAttribute(expected) failed

Locator:  locator('#location-sheet')
Expected: "true"
Received: "false"
Timeout:  5000ms

Call log:
  - Expect "toHaveAttribute" with timeout 5000ms
  - waiting for locator('#location-sheet')
    13 × locator resolved to <section id="location-sheet" aria-hidden="false" class="location-sheet open" aria-label="Location suggestions">…</section>
       - unexpected value "false"

```

```yaml
- region "Location suggestions":
  - text: 🎯
  - textbox "Search Drop 1 (e.g. DHA Phase 5)"
  - button "Search Drop 1 by voice": 🎙
  - text: Drop-off location Type an area name to search
  - combobox "Voice search language"
  - button "Close location suggestions": ✕
  - button "Select location via Map Pin"
  - text: Start typing to search places, streets, and landmarks anywhere in Pakistan.
```

# Test source

```ts
  276 |     await setSearch(page, 'second pickup area');
  277 |     await expect.poll(() => requests).toHaveLength(2);
  278 |     expect(requests[1].searchParams.get('proximity')).toBe('67.0011,24.8607');
  279 |   });
  280 | 
  281 |   test('selects live pickup and drop-off results and pins their coordinates', async ({ page }) => {
  282 |     await page.route(/\/api\/geocode(?:\?|$)/, async route => {
  283 |       const url = new URL(route.request().url());
  284 |       const query = url.searchParams.get('q');
  285 |       const result = query === 'new pickup'
  286 |         ? geocodeResult('New Pickup Plaza', 'Multan', 30.1575, 71.5249, 'road')
  287 |         : geocodeResult('New Drop-off Chowk', 'Rawalpindi', 33.5651, 73.0169);
  288 |       return route.fulfill({
  289 |         contentType: 'application/json',
  290 |         body: JSON.stringify([result])
  291 |       });
  292 |     });
  293 | 
  294 |     await page.goto('/customer');
  295 |     await page.evaluate(() => {
  296 |       document.getElementById('auth-screen').style.display = 'none';
  297 |       document.getElementById('app').style.display = 'flex';
  298 |     });
  299 |     await setSearch(page, 'new pickup');
  300 |     await expect(page.locator('#location-sheet-list')).toContainText('New Pickup Plaza');
  301 |     await page.locator('#location-sheet-list [data-location-index]').first().click();
  302 |     await expect.poll(() => page.evaluate(() => pickup)).toMatchObject({
  303 |       lat: 30.1575,
  304 |       lng: 71.5249
  305 |     });
  306 |     await expect(page.locator('#customer-center-pin')).toHaveClass(/visible/);
  307 |     expect(await page.locator('#customer-center-pin').evaluate(element => {
  308 |       const mapRect = document.getElementById('map').getBoundingClientRect();
  309 |       const pinRect = element.getBoundingClientRect();
  310 |       return {
  311 |         position: getComputedStyle(element).position,
  312 |         horizontalOffset: Math.abs((pinRect.left + pinRect.width / 2) - (mapRect.left + mapRect.width / 2)),
  313 |         tipOffset: Math.abs(pinRect.bottom - (mapRect.top + mapRect.height / 2))
  314 |       };
  315 |     })).toMatchObject({ position: 'absolute', horizontalOffset: 0, tipOffset: 0 });
  316 | 
  317 |     await setSearch(page, 'new drop-off', 'stop-0-input');
  318 |     await expect(page.locator('#location-sheet-list')).toContainText('New Drop-off Chowk');
  319 |     await page.locator('#location-sheet-list [data-location-index]').first().click();
  320 |     await expect.poll(() => page.evaluate(() => ({
  321 |       dropoff: dropoffs[0],
  322 |       mode: mapMode,
  323 |       input: document.getElementById('stop-0-input').value
  324 |     }))).toMatchObject({
  325 |       dropoff: { lat: 33.5651, lng: 73.0169 },
  326 |       mode: 'idle',
  327 |       input: 'New Drop-off Chowk'
  328 |     });
  329 |     await expect(page.locator('#customer-center-pin')).not.toHaveClass(/visible/);
  330 |   });
  331 | 
  332 |   test('renders a detailed reverse-geocoded pickup label', async ({ page }) => {
  333 |     await page.route(/\/api\/geocode\/reverse(?:\?|$)/, route => route.fulfill({
  334 |       contentType: 'application/json',
  335 |       body: JSON.stringify({
  336 |         display_name: '22 Canal Bank Road, Shadman Colony, Lahore, Punjab',
  337 |         address: {
  338 |           house_number: '22',
  339 |           road: 'Canal Bank Road',
  340 |           suburb: 'Shadman Colony',
  341 |           city: 'Lahore',
  342 |           state: 'Punjab'
  343 |         }
  344 |       })
  345 |     }));
  346 | 
  347 |     await page.goto('/customer');
  348 |     await page.evaluate(async () => {
  349 |       await setPickup(31.5204, 74.3587);
  350 |     });
  351 |     await expect.poll(() => page.evaluate(() => ({
  352 |       address: pickup?.address,
  353 |       input: document.getElementById('pickup-input')?.value
  354 |     }))).toEqual({
  355 |       address: '22 Canal Bank Road, Shadman Colony, Lahore, Punjab',
  356 |       input: '22 Canal Bank Road, Shadman Colony, Lahore, Punjab'
  357 |     });
  358 |   });
  359 | 
  360 |   test('dismisses the drop-off sheet with a downward swipe', async ({ page }) => {
  361 |     await page.goto('/customer');
  362 |     await page.evaluate(() => {
  363 |       document.getElementById('auth-screen').style.display = 'none';
  364 |       document.getElementById('app').style.display = 'flex';
  365 |       renderLocationSheet('stop-0', [], '');
  366 |     });
  367 |     const sheet = page.locator('#location-sheet');
  368 |     const header = page.locator('#location-sheet-header .sheet-header-copy');
  369 |     await expect(sheet).toHaveClass(/open/);
  370 |     const box = await header.boundingBox();
  371 |     expect(box).not.toBeNull();
  372 |     await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  373 |     await page.mouse.down();
  374 |     await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 180);
  375 |     await page.mouse.up();
> 376 |     await expect(sheet).toHaveAttribute('aria-hidden', 'true');
      |                         ^ Error: expect(locator).toHaveAttribute(expected) failed
  377 |   });
  378 | 
  379 |   test('returns from drop-off search to the active map pin', async ({ page }) => {
  380 |     await page.goto('/customer');
  381 |     await page.evaluate(() => {
  382 |       document.getElementById('auth-screen').style.display = 'none';
  383 |       document.getElementById('app').style.display = 'flex';
  384 |       renderLocationSheet('stop-0', [], '');
  385 |     });
  386 |     await expect(page.locator('[data-location-action="map-pin"]')).toContainText('Select location via Map Pin');
  387 |     await page.locator('[data-location-action="map-pin"]').click();
  388 |     await expect.poll(() => page.evaluate(() => ({
  389 |       mode: mapMode,
  390 |       activeSearch: activeLocationSearch,
  391 |       pinVisible: document.getElementById('customer-center-pin')?.classList.contains('visible'),
  392 |       hint: document.getElementById('map-hint')?.textContent
  393 |     }))).toEqual({
  394 |       mode: 'stop-0',
  395 |       activeSearch: null,
  396 |       pinVisible: true,
  397 |       hint: 'Move the map under the center pin, then release to choose your drop-off'
  398 |     });
  399 |     await expect(page.locator('#location-sheet')).toHaveAttribute('aria-hidden', 'true');
  400 |   });
  401 | 
  402 |   test('commits the fixed center pin after a customer map drag', async ({ page }) => {
  403 |     await page.goto('/customer');
  404 |     const selected = await page.evaluate(() => {
  405 |       const previousMap = map;
  406 |       const previousSetPickup = setPickup;
  407 |       let result = null;
  408 |       mapMode = 'pickup';
  409 |       customerMapSelectionGesture = true;
  410 |       map = { getCenter: () => ({ lat: 31.5204, lng: 74.3587 }) };
  411 |       setPickup = (lat, lng) => { result = { lat, lng }; };
  412 |       selectCustomerMapCenter();
  413 |       setPickup = previousSetPickup;
  414 |       map = previousMap;
  415 |       return result;
  416 |     });
  417 |     expect(selected).toEqual({ lat: 31.5204, lng: 74.3587 });
  418 |   });
  419 | 
  420 |   test('shows an actionable provider error and clears stale results', async ({ page }) => {
  421 |     let shouldFail = false;
  422 |     await page.route(/\/api\/geocode(?:\?|$)/, route => {
  423 |       if (shouldFail) {
  424 |         return route.fulfill({
  425 |           status: 503,
  426 |           contentType: 'application/json',
  427 |           body: JSON.stringify({ error: 'Geocoding is temporarily unavailable' })
  428 |         });
  429 |       }
  430 |       return route.fulfill({
  431 |         contentType: 'application/json',
  432 |         body: JSON.stringify([geocodeResult('First Live Result', 'Lahore', 31.5204, 74.3587)])
  433 |       });
  434 |     });
  435 | 
  436 |     await page.goto('/customer');
  437 |     await setSearch(page, 'first live');
  438 |     await expect(page.locator('#location-sheet-list')).toContainText('First Live Result');
  439 |     shouldFail = true;
  440 |     await setSearch(page, 'provider outage');
  441 |     await expect(page.locator('#location-sheet-list')).toContainText('Location search is unavailable right now');
  442 |     await expect(page.locator('#location-sheet-list')).not.toContainText('First Live Result');
  443 |   });
  444 | 
  445 |   test('recovers cleanly from a provider timeout', async ({ page }) => {
  446 |     await page.addInitScript(() => {
  447 |       window.__CUSTOMER_SEARCH_TIMEOUT_MS = 40;
  448 |     });
  449 |     await page.route(/\/api\/geocode(?:\?|$)/, route => new Promise(resolve => {
  450 |       setTimeout(() => resolve(route.fulfill({
  451 |         contentType: 'application/json',
  452 |         body: '[]'
  453 |       })), 200);
  454 |     }));
  455 | 
  456 |     await page.goto('/customer');
  457 |     await setSearch(page, 'remote timeout place');
  458 |     await expect.poll(() => page.evaluate(() => locationSearchError)).toContain('timed out');
  459 |     await expect(page.locator('#location-sheet-list')).toContainText('timed out');
  460 |     await expect.poll(() => page.evaluate(() => ({
  461 |       loading: locationSearchLoading,
  462 |       aborted: locSearchAbort.pickup === null
  463 |     }))).toEqual({ loading: false, aborted: true });
  464 |   });
  465 | });
```