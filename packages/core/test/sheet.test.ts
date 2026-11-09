import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sheetShares, type SheetInput } from '../src/index.ts';

const base = (over: Partial<SheetInput> = {}): SheetInput => ({
  items: [
    { id: 'tomatoes', name: 'Tomatoes', price: 600 },
    { id: 'onions', name: 'Onions', price: 300 },
    { id: 'rice', name: 'Rice', price: 1000 },
  ],
  people: ['chai', 'chandu', 'hima'],
  paidBy: 'chai',
  tax: 190,
  tip: 0,
  defaultIn: true,
  choices: new Map(),
  ...over,
});

test('everyone in by default splits each item evenly and the totals add up', () => {
  const r = sheetShares(base());
  assert.equal(r.total, 2090);
  assert.deepEqual([...r.cells.get('tomatoes')!.values()], [200, 200, 200]);
  const sum = [...r.totals.values()].reduce((s, t) => s + t.total, 0);
  assert.equal(sum, 2090);
});

test('Hima keeps tomatoes but drops onions', () => {
  const r = sheetShares(base({ choices: new Map([['onions', new Map([['hima', false]])]]) }));
  assert.equal(r.cells.get('onions')!.get('hima'), undefined);
  assert.equal(r.cells.get('onions')!.get('chai'), 150);
  assert.equal(r.cells.get('tomatoes')!.get('hima'), 200);
  // Hima: tomatoes 200 + rice 333 or 334 = items; tax follows items.
  const h = r.totals.get('hima')!;
  assert.equal(h.items, 200 + r.cells.get('rice')!.get('hima')!);
  assert.equal([...r.totals.values()].reduce((s, t) => s + t.total, 0), 2090);
});

test('an item nobody is in for falls to the payer; someone out of the whole bill pays nothing', () => {
  const choices = new Map([['onions', new Map([['chai', false], ['chandu', false], ['hima', false]])]]);
  const r = sheetShares(base({ choices, outOfBill: new Set(['chandu']) }));
  assert.deepEqual(r.unclaimed, ['onions']);
  assert.equal(r.cells.get('onions')!.get('chai'), 300);
  assert.deepEqual(r.totals.get('chandu'), { personId: 'chandu', items: 0, extras: 0, total: 0 });
  assert.equal(r.totals.get('chai')!.total + r.totals.get('hima')!.total, 2090);
});

test('opt-in sheets start empty, so everything sits with the payer until people tick', () => {
  const r = sheetShares(base({ defaultIn: false }));
  assert.equal(r.totals.get('chai')!.total, 2090);
  assert.equal(r.unclaimed.length, 3);
});
