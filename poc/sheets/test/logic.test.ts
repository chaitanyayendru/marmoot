import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sheetShares } from '../../../packages/core/src/index.ts';
import { loadGs } from './load.ts';

const L = loadGs(['Logic.gs']);
/** Values from the Apps Script context come from another realm; compare them as plain data. */
const plain = (x: unknown) => JSON.parse(JSON.stringify(x));

function mulberry32(a: number) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('money parsing and formatting', () => {
  assert.equal(L.parseMoney('12.3'), 1230);
  assert.equal(L.parseMoney('$1,234.56'), 123456);
  assert.equal(L.parseMoney(3.49), 349);
  assert.equal(L.parseMoney('-2.00'), -200);
  assert.equal(L.parseMoney('abc'), null);
  assert.equal(L.parseMoney('1.234'), null);
  assert.equal(L.usd(123456789), '$1,234,567.89');
  assert.equal(L.usd(-5), '-$0.05');
  assert.equal(L.centsToDecimal(3339), '33.39');
});

test('computeShares matches sheetShares in @marmoot/core on 500 random bills', () => {
  const rng = mulberry32(1112);
  for (let k = 0; k < 500; k++) {
    const members = Array.from({ length: 1 + Math.floor(rng() * 6) }, (_, j) => ({ id: `m${j}${Math.floor(rng() * 1000)}`, name: `M${j}` }));
    const items = Array.from({ length: Math.floor(rng() * 8) }, (_, i) => ({ id: `i${i}`, name: `Item ${i}`, price: Math.floor(rng() * 3000) }));
    const payerId = members[Math.floor(rng() * members.length)]!.id;
    const tax = rng() < 0.7 ? Math.floor(rng() * 400) : 0;
    const tip = rng() < 0.3 ? Math.floor(rng() * 900) : 0;
    const checks = items.map(() => members.map(() => rng() < 0.7));
    const got = L.computeShares({ items, members, payerId, tax, tip }, checks);

    const choices = new Map(items.map((it, i) => [it.id, new Map(members.map((m, j) => [m.id, checks[i]![j]!]))]));
    const want = sheetShares({ items, people: members.map((m) => m.id), paidBy: payerId, tax, tip, defaultIn: true, choices });
    for (const m of members) {
      const w = want.totals.get(m.id)!;
      assert.deepEqual(
        { items: got.members[m.id].items, extras: got.members[m.id].extras, total: got.members[m.id].total },
        { items: w.items, extras: w.extras, total: w.total },
        `case ${k}, ${m.id}`,
      );
    }
    assert.equal(got.total, want.total);
    assert.deepEqual([...got.unclaimed].map((i: number) => items[i]!.id), want.unclaimed);
  }
});

test('Hima keeps tomatoes and drops onions', () => {
  const bill = {
    items: [{ name: 'Tomatoes', price: 600 }, { name: 'Onions', price: 300 }],
    members: [{ id: 'chai', name: 'Chai' }, { id: 'hima', name: 'Hima' }],
    payerId: 'chai', tax: 90, tip: 0,
  };
  const r = L.computeShares(bill, [[true, true], [true, false]]);
  assert.deepEqual(JSON.parse(JSON.stringify(r.members)), { chai: { items: 600, extras: 60, total: 660 }, hima: { items: 300, extras: 30, total: 330 } });
  assert.deepEqual(JSON.parse(JSON.stringify(r.cells)), [[300, 300], [300, null]]);
});

test('reads a Gemini answer: discounts fold into the item, quantities kept, totals checked', () => {
  const answer = (obj: unknown) => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] });
  const r = L.parseReceiptResponse(answer({
    merchant: 'COSTCO WHOLESALE', currency: 'USD',
    items: [
      { name: 'Tomatoes', price: 6 },
      { name: 'Olive oil', price: 14.99 },
      { name: 'Instant savings', price: -2.5 },
      { name: 'Eggs', quantity: 2, price: '9.98' },
      { name: '', price: 1 },
    ],
    tax: 1.9, tip: 0, total: 30.37,
  }));
  assert.deepEqual(JSON.parse(JSON.stringify(r.items)), [{ name: 'Tomatoes', price: 600 }, { name: 'Olive oil', price: 1249 }, { name: 'Eggs x2', price: 998 }]);
  assert.equal(r.tax, 190);
  assert.deepEqual(plain(r.warnings), []);

  const off = L.parseReceiptResponse(answer({ items: [{ name: 'Rice', price: 10 }], tax: 0, total: 12 }));
  assert.match(off.warnings[0], /add up to \$10\.00 but the receipt says \$12\.00/);
  assert.throws(() => L.parseReceiptResponse({ candidates: [] }), /no answer/);
  assert.throws(() => L.parseReceiptResponse({ promptFeedback: { blockReason: 'SAFETY' } }), /SAFETY/);
  const fenced = L.parseReceiptResponse({ candidates: [{ content: { parts: [{ text: '```json\n{"items":[{"name":"Milk","price":3.5}]}\n```' }] } }] });
  assert.equal(fenced.items[0].price, 350);
});

test('the request asks for JSON with the photo attached', () => {
  const req = L.geminiReceiptRequest('QUJD', 'image/png');
  assert.equal(req.contents[0].parts[1].inlineData.mimeType, 'image/png');
  assert.equal(req.generationConfig.responseMimeType, 'application/json');
  assert.equal(req.generationConfig.responseJsonSchema.properties.items.type, 'array');
  assert.equal('temperature' in req.generationConfig, false);
  assert.deepEqual(plain(L.suggestedModels('models/gemini-2.5-flash is no longer available. Please use models/gemini-3.8-flash.', 'gemini-2.5-flash')), ['gemini-3.8-flash']);
});

test('the Splitwise expense: payer paid it all, everyone owes their total, the sums match', () => {
  const bill = {
    title: 'Costco', currency: 'USD', payerId: 'chai', tax: 190, tip: 0,
    items: [{ name: 'Tomatoes', price: 600 }, { name: 'Onions', price: 300 }, { name: 'Rice', price: 1000 }],
    members: [
      { id: 'chai', name: 'Chai', splitwiseId: 11 },
      { id: 'chandu', name: 'Chandu', splitwiseId: 22 },
      { id: 'hima', name: 'Hima', splitwiseId: 33 },
    ],
  };
  const shares = L.computeShares(bill, [[true, true, true], [true, true, false], [true, false, true]]);
  const f = L.splitwiseExpenseForm(bill, shares, { groupId: 999, details: 'sheet' });
  assert.equal(f.cost, '20.90');
  assert.equal(f.group_id, '999');
  const n = Object.keys(f).filter((k) => k.endsWith('__user_id')).length;
  let paid = 0, owed = 0;
  for (let i = 0; i < n; i++) {
    paid += L.parseMoney(f[`users__${i}__paid_share`]);
    owed += L.parseMoney(f[`users__${i}__owed_share`]);
  }
  assert.equal(paid, 2090);
  assert.equal(owed, 2090);
  assert.equal(f.users__0__user_id, '11');
  assert.equal(f.users__0__paid_share, '20.90');

  const outsider = { ...bill, members: [...bill.members.slice(0, 2), { id: 'hima', name: 'Hima' }] };
  assert.throws(() => L.splitwiseExpenseForm(outsider, shares, { groupId: 1 }), /Hima is not in the Splitwise group/);
  assert.deepEqual(plain(L.splitwiseErrors({ errors: { base: ['Invalid user'], cost: ['must be positive'] } })), ['Invalid user', 'cost must be positive']);
  assert.deepEqual(plain(L.splitwiseErrors({ errors: {} })), []);
});

test('the WhatsApp group message carries both links', () => {
  const text = L.groupMessage('Chai', 'Costco', 3339, 'https://script.google.com/x?b=1&t=2', 'https://docs.google.com/s');
  assert.match(text, /Chai added a bill: Costco, \$33\.39/);
  assert.ok(L.whatsappShareUrl(text).startsWith('https://wa.me/?text=Chai%20added'));
});
