# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: location-autocomplete.spec.js >> live nationwide location autocomplete >> auto-detects current location and fills pickup on customer boot
- Location: tests/location-autocomplete.spec.js:46:3

# Error details

```
Error: expect(locator).toHaveValue(expected) failed

Locator:  locator('#pickup-input')
Expected: "22 Canal Bank Road, Shadman Colony, Lahore, Punjab"
Received: ""
Timeout:  5000ms

Call log:
  - Expect "toHaveValue" with timeout 5000ms
  - waiting for locator('#pickup-input')
    10 × locator resolved to <input dir="auto" id="pickup-input" autocomplete="off" spellcheck="false" class="location-input" aria-label="Pickup location" onblur="onLocBlur('pickup')" onfocus="onLocFocus('pickup')" oninput="onLocInput('pickup');updateClearBtn('pickup')"/>
       - unexpected value ""

```

```yaml
- textbox "Pickup location"
```

# Test source

```ts
  1   | // @ts-check
  2   | 'use strict';
  3   | 
  4   | const { test, expect } = require('@playwright/test');
  5   | 
  6   | function geocodeResult(primary, city, lat, lon, kind = 'suburb') {
  7   |   return {
  8   |     display_name: `${primary}, ${city}, Pakistan`,
  9   |     lat: String(lat),
  10  |     lon: String(lon),
  11  |     type: kind,
  12  |     address: {
  13  |       [kind === 'road' ? 'road' : 'suburb']: primary,
  14  |       city
  15  |     }
  16  |   };
  17  | }
  18  | 
  19  | function poiResult(primary, city, lat, lon, type, extra = {}) {
  20  |   return {
  21  |     display_name: `${primary}, ${city}, Pakistan`,
  22  |     lat: String(lat),
  23  |     lon: String(lon),
  24  |     type,
  25  |     ...extra,
  26  |     address: {
  27  |       city,
  28  |       ...(extra.address || {})
  29  |     }
  30  |   };
  31  | }
  32  | 
  33  | async function setSearch(page, value, inputId = 'pickup-input') {
  34  |   await page.evaluate(({ value, inputId }) => {
  35  |     const input = document.getElementById(inputId);
  36  |     input.value = value;
  37  |     input.dispatchEvent(new Event('input', { bubbles: true }));
  38  |   }, { value, inputId });
  39  | }
  40  | 
  41  | async function visibleLocationNames(page) {
  42  |   return page.locator('#location-sheet-list [data-location-index] .sheet-item-primary').allTextContents();
  43  | }
  44  | 
  45  | test.describe('live nationwide location autocomplete', () => {
  46  |   test('auto-detects current location and fills pickup on customer boot', async ({ page }) => {
  47  |     await page.addInitScript(() => {
  48  |       localStorage.setItem('rh_token', 'location-boot-test-token');
  49  |       localStorage.setItem('rh_user', JSON.stringify({
  50  |         id: 'location-boot-customer',
  51  |         _id: 'location-boot-customer',
  52  |         name: 'Location Boot Customer',
  53  |         role: 'customer'
  54  |       }));
  55  |       window.__customerGpsCalls = 0;
  56  |       Object.defineProperty(navigator, 'geolocation', {
  57  |         configurable: true,
  58  |         value: {
  59  |           getCurrentPosition(success) {
  60  |             window.__customerGpsCalls++;
  61  |             success({
  62  |               coords: { latitude: 31.5204, longitude: 74.3587 }
  63  |             });
  64  |           },
  65  |           watchPosition() {
  66  |             return 42;
  67  |           },
  68  |           clearWatch() {}
  69  |         }
  70  |       });
  71  |     });
  72  |     await page.route(/\/api\/geocode\/reverse(?:\?|$)/, route => route.fulfill({
  73  |       contentType: 'application/json',
  74  |       body: JSON.stringify({
  75  |         display_name: '22 Canal Bank Road, Shadman Colony, Lahore, Punjab',
  76  |         address: {
  77  |           house_number: '22',
  78  |           road: 'Canal Bank Road',
  79  |           suburb: 'Shadman Colony',
  80  |           city: 'Lahore',
  81  |           state: 'Punjab'
  82  |         }
  83  |       })
  84  |     }));
  85  | 
  86  |     await page.goto('/customer');
> 87  |     await expect(page.locator('#pickup-input')).toHaveValue(
      |                                                 ^ Error: expect(locator).toHaveValue(expected) failed
  88  |       '22 Canal Bank Road, Shadman Colony, Lahore, Punjab'
  89  |     );
  90  |     await expect.poll(() => page.evaluate(() => ({
  91  |       calls: window.__customerGpsCalls,
  92  |       pickup: pickup && { lat: pickup.lat, lng: pickup.lng, address: pickup.address }
  93  |     }))).toEqual({
  94  |       calls: 1,
  95  |       pickup: {
  96  |         lat: 31.5204,
  97  |         lng: 74.3587,
  98  |         address: '22 Canal Bank Road, Shadman Colony, Lahore, Punjab'
  99  |       }
  100 |     });
  101 |   });
  102 | 
  103 |   test('renders arbitrary live provider places nationwide without local lists or city filtering', async ({ page }) => {
  104 |     const requests = [];
  105 |     await page.route(/\/api\/geocode(?:\?|$)/, async route => {
  106 |       const url = new URL(route.request().url());
  107 |       requests.push(url);
  108 |       return route.fulfill({
  109 |         contentType: 'application/json',
  110 |         body: JSON.stringify([
  111 |           geocodeResult('National Textile Innovation Park', 'Faisalabad', 31.4504, 73.1350, 'road'),
  112 |           geocodeResult('Quetta Arts University', 'Quetta', 30.1798, 66.9750),
  113 |           { display_name: 'Invalid provider record', lat: 'not-a-number', lon: '0' }
  114 |         ])
  115 |       });
  116 |     });
  117 | 
  118 |     await page.goto('/customer');
  119 |     await page.evaluate(() => {
  120 |       customerActiveCity = 'Karachi';
  121 |       customerCityLocation = { lat: 24.8607, lng: 67.0011 };
  122 |     });
  123 |     await setSearch(page, 'textile innovation park');
  124 | 
  125 |     await expect.poll(() => visibleLocationNames(page)).toHaveLength(2);
  126 |     const names = await visibleLocationNames(page);
  127 |     expect(names).toEqual(expect.arrayContaining([
  128 |       'National Textile Innovation Park',
  129 |       'Quetta Arts University'
  130 |     ]));
  131 |     expect(await page.locator('#location-sheet-list').textContent()).not.toContain('Invalid provider record');
  132 |     expect(requests).toHaveLength(1);
  133 |     expect(requests[0].searchParams.get('q')).toBe('textile innovation park');
  134 |     expect(requests[0].searchParams.get('city')).toBeNull();
  135 |     expect(requests[0].searchParams.get('broad')).toBeNull();
  136 |     expect(requests[0].searchParams.get('global')).toBeNull();
  137 |   });
  138 | 
  139 |   test('keeps live results from other cities and ignores stale responses after rapid typing', async ({ page }) => {
  140 |     const requests = [];
  141 |     await page.route(/\/api\/geocode(?:\?|$)/, async route => {
  142 |       const url = new URL(route.request().url());
  143 |       const query = url.searchParams.get('q');
  144 |       requests.push(query);
  145 |       if (query === 'old place') {
  146 |         await new Promise(resolve => setTimeout(resolve, 180));
  147 |         return route.fulfill({
  148 |           contentType: 'application/json',
  149 |           body: JSON.stringify([geocodeResult('Old Live Place', 'Lahore', 31.5204, 74.3587)])
  150 |         });
  151 |       }
  152 |       return route.fulfill({
  153 |         contentType: 'application/json',
  154 |         body: JSON.stringify([geocodeResult('Fresh Live University', 'Peshawar', 34.0151, 71.5249)])
  155 |       });
  156 |     });
  157 | 
  158 |     await page.goto('/customer');
  159 |     await page.evaluate(() => {
  160 |       customerActiveCity = 'Karachi';
  161 |       customerCityLocation = { lat: 24.8607, lng: 67.0011 };
  162 |     });
  163 |     await setSearch(page, 'old place');
  164 |     await expect.poll(() => requests).toContain('old place');
  165 |     await setSearch(page, 'fresh university');
  166 | 
  167 |     await expect.poll(() => visibleLocationNames(page)).toEqual(['Fresh Live University']);
  168 |     await expect(page.locator('#location-sheet-list')).not.toContainText('Old Live Place');
  169 |     expect(requests).toContain('fresh university');
  170 |   });
  171 | 
  172 |   test('uses live provider results for voice input and preserves the spoken transcript', async ({ page }) => {
  173 |     await page.addInitScript(() => {
  174 |       window.__recognition = null;
  175 |       window.SpeechRecognition = class {
  176 |         constructor() { window.__recognition = this; }
  177 |         start() { this.onstart?.(); }
  178 |         abort() {}
  179 |         stop() { this.onend?.(); }
  180 |       };
  181 |     });
  182 |     await page.route(/\/api\/geocode(?:\?|$)/, route => route.fulfill({
  183 |       contentType: 'application/json',
  184 |       body: JSON.stringify([
  185 |         geocodeResult('Shalimar Hospital', 'Lahore', 31.5822, 74.3921, 'hospital')
  186 |       ])
  187 |     }));
```