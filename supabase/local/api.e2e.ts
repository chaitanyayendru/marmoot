/**
 * The web app's API client against a running local stack (npm run local -- --no-web):
 * a bill sheet from creation to WhatsApp delivery, through real PostgREST.
 *   STACK_URL=http://localhost:54321 ANON_KEY=... node --experimental-strip-types supabase/local/api.e2e.ts
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApi } from '../../apps/web/src/api.ts';
import { sheetTotals } from '../../apps/web/src/sheet.ts';

const url = process.env.STACK_URL ?? 'http://localhost:54321';
const api = createApi(url, process.env.ANON_KEY!);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('a bill sheet end to end through PostgREST and the WhatsApp function', async () => {
  const created = await api.createSheet({
    title: 'Costco',
    people: [{ name: 'Chai', phone: '+14045550100', owner: true }, { name: 'Chandu', phone: '+919845012345' }, { name: 'Hima', phone: '+15550001234' }, { name: 'Ravi' }],
    items: [{ name: 'Tomatoes', price: 600 }, { name: 'Onions', price: 300 }, { name: 'Rice', price: 1000 }],
    tax: 190,
    tip: 0,
    defaultIn: true,
  });
  const owner = created.owner_token;
  const tok = (n: string) => created.people.find((p) => p.name === n)!.token;

  const sent = await api.sendAlerts(owner);
  assert.deepEqual(sent.sent, ['Chandu']);
  assert.equal(sent.failed[0]!.name, 'Hima');
  assert.match(sent.failed[0]!.error, /test number/);
  const inbox = await (await fetch(`${url}/whatsapp/messages`)).json();
  assert.equal(inbox[0].to, '+919845012345');
  assert.match(inbox[0].text, /Chai shared a bill with you: Costco, \$20\.90 in total/);
  assert.equal(inbox[0].token, tok('Chandu'));

  const guest = await api.sheet(tok('Chandu'));
  await api.markViewed(tok('Chandu'));
  const onions = guest.items.find((i) => i.name === 'Onions')!.id;
  await api.setChoice(tok('Chandu'), onions, false);
  await api.markDone(tok('Chandu'));
  await api.setOutOfBill(tok('Ravi'), true);
  await assert.rejects(api.setChoice(tok('Chandu'), onions, false, guest.people.find((p) => p.name === 'Hima')!.id), /only change your own/);
  await assert.rejects(api.addItem(tok('Chandu'), 'Chips', 300), /Only the person who shared/);

  await wait(1600); // the pretend WhatsApp reports delivery after about a second
  const d = await api.sheet(owner);
  const chandu = d.people.find((p) => p.name === 'Chandu')!;
  assert.equal(chandu.alert_status, 'delivered');
  assert.ok(chandu.viewed_at && chandu.responded_at);
  assert.equal(d.people.find((p) => p.name === 'Hima')!.alert_status, 'failed');
  assert.equal(d.people.find((p) => p.name === 'Ravi')!.alert_status, 'no_phone');

  const t = sheetTotals(d);
  const total = (n: string) => t.totals.get(d.people.find((p) => p.name === n)!.id)!.total;
  assert.equal(total('Ravi'), 0);
  assert.equal(total('Chai') + total('Chandu') + total('Hima'), 2090);
  assert.ok(total('Chandu') < total('Hima'), 'Chandu dropped onions, so pays less than Hima');

  await api.close(owner);
  await assert.rejects(api.setChoice(tok('Hima'), onions, false), /closed/);
  await assert.rejects(api.sheet('nope-nope-nope-nope-00'), /not valid/);
});
