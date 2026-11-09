/** A sample shared flat, so a first-time visitor can see how a month looks before adding their own. */
import { advance, newId, type Group, type Member } from './model.ts';

function daysAgo(n: number, from = new Date()): string {
  const d = new Date(from);
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function sampleGroup(now = Date.now()): Group {
  const m = (name: string, phone: string, handles: Member['handles']): Member => ({ id: newId(), name, phone, handles, cash: false });
  const you = m('You', '', { venmo: 'you-venmo', zelle: 'you@example.com' });
  const ravi = m('Ravi', '+1 404 555 0101', { venmo: 'ravi-k' });
  const meera = m('Meera', '+1 404 555 0102', { venmo: 'meera-s', zelle: 'meera@example.com' });
  const sana = m('Sana', '+1 404 555 0103', { zelle: 'sana@example.com' });
  const all = [you.id, ravi.id, meera.id, sana.id];
  const at = now - 1000;
  const rentId = newId();
  const powerId = newId();
  const rentDate = daysAgo(20);
  return {
    id: newId(),
    name: 'Flat 4B (sample)',
    createdAt: now,
    me: you.id,
    members: [you, ravi, meera, sana],
    items: [
      { kind: 'expense', id: newId(), at, date: rentDate, description: 'November rent', category: 'rent', amount: 320000, paidBy: you.id, split: { method: 'percent', basisPoints: { [you.id]: 3000, [ravi.id]: 2500, [meera.id]: 2500, [sana.id]: 2000 } }, recurringId: rentId },
      { kind: 'expense', id: newId(), at, date: daysAgo(18), description: 'Costco run', category: 'groceries', amount: 18642, paidBy: meera.id, split: { method: 'equal', among: all } },
      { kind: 'expense', id: newId(), at, date: daysAgo(12), description: 'Electricity, October', category: 'utilities', amount: 14388, paidBy: ravi.id, split: { method: 'equal', among: all }, recurringId: powerId },
      { kind: 'expense', id: newId(), at, date: daysAgo(9), description: 'Internet', category: 'utilities', amount: 7000, paidBy: sana.id, split: { method: 'equal', among: all } },
      { kind: 'payment', id: newId(), at, date: daysAgo(7), from: ravi.id, to: you.id, amount: 50000, rail: 'venmo' },
      { kind: 'expense', id: newId(), at, date: daysAgo(4), description: 'Trader Joe’s', category: 'groceries', amount: 6417, paidBy: you.id, split: { method: 'shares', shares: { [you.id]: 1, [ravi.id]: 1, [meera.id]: 2 } } },
      { kind: 'expense', id: newId(), at, date: daysAgo(2), description: 'Thai takeout', category: 'dining', amount: 8450, paidBy: sana.id, split: { method: 'exact', amounts: { [you.id]: 2250, [meera.id]: 3100, [sana.id]: 3100 } } },
    ],
    recurring: [
      { id: rentId, description: 'Rent', category: 'rent', amount: 320000, paidBy: you.id, split: { method: 'percent', basisPoints: { [you.id]: 3000, [ravi.id]: 2500, [meera.id]: 2500, [sana.id]: 2000 } }, every: 'month', next: advance(rentDate, 'month'), day: Number(rentDate.slice(8, 10)) },
      { id: powerId, description: 'Electricity', category: 'utilities', amount: null, paidBy: ravi.id, split: { method: 'equal', among: all }, every: 'month', next: advance(daysAgo(0), 'month'), day: Number(daysAgo(0).slice(8, 10)) },
    ],
    // This month's power bill has just come in and is waiting for its amount.
    due: [{ recurringId: powerId, date: daysAgo(0) }],
  };
}
