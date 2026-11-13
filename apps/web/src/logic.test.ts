import { describe, expect, it } from 'vitest';
import { applyTransfers } from '@marmoot/core';
import { linkAmount, parseDollars, usd } from './money.ts';
import {
  advance,
  balanceHistory,
  catchUpRecurring,
  gameResult,
  groupNets,
  memberInUse,
  newGame,
  reducer,
  settlePlan,
  transferKey,
  type GameItem,
  type Group,
  type Member,
  type State,
} from './model.ts';
import { payAction } from './payments.ts';
import { parseReceipt, readReceipt, receiptRequest, suggestedModels } from './receipt.ts';
import { groupShareText, sheetTotals, splitwiseText } from './sheet.ts';
import type { SheetData } from './api.ts';
import { sampleGroup } from './sample.ts';
import { expenseText, planText, reminderText, waLink, waNumber } from './whatsapp.ts';

const M = (id: string, handles: Member['handles'] = {}, phone = ''): Member => ({ id, name: id[0]!.toUpperCase() + id.slice(1), phone, handles, cash: false });

function flat(): Group {
  return {
    id: 'g', name: 'Flat 4B', createdAt: 0, me: 'you',
    members: [M('you', { venmo: 'you' }), M('ravi', { venmo: 'ravi' }, '404-555-0101'), M('meera', { venmo: 'meera-s' }, '+44 7700 900123')],
    items: [], recurring: [], due: [],
  };
}

describe('money input', () => {
  it('parses and formats', () => {
    expect(parseDollars('$12.5')).toBe(1250);
    expect(parseDollars('1,250.05')).toBe(125005);
    expect(parseDollars('12.345')).toBeNull();
    expect(usd(-1000)).toBe('−$10.00');
    expect(linkAmount(5)).toBe('0.05');
  });
});

describe('group balances', () => {
  it('adds expenses and payments, and the plan clears everyone', () => {
    let s: State = { groups: [flat()], theme: 'system' };
    s = reducer(s, { type: 'addItem', group: 'g', item: { kind: 'expense', id: 'e1', at: 1, date: '2026-11-01', description: 'Groceries', category: 'groceries', amount: 9000, paidBy: 'you', split: { method: 'equal', among: ['you', 'ravi', 'meera'] } } });
    s = reducer(s, { type: 'addItem', group: 'g', item: { kind: 'expense', id: 'e2', at: 2, date: '2026-11-02', description: 'Power', category: 'utilities', amount: 6000, paidBy: 'ravi', split: { method: 'equal', among: ['you', 'ravi', 'meera'] } } });
    const g = s.groups[0]!;
    expect(Object.fromEntries(groupNets(g))).toEqual({ you: 4000, ravi: 1000, meera: -5000 });
    const plan = settlePlan(g);
    expect(plan.matched).toBe('apps');
    expect(plan.transfers).toHaveLength(2);
    expect([...applyTransfers(groupNets(g), plan.transfers).values()].every((v) => v === 0)).toBe(true);
    expect(balanceHistory(g).map((p) => p.value)).toEqual([6000, 4000]);
  });

  it('a recorded payment moves balances toward zero', () => {
    let s: State = { groups: [flat()], theme: 'system' };
    s = reducer(s, { type: 'addItem', group: 'g', item: { kind: 'expense', id: 'e1', at: 1, date: '2026-11-01', description: 'x', category: 'other', amount: 3000, paidBy: 'you', split: { method: 'equal', among: ['you', 'ravi', 'meera'] } } });
    s = reducer(s, { type: 'addItem', group: 'g', item: { kind: 'payment', id: 'p1', at: 2, date: '2026-11-02', from: 'ravi', to: 'you', amount: 1000 } });
    expect(Object.fromEntries(groupNets(s.groups[0]!))).toEqual({ you: 1000, ravi: 0, meera: -1000 });
  });

  it('will not remove someone who appears in an expense', () => {
    let s: State = { groups: [flat()], theme: 'system' };
    s = reducer(s, { type: 'addItem', group: 'g', item: { kind: 'expense', id: 'e1', at: 1, date: '2026-11-01', description: 'x', category: 'other', amount: 3000, paidBy: 'you', split: { method: 'equal', among: ['you', 'meera'] } } });
    expect(memberInUse(s.groups[0]!, 'meera')).toBe(true);
    expect(memberInUse(s.groups[0]!, 'ravi')).toBe(false);
    s = reducer(s, { type: 'removeMember', group: 'g', member: 'meera' });
    expect(s.groups[0]!.members).toHaveLength(3);
  });

  it('the sample flat balances to zero and settles', () => {
    const g = sampleGroup(0);
    expect([...groupNets(g).values()].reduce((a, b) => a + b, 0)).toBe(0);
    expect(settlePlan(g).transfers.length).toBeLessThanOrEqual(3);
  });
});

describe('recurring bills', () => {
  it('advances by month without overflowing short months', () => {
    expect(advance('2026-01-31', 'month')).toBe('2026-02-28');
    expect(advance('2026-12-15', 'month')).toBe('2027-01-15');
    expect(advance('2026-02-25', 'week')).toBe('2026-03-04');
    // A bill on the 31st goes back to the 31st after February.
    expect(advance('2027-02-28', 'month', 31)).toBe('2027-03-31');
  });

  it('posts fixed bills that fell due and asks for the amount of variable ones', () => {
    const g: Group = {
      ...flat(),
      recurring: [
        { id: 'rent', description: 'Rent', category: 'rent', amount: 300000, paidBy: 'you', split: { method: 'equal', among: ['you', 'ravi', 'meera'] }, every: 'month', next: '2026-10-01' },
        { id: 'power', description: 'Electricity', category: 'utilities', amount: null, paidBy: 'ravi', split: { method: 'equal', among: ['you', 'ravi', 'meera'] }, every: 'month', next: '2026-11-05' },
      ],
    };
    const out = catchUpRecurring(g, '2026-11-08', 0);
    expect(out.items.map((i) => i.date)).toEqual(['2026-10-01', '2026-11-01']);
    // Ids come from the bill and its date, so two phones post the same bill once.
    expect(out.items.map((i) => i.id)).toEqual(['rent@2026-10-01', 'rent@2026-11-01']);
    expect(out.recurring.find((r) => r.id === 'rent')!.next).toBe('2026-12-01');
    expect(out.due).toEqual([{ recurringId: 'power', date: '2026-11-05' }]);
    // Running it again the same day changes nothing.
    expect(catchUpRecurring(out, '2026-11-08', 0)).toBe(out);
    let s: State = { groups: [out], theme: 'system' };
    s = reducer(s, { type: 'resolveDue', group: 'g', recurringId: 'power', date: '2026-11-05', amount: 14388, id: 'p', at: 1 });
    expect(s.groups[0]!.due).toEqual([]);
    expect(s.groups[0]!.items.at(-1)).toMatchObject({ amount: 14388, description: 'Electricity', date: '2026-11-05' });
  });
});

describe('game nights', () => {
  it('count toward balances only once closed', () => {
    const g0 = flat();
    const game: GameItem = { ...newGame(['you', 'ravi'], 2000, 'settle-later', '2026-11-07', 0), id: 'night' };
    let s: State = { groups: [{ ...g0, items: [game] }], theme: 'system' };
    for (const p of ['you', 'ravi']) s = reducer(s, { type: 'updateGame', group: 'g', game: 'night', update: { kind: 'buyIn', player: p, amount: 2000, ids: [`b-${p}`, `c-${p}`], at: 1 } });
    s = reducer(s, { type: 'updateGame', group: 'g', game: 'night', update: { kind: 'cashout', player: 'you', amount: 3000 } });
    s = reducer(s, { type: 'updateGame', group: 'g', game: 'night', update: { kind: 'cashout', player: 'ravi', amount: 1000 } });
    expect(groupNets(s.groups[0]!).get('you')).toBe(0);
    const g = s.groups[0]!.items[0] as GameItem;
    expect(gameResult(g).status).toBe('ready');
    s = reducer(s, { type: 'updateGame', group: 'g', game: 'night', update: { kind: 'close' } });
    expect(Object.fromEntries(groupNets(s.groups[0]!))).toMatchObject({ you: 1000, ravi: -1000 });
  });
});

describe('one-tap WhatsApp', () => {
  it('normalizes numbers for wa.me', () => {
    expect(waNumber('404-555-0101')).toBe('14045550101');
    expect(waNumber('+44 7700 900123')).toBe('447700900123');
    expect(waNumber('0044 7700 900123')).toBe('447700900123');
    expect(waNumber('12345')).toBeNull();
    expect(waLink('hi', '404-555-0101')).toBe('https://wa.me/14045550101?text=hi');
    expect(waLink('hi')).toBe('https://wa.me/?text=hi');
  });

  it('writes a reminder with a pay link that opens Venmo with the amount', () => {
    const g = flat();
    const t = { from: 'ravi', to: 'meera', amount: 5000, rail: 'venmo' };
    expect(reminderText(g, t)).toBe(
      'Hi Ravi, quick reminder from Flat 4B: you owe Meera $50.00.\nPay here, Venmo: https://venmo.com/meera-s?txn=pay&amount=50.00&note=Flat%204B&audience=private',
    );
  });

  it('writes the group plan with a link on every line', () => {
    const text = planText(flat(), [{ from: 'ravi', to: 'meera', amount: 5000, rail: 'venmo' }]);
    expect(text).toContain('Ravi pays Meera $50.00 on Venmo\nhttps://venmo.com/meera-s');
  });

  it('tells the group about a new expense', () => {
    const text = expenseText(flat(), { kind: 'expense', id: 'e', at: 0, date: '2026-11-01', description: 'Costco run', category: 'groceries', amount: 9001, paidBy: 'you', split: { method: 'equal', among: ['you', 'ravi', 'meera'] } });
    expect(text).toBe('You paid $90.01 for Costco run.\nSplit: You $30.00, Ravi $30.00, Meera $30.01.'); // the odd cent goes to the lowest id
  });

  it('builds pay links and keys transfers', () => {
    const t = { from: 'ravi', to: 'meera', amount: 3500, rail: 'paypal' };
    expect(payAction(t, M('meera', { paypal: 'https://paypal.me/MeeraK' }), 'x')).toMatchObject({ href: 'https://paypal.me/MeeraK/35.00' });
    expect(transferKey(t)).toBe('ravi>meera:3500');
  });
});

describe('deleting', () => {
  it('a deleted bill sheet comes off the group, with the expense it added', () => {
    const g: Group = { ...flat(), sheets: [
      { id: 's1', ownerToken: 't', title: 'Costco', category: 'groceries', date: '2026-11-13', createdAt: 1, people: [], expenseId: 'x1' },
      { id: 's2', ownerToken: 't2', title: 'Kroger', category: 'groceries', date: '2026-11-13', createdAt: 1, people: [] },
    ], items: [{ kind: 'expense', id: 'x1', at: 1, date: '2026-11-13', description: 'Costco', category: 'groceries', amount: 900, paidBy: 'you', split: { method: 'equal', among: ['you', 'ravi'] } }] };
    let s: State = { groups: [g], theme: 'system' };
    s = reducer(s, { type: 'removeSheet', group: g.id, sheet: 's1' });
    expect(s.groups[0]!.sheets!.map((x) => x.id)).toEqual(['s2']);
    expect(s.groups[0]!.items).toEqual([]);
    s = reducer(s, { type: 'removeSheet', group: g.id, sheet: 's2' });
    expect(s.groups[0]!.sheets).toEqual([]);
  });
});

describe('receipt scanning', () => {
  const answer = (obj: unknown) => ({ candidates: [{ content: { parts: [{ text: '```json\n' + JSON.stringify(obj) + '\n```' }] } }] });

  it('reads items, folds discounts into the item above and checks the total', () => {
    const r = parseReceipt(
      answer({
        merchant: 'Costco',
        items: [
          { name: 'Tomatoes', price: 4.99 },
          { name: 'Coupon', price: -1 },
          { name: 'Eggs', quantity: 2, price: 9.58 },
          { name: '', price: 3 },
        ],
        tax: 0.8,
        tip: 0,
        total: 14.37,
      }),
    );
    expect(r.merchant).toBe('Costco');
    expect(r.items).toEqual([
      { name: 'Tomatoes', price: 399 },
      { name: 'Eggs x2', price: 958 },
    ]);
    expect(r.tax).toBe(80);
    expect(r.warnings).toEqual([]);
  });

  it('warns when the items do not add up, and explains an empty answer', () => {
    const r = parseReceipt(answer({ items: [{ name: 'Milk', price: '3.49' }], total: 5 }));
    expect(r.items).toEqual([{ name: 'Milk', price: 349 }]);
    expect(r.warnings[0]).toContain('$3.49');
    expect(() => parseReceipt({ promptFeedback: { blockReason: 'SAFETY' } })).toThrow('SAFETY');
    expect(() => parseReceipt({ candidates: [{ content: { parts: [{ text: 'not json' }] } }] })).toThrow("didn't return");
  });

  it('asks Gemini for JSON that follows a schema, with no sampling settings', () => {
    const req = receiptRequest('AAAA', 'image/jpeg');
    expect(req.generationConfig.responseMimeType).toBe('application/json');
    expect(req.generationConfig).not.toHaveProperty('temperature');
    expect(req.generationConfig.responseJsonSchema?.properties.items.type).toBe('array');
    expect(req.contents[0]!.parts[1]).toEqual({ inlineData: { mimeType: 'image/jpeg', data: 'AAAA' } });
    expect(receiptRequest('AAAA', 'image/jpeg', false).generationConfig).not.toHaveProperty('responseJsonSchema');
  });

  // A pretend Gemini: answers per model, and records which models were asked.
  function gemini(answers: Record<string, (body: { generationConfig: Record<string, unknown> }) => [number, unknown]>) {
    const asked: string[] = [];
    const fetchImpl = (async (url: string, init: { body: string; headers: Record<string, string> }) => {
      const model = /models\/([^:]+):/.exec(url)![1]!;
      asked.push(model);
      expect(init.headers['x-goog-api-key']).toBe('k');
      const [status, body] = answers[model]?.(JSON.parse(init.body)) ?? [404, { error: { message: `models/${model} is not found` } }];
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
    return { asked, fetchImpl };
  }
  const okAnswer = (): [number, unknown] => [200, answer({ items: [{ name: 'Milk', price: 3.49 }], total: 3.49 })];

  it("follows Google's replacement when a model is retired for new keys", async () => {
    const g = gemini({
      'gemini-2.5-flash': () => [404, { error: { message: 'This model models/gemini-2.5-flash is no longer available to new users. Please update your code to use models/gemini-9.9-flash for the latest features.' } }],
      'gemini-9.9-flash': okAnswer,
    });
    const r = await readReceipt('AAAA', 'k', g.fetchImpl, 'gemini-2.5-flash');
    expect(r.items).toEqual([{ name: 'Milk', price: 349 }]);
    expect(g.asked).toEqual(['gemini-2.5-flash', 'gemini-9.9-flash']);
    expect(suggestedModels('use models/gemini-3.8-flash. Thanks', 'x')).toEqual(['gemini-3.8-flash']);
  });

  it('moves to Flash-Lite when the free limit is used up, and retries without a schema if one is refused', async () => {
    const g = gemini({
      'gemini-3.8-flash': () => [429, { error: { message: 'Resource exhausted' } }],
      'gemini-3.5-flash-lite': (body) =>
        body.generationConfig.responseJsonSchema ? [400, { error: { message: 'Invalid JSON payload received. Unknown name "responseJsonSchema"' } }] : okAnswer(),
    });
    const r = await readReceipt('AAAA', 'k', g.fetchImpl, null);
    expect(r.items).toHaveLength(1);
    expect(g.asked).toEqual(['gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-3.5-flash-lite']);
  });

  it('explains a bad key and a spent quota in plain words', async () => {
    const bad = gemini({ 'gemini-3.8-flash': () => [400, { error: { message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } }] });
    await expect(readReceipt('AAAA', 'k', bad.fetchImpl, null)).rejects.toThrow("didn't accept this key");
    const spent = gemini({ 'gemini-3.8-flash': () => [429, {}], 'gemini-3.5-flash-lite': () => [429, {}] });
    await expect(readReceipt('AAAA', 'k', spent.fetchImpl, null)).rejects.toThrow('free limit');
  });
});

describe('sharing a bill without subscriptions', () => {
  const data = {
    sheet: { title: 'Costco', note: null, tax_cents: 0, tip_cents: 0, default_in: true, status: 'open' },
    people: [
      { id: 'o', name: 'Chai Y', is_owner: true, token: 'own', out_of_bill: false },
      { id: 'a', name: 'Asha', is_owner: false, token: 'ta', out_of_bill: false },
      { id: 'b', name: 'Ben', is_owner: false, token: 'tb', out_of_bill: false },
      { id: 'c', name: 'Cy', is_owner: false, token: 'tc', out_of_bill: true },
    ],
    items: [
      { id: 'i1', name: 'Tomatoes', price_cents: 600 },
      { id: 'i2', name: 'Onions', price_cents: 400 },
    ],
    choices: [{ item_id: 'i2', person_id: 'a', is_in: false }],
    events: [],
  } as unknown as SheetData;

  it('writes one group message with each person their own link', () => {
    const text = groupShareText(data, sheetTotals(data), (t) => `https://x.test/?s=${t}`);
    expect(text).toContain('Chai shared a bill: Costco, $10.00 (2 items).');
    expect(text).toContain('Asha: https://x.test/?s=ta');
    expect(text).toContain('Ben: https://x.test/?s=tb');
    expect(text).not.toContain('Cy:');
    expect(text).not.toContain('own');
  });

  it('lists exact amounts for Splitwise that add up to the bill', () => {
    const totals = sheetTotals(data);
    const text = splitwiseText(data, totals);
    // Tomatoes split 3 ways (Cy is out), onions between Chai and Ben.
    expect(text).toBe(['Costco: $10.00, paid by Chai Y', 'Split by exact amounts:', 'Chai Y: $4.00', 'Asha: $2.00', 'Ben: $4.00'].join('\n'));
  });
});
