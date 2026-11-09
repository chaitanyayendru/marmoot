import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dueDates, nextDue } from '../src/index.ts';

test('a bill on the 31st lands on the last day of short months and comes back', () => {
  assert.deepEqual(dueDates('2027-01-31', '2027-06-30', 'month'), ['2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30', '2027-05-31', '2027-06-30']);
  assert.equal(nextDue('2028-01-30', 'month'), '2028-02-29');
  assert.equal(nextDue('2028-02-29', 'month', 30), '2028-03-30');
});

test('weeks and year ends', () => {
  assert.equal(nextDue('2026-12-29', 'week'), '2027-01-05');
  assert.equal(nextDue('2026-12-15', 'month'), '2027-01-15');
  assert.deepEqual(dueDates('2026-11-01', '2026-10-01', 'week'), []);
});

test('catching up stops at the limit', () => {
  assert.equal(dueDates('2020-01-01', '2026-01-01', 'week', undefined, 24).length, 24);
});
