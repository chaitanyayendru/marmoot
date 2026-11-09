import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allocate, sumCents } from '../src/money.ts';

test('largest remainder: $10.00 three ways is 334/333/333', () => {
  const r = allocate(1000, new Map([['a', 1], ['b', 1], ['c', 1]]));
  assert.deepEqual([...r.values()], [334, 333, 333]);
});

test('allocation always sums to the total, including negatives', () => {
  for (const total of [1, 7, 999, -1001, 123456789]) {
    const r = allocate(total, new Map([['x', 3], ['y', 7], ['z', 11], ['w', 0]]));
    assert.equal(sumCents(r.values()), total);
    assert.equal(r.get('w'), 0);
  }
});

test('allocation is deterministic regardless of map insertion order', () => {
  const a = allocate(100, new Map([['b', 1], ['a', 1], ['c', 1]]));
  const b = allocate(100, new Map([['c', 1], ['a', 1], ['b', 1]]));
  assert.equal(a.get('a'), b.get('a'));
  assert.equal(a.get('a'), 34);
});

test('never returns negative zero', () => {
  // -1 cent across two people: one pays it, the other gets 0, not -0.
  const r = allocate(-1, new Map([['a', 1], ['b', 1]]));
  assert.ok(Object.is(r.get('b'), 0));
  assert.equal(r.get('a'), -1);
});

test('rejects fractional cents', () => {
  assert.throws(() => allocate(10.5, new Map([['a', 1]])));
});
