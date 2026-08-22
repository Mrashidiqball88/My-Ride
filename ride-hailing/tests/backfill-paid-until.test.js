/**
 * Unit tests — back-fill paidUntilDate logic for legacy-paid drivers.
 *
 * Tests the boundary conditions for computeBackfillPaidUntil():
 *   1. Driver paid today UTC          → paidUntilDate set to 23:59:59.999 UTC today
 *   2. Driver paid yesterday UTC      → no back-fill (paidUntilDate stays null)
 *   3. Driver with paidUntilDate set  → back-fill skipped entirely
 *   4. Customer role                  → back-fill never runs
 *
 * Pure-function tests — no database or HTTP server needed.
 *
 * Run:  node --test ride-hailing/tests/backfill-paid-until.test.js
 *   or: cd ride-hailing && npm run test:unit
 */

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const { computeBackfillPaidUntil } = require('../lib/backfillPaidUntil');

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a fake "now" pinned to a specific UTC time so tests are not
 * sensitive to the clock of the machine running them.
 *
 * @param {number} h UTC hour   (0–23)
 * @param {number} m UTC minute (0–59)
 * @param {number} s UTC second (0–59)
 */
function nowAt(h, m, s) {
  const d = new Date('2026-08-15T00:00:00.000Z');   // arbitrary fixed date
  d.setUTCHours(h, m, s, 0);
  return d;
}

/** Midnight UTC on the same fixed date */
const TODAY_MIDNIGHT = new Date('2026-08-15T00:00:00.000Z');

/** 23:59:59.999 UTC on the same fixed date — the expected back-fill target */
const END_OF_TODAY   = new Date('2026-08-15T23:59:59.999Z');

/** Midnight UTC the day before */
const YESTERDAY_MIDNIGHT = new Date('2026-08-14T00:00:00.000Z');

// ── Test 1: driver paid today → back-fill to end-of-day ──────────────────────

test('driver paid today UTC (at midnight) → paidUntilDate set to 23:59:59.999 UTC', () => {
  const user = {
    role:               'driver',
    paidUntilDate:      null,
    lastDailyFeePaidAt: TODAY_MIDNIGHT,   // exactly at today's UTC midnight
  };
  const result = computeBackfillPaidUntil(user, nowAt(12, 0, 0));
  assert.ok(result instanceof Date, 'should return a Date');
  assert.equal(result.toISOString(), END_OF_TODAY.toISOString(),
    'paidUntilDate should be 23:59:59.999 UTC today');
});

test('driver paid today UTC (mid-day) → paidUntilDate set to 23:59:59.999 UTC', () => {
  const user = {
    role:               'driver',
    paidUntilDate:      null,
    lastDailyFeePaidAt: nowAt(10, 30, 0),   // 10:30 AM UTC today
  };
  const result = computeBackfillPaidUntil(user, nowAt(14, 0, 0));
  assert.ok(result instanceof Date, 'should return a Date');
  assert.equal(result.toISOString(), END_OF_TODAY.toISOString(),
    'paidUntilDate should be 23:59:59.999 UTC today');
});

test('driver paid today UTC (one ms before midnight) → paidUntilDate set to 23:59:59.999 UTC', () => {
  // 23:59:59.999 yesterday (i.e. the very last millisecond before today's midnight)
  // is strictly BEFORE today's midnight, so NO back-fill should occur.
  // But 00:00:00.000 today is equal to midnight, so it SHOULD back-fill.
  // This test pins lastDailyFeePaidAt to 23:59:59.999 the same day (late evening).
  const lateToday = new Date('2026-08-15T23:59:59.999Z');
  const user = {
    role:               'driver',
    paidUntilDate:      null,
    lastDailyFeePaidAt: lateToday,
  };
  const result = computeBackfillPaidUntil(user, nowAt(23, 59, 59));
  assert.ok(result instanceof Date, 'should return a Date');
  assert.equal(result.toISOString(), END_OF_TODAY.toISOString());
});

// ── Test 2: driver paid yesterday → no back-fill ─────────────────────────────

test('driver paid yesterday UTC → no back-fill (paidUntilDate stays null)', () => {
  const user = {
    role:               'driver',
    paidUntilDate:      null,
    lastDailyFeePaidAt: YESTERDAY_MIDNIGHT,   // midnight yesterday
  };
  const result = computeBackfillPaidUntil(user, nowAt(9, 0, 0));
  assert.equal(result, null, 'should return null — yesterday\'s payment does not carry over');
});

test('driver paid yesterday UTC (one ms before today) → no back-fill', () => {
  // 23:59:59.999 on 2026-08-14 is 1 ms before today's midnight
  const oneBeforeToday = new Date('2026-08-14T23:59:59.999Z');
  const user = {
    role:               'driver',
    paidUntilDate:      null,
    lastDailyFeePaidAt: oneBeforeToday,
  };
  const result = computeBackfillPaidUntil(user, nowAt(0, 0, 0));
  assert.equal(result, null,
    'payment 1 ms before today\'s midnight must not trigger a back-fill');
});

// ── Test 3: paidUntilDate already set → back-fill skipped ────────────────────

test('driver with paidUntilDate already set → back-fill skipped entirely', () => {
  const existing = new Date('2026-08-15T23:59:59.999Z');
  const user = {
    role:               'driver',
    paidUntilDate:      existing,
    lastDailyFeePaidAt: TODAY_MIDNIGHT,
  };
  const result = computeBackfillPaidUntil(user, nowAt(10, 0, 0));
  assert.equal(result, null,
    'should return null when paidUntilDate is already present');
});

test('driver with future paidUntilDate already set → back-fill skipped', () => {
  const futureDate = new Date('2026-08-20T23:59:59.999Z');
  const user = {
    role:               'driver',
    paidUntilDate:      futureDate,
    lastDailyFeePaidAt: TODAY_MIDNIGHT,
  };
  const result = computeBackfillPaidUntil(user, nowAt(10, 0, 0));
  assert.equal(result, null);
});

// ── Test 4: customer role → back-fill never runs ──────────────────────────────

test('customer role → back-fill never runs, even with lastDailyFeePaidAt set', () => {
  const user = {
    role:               'customer',
    paidUntilDate:      null,
    lastDailyFeePaidAt: TODAY_MIDNIGHT,
  };
  const result = computeBackfillPaidUntil(user, nowAt(10, 0, 0));
  assert.equal(result, null, 'customers are never subject to the daily-fee back-fill');
});

test('customer role with no payment data → back-fill never runs', () => {
  const user = {
    role:               'customer',
    paidUntilDate:      null,
    lastDailyFeePaidAt: null,
  };
  const result = computeBackfillPaidUntil(user, nowAt(10, 0, 0));
  assert.equal(result, null);
});

// ── Edge: driver with no lastDailyFeePaidAt → back-fill never runs ────────────

test('driver with no lastDailyFeePaidAt → back-fill never runs', () => {
  const user = {
    role:               'driver',
    paidUntilDate:      null,
    lastDailyFeePaidAt: null,
  };
  const result = computeBackfillPaidUntil(user, nowAt(10, 0, 0));
  assert.equal(result, null, 'nothing to back-fill from without lastDailyFeePaidAt');
});
