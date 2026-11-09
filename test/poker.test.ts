import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DiscrepancyTooLarge, settlePokerNight, type PokerEvent } from '../src/poker.ts';
import { sumCents } from '../src/money.ts';

test('nets are cash-outs minus buy-ins, cash at the table moves the debt to the host', () => {
  const ev: PokerEvent[] = [
    { kind: 'buyin', player: 'ana', amount: 2000 },
    { kind: 'buyin', player: 'ben', amount: 2000 },
    { kind: 'cash', from: 'ana', to: 'host', amount: 2000 },
    { kind: 'buyin', player: 'host', amount: 2000 },
    { kind: 'cashout', player: 'ana', amount: 3500 },
    { kind: 'cashout', player: 'ben', amount: 500 },
    { kind: 'cashout', player: 'host', amount: 2000 },
  ];
  const r = settlePokerNight(ev);
  assert.equal(r.nets.get('ana'), 3500); // won 1500, and already paid 2000 in cash
  assert.equal(r.nets.get('ben'), -1500);
  assert.equal(r.nets.get('host'), -2000); // broke even, but holds Ana's 2000 cash
  assert.equal(sumCents(r.nets.values()), 0);
});

test('small discrepancy is spread by buy-in share', () => {
  const ev: PokerEvent[] = [
    { kind: 'buyin', player: 'a', amount: 10000 },
    { kind: 'buyin', player: 'b', amount: 30000 },
    { kind: 'cashout', player: 'a', amount: 20200 },
    { kind: 'cashout', player: 'b', amount: 20000 },
  ];
  const r = settlePokerNight(ev); // 200 cents too many chips counted, tolerance is 400
  assert.equal(r.discrepancy, 200);
  assert.equal(r.lines.find((l) => l.player === 'a')!.adjustment, -50);
  assert.equal(r.lines.find((l) => l.player === 'b')!.adjustment, -150);
  assert.equal(sumCents(r.nets.values()), 0);
});

test('large discrepancy blocks settlement', () => {
  const ev: PokerEvent[] = [
    { kind: 'buyin', player: 'a', amount: 2000 },
    { kind: 'cashout', player: 'a', amount: 2500 },
  ];
  assert.throws(() => settlePokerNight(ev), DiscrepancyTooLarge);
});
