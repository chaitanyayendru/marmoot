/**
 * The Apps Script code (Code.gs + Logic.gs) against stand-in Google services,
 * a pretend Gemini and a pretend Splitwise (dev/harness.ts).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeHarness } from '../dev/harness.ts';

const plain = (x: unknown) => JSON.parse(JSON.stringify(x));

function ready() {
  const h = makeHarness('https://script.google.com/macros/s/TEST');
  h.props.set('GEMINI_API_KEY', 'gemini-test-key');
  h.props.set('SPLITWISE_API_KEY', 'splitwise-test-key');
  h.props.set('OWNER_NAME', 'Chai');
  return h;
}

function costco(h: ReturnType<typeof ready>) {
  const boot = h.ctx.ownerBootstrap('dev');
  const group = boot.groups.find((g: { name: string }) => g.name === 'Flat 4B');
  const scanned = h.ctx.scanReceipt('dev', 'aGVsbG8=', 'image/jpeg');
  const created = h.ctx.createBill('dev', {
    title: 'Costco',
    currency: 'USD',
    items: scanned.items,
    tax: scanned.tax,
    tip: scanned.tip,
    members: group.members,
    payerIndex: 0,
    groupId: group.id,
    groupName: group.name,
  });
  return { boot, group, scanned, created };
}

test('the owner page needs the owner key; guests need the bill token', () => {
  const h = ready();
  assert.throws(() => h.ctx.ownerBootstrap('wrong'), /owner link/);
  assert.equal(h.ctx.doGet({ parameter: { owner: 'dev' } }).title, 'Marmoot');
  assert.match(h.ctx.doGet({ parameter: { owner: 'nope' } }).getContent(), /Nothing to see here/);
  assert.match(h.ctx.doGet({ parameter: { b: 'x', t: 'y' } }).getContent(), /Who are you\?/);
  const { created } = costco(h);
  assert.throws(() => h.ctx.guestView(created.sheetId, 'bad-token'), /isn't valid/);
  assert.throws(() => h.ctx.guestView('missing', 'x'), /can't be opened/);
});

test('scan, then a sheet with every box ticked, live formulas, and link sharing', () => {
  const h = ready();
  const { boot, scanned, created } = costco(h);
  assert.equal(boot.me.name, 'Chai Y');
  assert.deepEqual(plain(boot.groups.map((g: { name: string }) => g.name)), ['Flat 4B']);
  assert.deepEqual(plain(scanned.items.map((i: { name: string; price: number }) => [i.name, i.price])), [['Tomatoes', 600], ['Onions', 300], ['Basmati rice 10 lb', 1000], ['Olive oil', 1249]]);
  assert.match(created.message, /Chai Y added a bill: Costco, \$33\.39/);
  assert.ok(created.guestUrl.startsWith('https://script.google.com/macros/s/TEST/exec?b='));
  assert.ok(created.whatsappUrl.startsWith('https://wa.me/?text='));

  const d = h.dump(created.sheetId) as any;
  assert.equal(d.sharing, 'ANYONE_WITH_LINK/EDIT');
  const bill = d.sheets.find((s: { name: string }) => s.name === 'Bill');
  const at = (r: number, c: number) => bill.cells.find((x: { r: number; c: number }) => x.r === r && x.c === c);
  assert.deepEqual([at(3, 1).v, at(3, 2).v, at(3, 3).v, at(3, 5).v, at(3, 6).v, at(3, 7).v], ['Item', 'Price', 'Chai Y', 'Hima K', 'People in', 'Each pays']);
  // 4 items x 3 people, all ticked; Done row unticked.
  for (let r = 5; r <= 8; r++) for (let c = 3; c <= 5; c++) assert.deepEqual([at(r, c).checkbox, at(r, c).v], [true, true], `cell ${r},${c}`);
  for (let c = 3; c <= 5; c++) assert.deepEqual([at(4, c).checkbox, at(4, c).v], [true, false]);
  assert.equal(at(5, 6).f, '=COUNTIF(C5:E5,TRUE)');
  assert.equal(at(5, 7).f, '=IF(F5=0,0,B5/F5)');
  assert.equal(at(10, 1).v, 'Items');
  assert.equal(at(10, 3).f, '=SUMIF(C5:C8,TRUE,$G$5:$G$8)+SUMIF($F$5:$F$8,0,$B$5:$B$8)', 'payer column also carries items nobody kept');
  assert.equal(at(10, 4).f, '=SUMIF(D5:D8,TRUE,$G$5:$G$8)');
  assert.equal(at(13, 4).f, '=D10+D11+D12');
  assert.deepEqual(plain(bill.protection), { description: 'Marmoot: tick boxes only', warningOnly: true, unprotected: [[5, 3, 4, 3], [4, 3, 1, 3]] });
  assert.deepEqual(plain(bill.frozen), { rows: 3, cols: 1 });
  assert.equal(d.sheets.find((s: { name: string }) => s.name === '_marmoot').hidden, true);
});

test('a roommate unticks onions and taps Done; the owner sees it; Splitwise gets exact shares once', () => {
  const h = ready();
  const { created } = costco(h);
  const token = new URL(created.guestUrl).searchParams.get('t')!;
  const hima = 2;
  let v = h.ctx.guestView(created.sheetId, token);
  assert.equal(v.total, 3339);
  // Rice and olive oil don't split evenly in three; the odd cents go by largest remainder.
  assert.deepEqual(plain(v.members.map((m: { total: number }) => m.total)), [1115, 1112, 1112]);
  v = h.ctx.guestToggle(created.sheetId, token, hima, 1, false); // Onions
  v = h.ctx.guestDone(created.sheetId, token, hima, true);
  assert.equal(v.checks[1][hima], false);
  assert.equal(v.cells[1][hima], null);
  assert.equal(v.members[hima].done, true);
  assert.equal(v.members[hima].items, 1049 - 100, 'a third of the onions is off her bill');
  assert.equal(plain(v.members).reduce((t: number, m: { total: number }) => t + m.total, 0), 3339);
  assert.throws(() => h.ctx.guestToggle(created.sheetId, token, 9, 0, false), /Pick your name/);
  assert.throws(() => h.ctx.guestToggle(created.sheetId, token, hima, 9, false), /isn't on the bill/);

  // Chandu wasn't part of it at all.
  h.ctx.guestSetAll(created.sheetId, token, 1, false);
  const s = h.ctx.billStatus('dev', created.sheetId);
  assert.deepEqual(plain(s.members.map((m: { name: string; done: boolean; total: number }) => [m.name, m.done, m.total])), [
    ['Chai Y', false, s.members[0].total],
    ['Chandu', false, 0],
    ['Hima K', true, s.members[2].total],
  ]);
  assert.equal(s.members[0].total + s.members[2].total, 3339);

  const after = h.ctx.addToSplitwise('dev', created.sheetId);
  assert.equal(after.locked, true);
  assert.equal(h.splitwiseExpenses.length, 1);
  const form = h.splitwiseExpenses[0]!;
  assert.equal(form.cost, '33.39');
  assert.equal(form.group_id, '999');
  assert.equal(form.users__0__user_id, '11');
  assert.equal(form.users__0__paid_share, '33.39');
  assert.equal(form.users__1__user_id, '33', 'Chandu owes nothing and is left out');
  assert.equal(form.users__2__user_id, undefined);
  h.ctx.addToSplitwise('dev', created.sheetId);
  assert.equal(h.splitwiseExpenses.length, 1, 'a second tap does not add it twice');
  assert.throws(() => h.ctx.guestToggle(created.sheetId, token, hima, 0, false), /already in Splitwise/);
  assert.equal(plain(h.ctx.ownerBootstrap('dev').bills)[0].title, 'Costco');
});

test('a retired Gemini model is replaced by the one Google names, and remembered', () => {
  const h = ready();
  h.props.set('GEMINI_MODEL', 'gemini-2.5-flash');
  const scanned = h.ctx.scanReceipt('dev', 'aGVsbG8=', 'image/jpeg');
  assert.ok(scanned.items.length > 0);
  assert.equal(h.props.get('GEMINI_MODEL'), 'gemini-3.8-flash');
});

test('settings, bad keys and a broken layout give plain answers', () => {
  const h = ready();
  h.props.set('GEMINI_API_KEY', 'wrong');
  assert.throws(() => h.ctx.scanReceipt('dev', 'aGVsbG8=', 'image/jpeg'), /API key not valid/);
  h.props.set('SPLITWISE_API_KEY', 'wrong');
  assert.match(h.ctx.ownerBootstrap('dev').splitwiseError, /refused the API key/);
  const b = h.ctx.saveSettings('dev', { geminiKey: 'gemini-test-key', splitwiseKey: 'splitwise-test-key', defaultMembers: 'Chandu, Hima ,', appUrl: 'https://x.test/exec?foo=1' });
  assert.equal(b.splitwiseError, null);
  assert.deepEqual(plain(b.defaultMembers), ['Chandu', 'Hima']);
  assert.equal(b.appUrl, 'https://x.test/exec');
  assert.throws(() => h.ctx.createBill('dev', { items: [], members: [{ name: 'A' }] }), /at least one item/);

  const { created } = costco(h);
  const bill = h.spreadsheets.get(created.sheetId)!.getSheetByName('Bill')!;
  bill.getRange(10, 1).setValue('Something else');
  assert.throws(() => h.ctx.billStatus('dev', created.sheetId), /Rows were added or removed/);
});
