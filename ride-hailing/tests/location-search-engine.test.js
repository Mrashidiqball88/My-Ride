'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { searchLocations } = require('../location-search-engine');

test('returns local fuzzy and phonetic matches without provider work', () => {
  assert.equal(searchLocations('PACAGES', { city: 'Lahore' })[0].primary, 'Packages Mall');
  assert.equal(searchLocations('PAKGS', { city: 'Lahore' })[0].primary, 'Packages Mall');
  assert.equal(searchLocations('DHA 5', { city: 'Karachi' })[0].primary, 'DHA Phase 5');
});

test('recognizes Lahore landmarks and common spoken/Roman-Urdu variants', () => {
  const cases = [
    ['Shalimar Hospital', 'Shalimar Hospital'],
    ['shalamar hospital', 'Shalimar Hospital'],
    ['inshallah hospital', 'Shalimar Hospital'],
    ['Children Hospital', 'Children Hospital Lahore'],
    ['childrens hospital', 'Children Hospital Lahore'],
    ['Yatim Khana', 'Chowk Yateem Khana'],
    ['yateem khana chowk', 'Chowk Yateem Khana']
  ];
  for (const [query, expected] of cases) {
    const result = searchLocations(query, { city: 'Lahore' })[0];
    assert.equal(result?.primary, expected, query);
    assert.equal(result?.city, 'Lahore', query);
    assert.ok(Number.isFinite(result?.lat) && Number.isFinite(result?.lon), query);
    assert.match(result?.address || '', /Pakistan$/, query);
  }
});

test('ranks the pickup city before another city with the same area name', () => {
  const results = searchLocations('DHA', {
    city: 'Karachi',
    lat: 24.7915,
    lng: 67.0648
  });
  assert.equal(results[0].primary, 'DHA Phase 6');
  assert.equal(results[0].city, 'Karachi');
  assert.ok(results.every(result => result.city === 'Karachi'));
});

test('broad search keeps matching cities available without a radius filter', () => {
  const results = searchLocations('DHA', {
    city: 'Karachi',
    lat: 24.7915,
    lng: 67.0648,
    broad: true
  });
  assert.ok(results.some(result => result.city === 'Karachi'));
  assert.ok(results.some(result => result.city === 'Lahore'));
});

test('returns empty results for blank queries without scanning the index', () => {
  assert.deepEqual(searchLocations('   '), []);
});