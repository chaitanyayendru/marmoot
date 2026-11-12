/**
 * Writes a bill sheet made by Code.gs (in the stand-in services) to JSON, with the
 * amounts Logic.gs works out for the same ticks, so check-formulas.py can recalculate
 * the sheet's formulas in LibreOffice and compare. Run: npm run poc:formulas
 */
import { writeFileSync } from 'node:fs';
import { makeHarness } from '../dev/harness.ts';

const h = makeHarness('https://script.google.com/macros/s/TEST');
h.props.set('GEMINI_API_KEY', 'gemini-test-key');
h.props.set('SPLITWISE_API_KEY', 'splitwise-test-key');
const group = h.ctx.ownerBootstrap('dev').groups[0];
const scanned = h.ctx.scanReceipt('dev', 'aGVsbG8=', 'image/jpeg');
const created = h.ctx.createBill('dev', { title: 'Costco', items: scanned.items, tax: scanned.tax, tip: 450, members: group.members, payerIndex: 1, groupId: group.id });
const token = new URL(created.guestUrl).searchParams.get('t')!;
h.ctx.guestToggle(created.sheetId, token, 2, 1, false); // Hima: no onions
h.ctx.guestSetAll(created.sheetId, token, 0, false); // Chai: not part of it
for (let j = 1; j < 3; j++) h.ctx.guestToggle(created.sheetId, token, j, 3, false); // olive oil: nobody, so the payer (Chandu) covers it
const status = h.ctx.billStatus('dev', created.sheetId);
const out = {
  sheet: h.dump(created.sheetId),
  expected: status.members.map((m: { name: string; total: number }) => ({ name: m.name, total: m.total })),
  total: status.total,
};
writeFileSync(process.argv[2] ?? '/tmp/marmoot-bill.json', JSON.stringify(out));
console.log('wrote', process.argv[2] ?? '/tmp/marmoot-bill.json', JSON.stringify(out.expected));
