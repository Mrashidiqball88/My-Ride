# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: location-autocomplete.spec.js >> live nationwide location autocomplete >> searches nationwide without a pickup or GPS context
- Location: tests/location-autocomplete.spec.js:216:3

# Error details

```
Error: expect(received).toBeNull()

Received: "24.8607"
```

# Page snapshot

```yaml
- generic [active] [ref=e1]:
  - generic [ref=e2]:
    - generic [ref=e3]:
      - img "My Ride" [ref=e4]
      - generic [ref=e5]: My RideCUSTOMER
    - paragraph [ref=e6]: Customer Portal
    - generic [ref=e7]:
      - generic [ref=e8]:
        - button "Sign In" [ref=e9] [cursor=pointer]
        - button "Register" [ref=e10] [cursor=pointer]
      - generic [ref=e11]:
        - generic [ref=e12]:
          - generic [ref=e13]: Phone or Email
          - textbox "03001234567 or you@email.com" [ref=e14]
        - generic [ref=e15]:
          - generic [ref=e16]: Password
          - generic [ref=e17]:
            - textbox "••••••••" [ref=e18]
            - button "👁" [ref=e19] [cursor=pointer]
        - button "Sign In" [ref=e20] [cursor=pointer]
        - button "Forgot Password?" [ref=e22] [cursor=pointer]
  - generic:
    - generic:
      - button "← Back"
      - generic: 🆘 Emergency Contacts
      - generic: Saved contacts are included automatically in every SOS alert with your live location and driver details.
      - generic: Contact 1
      - generic:
        - generic: Name
        - textbox "e.g. Ammi"
      - generic:
        - generic: Phone
        - textbox "+92 300 0000000"
      - generic: Contact 2 (optional)
      - generic:
        - generic: Name
        - textbox "e.g. Bhai"
      - generic:
        - generic: Phone
        - textbox "+92 300 0000000"
      - generic:
        - button "Cancel"
        - button "Save Contacts"
```

# Test source

```ts
  142 |     await expect(page.locator('#pickup-input')).toHaveValue('Shalimar Hospital');
  143 |     await expect(page.locator('#location-sheet-list')).toContainText('Shalimar Hospital');
  144 |     await expect(page.locator('#location-sheet-list .sheet-item-tertiary').first()).toContainText('Lahore');
  145 |     await expect(page.locator('#location-sheet-list .sheet-item-coordinates').first())
  146 |       .toHaveText(/\d+\.\d{4},\s+\d+\.\d{4}/);
  147 |   });
  148 | 
  149 |   test('preserves mixed Urdu and English input for the live provider query', async ({ page }) => {
  150 |     let requestedQuery;
  151 |     await page.route(/\/api\/geocode(?:\?|$)/, async route => {
  152 |       requestedQuery = new URL(route.request().url()).searchParams.get('q');
  153 |       return route.fulfill({
  154 |         contentType: 'application/json',
  155 |         body: JSON.stringify([
  156 |           poiResult('Jinnah International Airport', 'Karachi', 24.9058, 67.1614, 'aerodrome')
  157 |         ])
  158 |       });
  159 |     });
  160 | 
  161 |     await page.goto('/customer');
  162 |     const query = 'جناح  airport';
  163 |     await setSearch(page, query);
  164 | 
  165 |     await expect(page.locator('#location-sheet-list')).toContainText('Jinnah International Airport');
  166 |     expect(requestedQuery).toBe(query);
  167 |   });
  168 | 
  169 |   test('keeps vital POI categories from multiple cities and labels provider metadata', async ({ page }) => {
  170 |     const requests = [];
  171 |     await page.route(/\/api\/geocode(?:\?|$)/, async route => {
  172 |       const url = new URL(route.request().url());
  173 |       requests.push(url);
  174 |       return route.fulfill({
  175 |         contentType: 'application/json',
  176 |         body: JSON.stringify([
  177 |           poiResult('Allama Iqbal International Airport', 'Lahore', 31.5216, 74.4036, 'aerodrome'),
  178 |           poiResult('Daewoo Bus Terminal', 'Karachi', 24.8947, 67.0632, 'bus_station'),
  179 |           poiResult('Aga Khan University Hospital', 'Karachi', 24.8934, 67.0746, 'hospital'),
  180 |           poiResult('Government College University', 'Faisalabad', 31.4180, 73.0790, 'college'),
  181 |           poiResult('University of Peshawar', 'Peshawar', 34.0209, 71.4874, 'university'),
  182 |           poiResult('Liberty Chowk', 'Lahore', 31.5107, 74.3441, 'place', { name: 'Liberty Chowk' }),
  183 |           poiResult('Pakistan Monument', 'Islamabad', 33.6938, 73.0652, 'monument'),
  184 |           poiResult('Unknown Community Place', 'Quetta', 30.1798, 66.9750, 'community_centre')
  185 |         ])
  186 |       });
  187 |     });
  188 | 
  189 |     await page.goto('/customer');
  190 |     await page.evaluate(() => {
  191 |       customerActiveCity = 'Karachi';
  192 |       pickup = { lat: 24.8607, lng: 67.0011 };
  193 |     });
  194 |     await setSearch(page, 'important places');
  195 | 
  196 |     await expect.poll(() => visibleLocationNames(page)).toHaveLength(8);
  197 |     const sheet = page.locator('#location-sheet-list');
  198 |     await expect(sheet).toContainText('Airport');
  199 |     await expect(sheet).toContainText('Bus terminal / station');
  200 |     await expect(sheet).toContainText('Healthcare');
  201 |     await expect(sheet).toContainText('College');
  202 |     await expect(sheet).toContainText('University');
  203 |     await expect(sheet).toContainText('Intersection / chowk');
  204 |     await expect(sheet).toContainText('Landmark');
  205 |     await expect(sheet).toContainText('Community Centre');
  206 |     expect(requests).toHaveLength(1);
  207 |     expect(requests[0].searchParams.get('q')).toBe('important places');
  208 |     expect(requests[0].searchParams.get('countrycodes')).toBeNull();
  209 |     expect(requests[0].searchParams.get('city')).toBeNull();
  210 |     expect(requests[0].searchParams.get('radius')).toBeNull();
  211 |     expect(requests[0].searchParams.get('viewbox')).toBeNull();
  212 |     expect(requests[0].searchParams.get('bounded')).toBeNull();
  213 |     expect(requests[0].searchParams.get('type')).toBeNull();
  214 |   });
  215 | 
  216 |   test('searches nationwide without a pickup or GPS context', async ({ page }) => {
  217 |     let requestedUrl;
  218 |     await page.route(/\/api\/geocode(?:\?|$)/, async route => {
  219 |       requestedUrl = new URL(route.request().url());
  220 |       return route.fulfill({
  221 |         contentType: 'application/json',
  222 |         body: JSON.stringify([
  223 |           poiResult('Jinnah International Airport', 'Karachi', 24.9065, 67.1608, 'airport'),
  224 |           poiResult('Khyber Medical University', 'Peshawar', 34.0151, 71.5249, 'university')
  225 |         ])
  226 |       });
  227 |     });
  228 | 
  229 |     await page.goto('/customer');
  230 |     await page.evaluate(() => {
  231 |       pickup = null;
  232 |       // These are intentionally present: only the active pickup pin may
  233 |       // become Mapbox proximity context.
  234 |       customerLocation = { lat: 24.8607, lng: 67.0011 };
  235 |       customerCityLocation = { lat: 33.6844, lng: 73.0479 };
  236 |       customerActiveCity = 'Islamabad';
  237 |     });
  238 |     await setSearch(page, 'airport');
  239 | 
  240 |     await expect.poll(() => visibleLocationNames(page)).toHaveLength(2);
  241 |     expect(requestedUrl.searchParams.get('q')).toBe('airport');
> 242 |     expect(requestedUrl.searchParams.get('lat')).toBeNull();
      |                                                  ^ Error: expect(received).toBeNull()
  243 |     expect(requestedUrl.searchParams.get('lng')).toBeNull();
  244 |   });
  245 | 
  246 |   test('sends the active pickup pin and refreshes proximity after the pin changes', async ({ page }) => {
  247 |     const requests = [];
  248 |     await page.route(/\/api\/geocode(?:\?|$)/, async route => {
  249 |       const url = new URL(route.request().url());
  250 |       requests.push(url);
  251 |       return route.fulfill({
  252 |         contentType: 'application/json',
  253 |         body: JSON.stringify([
  254 |           poiResult('Nearby provider result', 'Pakistan', 30, 70, 'place')
  255 |         ])
  256 |       });
  257 |     });
  258 | 
  259 |     await page.goto('/customer');
  260 |     await page.evaluate(() => {
  261 |       pickup = { lat: 31.5204, lng: 74.3587 };
  262 |       customerLocation = { lat: 24.8607, lng: 67.0011 };
  263 |     });
  264 |     await setSearch(page, 'first pickup area');
  265 |     await expect.poll(() => requests).toHaveLength(1);
  266 |     expect(requests[0].searchParams.get('lat')).toBe('31.5204');
  267 |     expect(requests[0].searchParams.get('lng')).toBe('74.3587');
  268 | 
  269 |     await page.evaluate(() => {
  270 |       pickup = { lat: 24.8607, lng: 67.0011 };
  271 |     });
  272 |     await setSearch(page, 'second pickup area');
  273 |     await expect.poll(() => requests).toHaveLength(2);
  274 |     expect(requests[1].searchParams.get('lat')).toBe('24.8607');
  275 |     expect(requests[1].searchParams.get('lng')).toBe('67.0011');
  276 |   });
  277 | 
  278 |   test('selects live pickup and drop-off results and pins their coordinates', async ({ page }) => {
  279 |     await page.route(/\/api\/geocode(?:\?|$)/, async route => {
  280 |       const url = new URL(route.request().url());
  281 |       const query = url.searchParams.get('q');
  282 |       const result = query === 'new pickup'
  283 |         ? geocodeResult('New Pickup Plaza', 'Multan', 30.1575, 71.5249, 'road')
  284 |         : geocodeResult('New Drop-off Chowk', 'Rawalpindi', 33.5651, 73.0169);
  285 |       return route.fulfill({
  286 |         contentType: 'application/json',
  287 |         body: JSON.stringify([result])
  288 |       });
  289 |     });
  290 | 
  291 |     await page.goto('/customer');
  292 |     await page.evaluate(() => {
  293 |       document.getElementById('auth-screen').style.display = 'none';
  294 |       document.getElementById('app').style.display = 'flex';
  295 |     });
  296 |     await setSearch(page, 'new pickup');
  297 |     await expect(page.locator('#location-sheet-list')).toContainText('New Pickup Plaza');
  298 |     await page.locator('#location-sheet-list [data-location-index]').first().click();
  299 |     await expect.poll(() => page.evaluate(() => pickup)).toMatchObject({
  300 |       lat: 30.1575,
  301 |       lng: 71.5249
  302 |     });
  303 | 
  304 |     await setSearch(page, 'new drop-off', 'stop-0-input');
  305 |     await expect(page.locator('#location-sheet-list')).toContainText('New Drop-off Chowk');
  306 |     await page.locator('#location-sheet-list [data-location-index]').first().click();
  307 |     await expect.poll(() => page.evaluate(() => ({
  308 |       dropoff: dropoffs[0],
  309 |       mode: mapMode,
  310 |       input: document.getElementById('stop-0-input').value
  311 |     }))).toMatchObject({
  312 |       dropoff: { lat: 33.5651, lng: 73.0169 },
  313 |       mode: 'idle',
  314 |       input: 'New Drop-off Chowk'
  315 |     });
  316 |   });
  317 | 
  318 |   test('shows an actionable provider error and clears stale results', async ({ page }) => {
  319 |     let shouldFail = false;
  320 |     await page.route(/\/api\/geocode(?:\?|$)/, route => {
  321 |       if (shouldFail) {
  322 |         return route.fulfill({
  323 |           status: 503,
  324 |           contentType: 'application/json',
  325 |           body: JSON.stringify({ error: 'Geocoding is temporarily unavailable' })
  326 |         });
  327 |       }
  328 |       return route.fulfill({
  329 |         contentType: 'application/json',
  330 |         body: JSON.stringify([geocodeResult('First Live Result', 'Lahore', 31.5204, 74.3587)])
  331 |       });
  332 |     });
  333 | 
  334 |     await page.goto('/customer');
  335 |     await setSearch(page, 'first live');
  336 |     await expect(page.locator('#location-sheet-list')).toContainText('First Live Result');
  337 |     shouldFail = true;
  338 |     await setSearch(page, 'provider outage');
  339 |     await expect(page.locator('#location-sheet-list')).toContainText('Location search is unavailable right now');
  340 |     await expect(page.locator('#location-sheet-list')).not.toContainText('First Live Result');
  341 |   });
  342 | 
```