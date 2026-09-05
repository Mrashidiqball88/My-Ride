'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const webDriver = fs.readFileSync(require.resolve('../public/driver.html'), 'utf8');
const nativeRuntime = fs.readFileSync(require.resolve('../../artifacts/myride-driver-mobile/context/DriverRuntime.tsx'), 'utf8');
const nativeHome = fs.readFileSync(require.resolve('../../artifacts/myride-driver-mobile/app/index.tsx'), 'utf8');

test('web Driver expandable control exposes authoritative online-time and fee countdown cards', () => {
  assert.match(webDriver, /id="online-time-value"/);
  assert.match(webDriver, /id="next-fee-value"/);
  assert.match(webDriver, /apiCall\(['"]\/api\/driver\/availability['"], ['"]POST['"]/);
  assert.match(webDriver, /user\.onlineStartedAt/);
  assert.match(webDriver, /user\.nextFeeDeductionAt/);
});

test('native Driver availability UI exposes online-time and next-fee fields', () => {
  assert.match(nativeRuntime, /onlineStartedAt\?: string \| Date \| null/);
  assert.match(nativeRuntime, /nextFeeDeductionAt\?: string \| Date \| null/);
  assert.match(nativeHome, /Today's Online Time/);
  assert.match(nativeHome, /Next Fee Deduction/);
  assert.match(nativeHome, /testID="driver-online-time"/);
  assert.match(nativeHome, /testID="driver-next-fee"/);
});