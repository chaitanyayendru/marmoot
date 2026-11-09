import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SplitError, expenseNets, paymentNets, splitAmount, sumNets } from '../src/expense.ts';
import { minTransferSettle } from '../src/settle.ts';
import { sumCents } from '../src/money.ts';

const obj = (m: Map<string, number>) => Object.fromEntries(m);

test('equal split rounds to the cent and adds up', () => {
  // $86.41 of groceries across 4 flatmates
  const m = splitAmount(8641, { method: 'equal', among: ['a', 'b', 'c', 'd'] });
  assert.deepEqual(obj(m), { a: 2161, b: 2160, c: 2160, d: 2160 });
  assert.equal(sumCents(m.values()), 8641);
});

test('exact split must add up, with a message that says by how much', () => {
  assert.deepEqual(obj(splitAmount(10000, { method: 'exact', amounts: { a: 6000, b: 4000 } })), { a: 6000, b: 4000 });
  assert.throws(() => splitAmount(10000, { method: 'exact', amounts: { a: 6000, b: 3580 } }), /\$4\.20 still to assign/);
  assert.throws(() => splitAmount(10000, { method: 'exact', amounts: { a: 6000, b: 4500 } }), /\$5\.00 over the total/);
});

test('percent split: rent 40/30/30 on $2,450', () => {
  const m = splitAmount(245000, { method: 'percent', basisPoints: { a: 4000, b: 3000, c: 3000 } });
  assert.deepEqual(obj(m), { a: 98000, b: 73500, c: 73500 });
  assert.throws(() => splitAmount(245000, { method: 'percent', basisPoints: { a: 4000, b: 3000 } }), /add up to 70%/);
});

test('shares split: a couple counts as 2', () => {
  // $180 electricity, couple in one room counts twice
  const m = splitAmount(18000, { method: 'shares', shares: { couple: 2, b: 1, c: 1 } });
  assert.deepEqual(obj(m), { couple: 9000, b: 4500, c: 4500 });
});

test('rejects nonsense', () => {
  assert.throws(() => splitAmount(0, { method: 'equal', among: ['a'] }), SplitError);
  assert.throws(() => splitAmount(100, { method: 'equal', among: [] }), /at least one/);
  assert.throws(() => splitAmount(100, { method: 'shares', shares: { a: 1.5 } }), /whole numbers/);
});

test('a month of a shared flat settles in the fewest payments', () => {
  const rent = expenseNets('a', 245000, { method: 'percent', basisPoints: { a: 4000, b: 3000, c: 3000 } });
  const power = expenseNets('b', 18000, { method: 'equal', among: ['a', 'b', 'c'] });
  const groceries = expenseNets('c', 8641, { method: 'equal', among: ['a', 'b', 'c'] });
  const paidBack = paymentNets('b', 'a', 50000);
  const nets = sumNets([rent, power, groceries, paidBack]);
  assert.equal(sumCents(nets.values()), 0);
  const plan = minTransferSettle(nets);
  assert.ok(plan.transfers.length <= 2);
  const after = sumNets([nets, ...plan.transfers.map((t) => paymentNets(t.from, t.to, t.amount))]);
  assert.ok([...after.values()].every((v) => v === 0));
});
