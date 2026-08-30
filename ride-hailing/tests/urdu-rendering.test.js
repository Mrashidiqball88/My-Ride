'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const read = relativePath => fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
const customerHtml = read('public/customer.html');
const driverHtml = read('public/driver.html');
const nativeLayout = read('../artifacts/myride-driver-mobile/app/_layout.tsx');
const nativeHome = read('../artifacts/myride-driver-mobile/app/index.tsx');

test('Customer and web Driver use Mapbox maps with Urdu-capable document text', () => {
  assert.match(customerHtml, /api\.mapbox\.com\/mapbox-gl-js\/v3\.15\.0\/mapbox-gl\.js/);
  assert.match(driverHtml, /api\.mapbox\.com\/mapbox-gl-js\/v3\.15\.0\/mapbox-gl\.js/);
  assert.match(customerHtml, /mapbox:\/\/styles\/mapbox\/streets-v12/);
  assert.match(driverHtml, /mapbox:\/\/styles\/mapbox\/streets-v12/);
  assert.doesNotMatch(customerHtml, /maplibre|openfreemap|openstreetmap/i);
  assert.doesNotMatch(driverHtml, /maplibre|openfreemap|openstreetmap/i);
});

test('web Driver location surfaces opt into an Urdu-capable font and bidi direction', () => {
  assert.match(driverHtml, /Noto\+Naskh\+Arabic/);
  assert.match(driverHtml, /class="nav-destination-name bidi-text"[^>]*dir="auto"/);
  assert.match(driverHtml, /id="rr-pickup" dir="auto"/);
  assert.match(driverHtml, /id="ap-pickup" dir="auto"/);
  assert.match(driverHtml, /id="ap-dropoff" dir="auto"/);
  assert.match(driverHtml, /class="rr-point-text bidi-text" dir="auto"/);
});

test('native Driver loads Noto Naskh Arabic and applies RTL layout to dynamic labels', () => {
  assert.match(nativeLayout, /NotoNaskhArabic_400Regular/);
  assert.match(nativeLayout, /NotoNaskhArabic_700Bold/);
  assert.match(nativeHome, /const RTL_TEXT_PATTERN/);
  assert.match(nativeHome, /fontFamily: 'NotoNaskhArabic_400Regular'/);
  assert.match(nativeHome, /writingDirection: 'rtl'/);
});