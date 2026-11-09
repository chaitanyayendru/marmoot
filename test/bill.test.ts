import { test } from 'node:test';
import assert from 'node:assert/strict';
import { billNets, computeShares, reconcile, type Bill } from '../src/bill.ts';
import { sumCents } from '../src/money.ts';

const bill: Bill = {
  paidBy: 'chai',
  lines: [
    { id: 'l1', name: 'Chicken tikka masala', quantity: 1, lineTotal: 1895 },
    { id: 'l2', name: 'Garlic naan', quantity: 3, lineTotal: 1200 },
    { id: 'l3', name: 'Kingfisher', quantity: 2, lineTotal: 1400 },
    { id: 'l4', name: 'Mango lassi', quantity: 1, lineTotal: 650 },
  ],
  subtotal: 5145,
  tax: 457,
  serviceCharge: 0,
  tip: 1029,
  total: 6631,
};

test('reconcile flags lines that do not add up', () => {
  assert.deepEqual(reconcile(bill), []);
  const bad = { ...bill, subtotal: 5154 };
  assert.equal(reconcile(bad).length, 2);
});

test('shares add up to the receipt total to the cent', () => {
  const shares = computeShares(
    bill,
    [
      { lineId: 'l1', personId: 'ravi', weight: 1 },
      { lineId: 'l2', personId: 'ravi', weight: 1 },
      { lineId: 'l2', personId: 'meera', weight: 2 }, // ate two of the three naan
      { lineId: 'l3', personId: 'chai', weight: 1 },
      { lineId: 'l3', personId: 'ravi', weight: 1 },
    ],
    ['chai', 'ravi', 'meera'],
  );
  assert.equal(sumCents(shares.map((s) => s.total)), bill.total);
  const meera = shares.find((s) => s.personId === 'meera')!;
  // two naan (800) + a third of the unclaimed lassi (217, largest remainder)
  assert.equal(meera.items, 800 + 217);
  const nets = billNets(bill, shares);
  assert.equal(sumCents(nets.values()), 0);
  assert.ok(nets.get('chai')! > 0);
});
