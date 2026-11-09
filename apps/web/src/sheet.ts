/**
 * Bill sheet logic shared by the owner's grid and the guest page: turning the
 * server's view into totals, plain-words statuses and the activity list, and closing
 * a sheet into a group expense.
 */
import { sheetShares, type SheetInput, type SheetResult } from '@marmoot/core';
import type { SheetData, SheetEvent, SheetPerson } from './api.ts';
import type { ExpenseItem, SheetRef } from './model.ts';
import { waNumber } from './whatsapp.ts';

export function sheetInput(d: SheetData): SheetInput {
  const owner = d.people.find((p) => p.is_owner)!;
  const choices = new Map<string, Map<string, boolean>>();
  for (const c of d.choices) {
    if (!choices.has(c.item_id)) choices.set(c.item_id, new Map());
    choices.get(c.item_id)!.set(c.person_id, c.is_in);
  }
  return {
    items: d.items.map((i) => ({ id: i.id, name: i.name, price: Number(i.price_cents) })),
    people: d.people.map((p) => p.id),
    paidBy: owner.id,
    tax: Number(d.sheet.tax_cents),
    tip: Number(d.sheet.tip_cents),
    defaultIn: d.sheet.default_in,
    choices,
    outOfBill: new Set(d.people.filter((p) => p.out_of_bill).map((p) => p.id)),
  };
}

export function sheetTotals(d: SheetData): SheetResult {
  return sheetShares(sheetInput(d));
}

/** Where a person is with the sheet, in words. */
export function responseStatus(p: SheetPerson): { label: string; tone: 'done' | 'out' | 'seen' | 'waiting' | 'owner' } {
  if (p.is_owner) return { label: 'Paid', tone: 'owner' };
  if (p.out_of_bill) return { label: 'Not part of it', tone: 'out' };
  if (p.responded_at) return { label: 'Done', tone: 'done' };
  if (p.viewed_at) return { label: 'Opened', tone: 'seen' };
  return { label: 'Waiting', tone: 'waiting' };
}

/** What happened to the WhatsApp message, for the owner. */
export function messageStatus(p: SheetPerson): string | null {
  if (p.is_owner) return null;
  switch (p.alert_status) {
    case 'queued': return 'Sending';
    case 'sent': return 'Message sent';
    case 'delivered': return 'Delivered';
    case 'read': return 'Read';
    case 'failed': return 'Not delivered';
    case 'no_phone': return 'No WhatsApp number';
    default: return p.has_phone ? 'Not sent yet' : 'No WhatsApp number';
  }
}

const first = (name: string) => name.split(/\s+/)[0] ?? name;

/** One line of the activity list, or null for events not worth showing. */
export function eventText(e: SheetEvent, d: SheetData): string | null {
  const who = (id: string | null) => first(d.people.find((p) => p.id === id)?.name ?? 'Someone');
  const self = e.actor_id === e.person_id;
  const item = e.detail ?? 'an item';
  switch (e.kind) {
    case 'created': return `${who(e.actor_id)} started the bill`;
    case 'viewed': return `${who(e.person_id)} opened it`;
    case 'in': return self ? `${who(e.person_id)}: in for ${item}` : `${who(e.actor_id)} put ${who(e.person_id)} in for ${item}`;
    case 'out': return self ? `${who(e.person_id)}: out of ${item}` : `${who(e.actor_id)} took ${who(e.person_id)} out of ${item}`;
    case 'all_out': return `${who(e.person_id)}: not part of this bill`;
    case 'back_in': return `${who(e.person_id)} is back in`;
    case 'done': return `${who(e.person_id)} finished choosing`;
    case 'item_added': return `${who(e.actor_id)} added ${item}`;
    case 'item_changed': return `${who(e.actor_id)} changed ${item}`;
    case 'item_removed': return `${who(e.actor_id)} removed ${item}`;
    case 'person_added': return `${who(e.actor_id)} added ${e.detail ?? who(e.person_id)}`;
    case 'sheet_changed': return `${who(e.actor_id)} changed the bill details`;
    case 'alert_sent': return `WhatsApp message to ${who(e.person_id)} sent`;
    case 'alert_delivered': return `WhatsApp message delivered to ${who(e.person_id)}`;
    case 'alert_read': return `${who(e.person_id)} read the WhatsApp message`;
    case 'alert_failed': return `WhatsApp message to ${who(e.person_id)} failed${e.detail ? `: ${e.detail}` : ''}`;
    case 'closed': return `${who(e.actor_id)} closed the bill`;
    case 'reopened': return `${who(e.actor_id)} reopened the bill`;
    default: return null;
  }
}

/** A phone number the server accepts (+ and digits), or null. */
export function e164(phone: string | undefined): string | null {
  const n = phone ? waNumber(phone) : null;
  return n ? `+${n}` : null;
}

/** The expense a closed sheet becomes: you paid, everyone owes exactly their total. */
export function sheetExpense(ref: SheetRef, d: SheetData, totals: SheetResult, id: string, now: number): ExpenseItem | null {
  if (totals.total <= 0) return null;
  const amounts: Record<string, number> = {};
  for (const { personId, memberId } of ref.people) {
    const t = totals.totals.get(personId)?.total ?? 0;
    if (t > 0) amounts[memberId] = (amounts[memberId] ?? 0) + t;
  }
  const owner = ref.people.find((p) => p.personId === d.people.find((x) => x.is_owner)?.id);
  if (!owner) return null;
  return {
    kind: 'expense',
    id,
    at: now,
    date: ref.date,
    description: d.sheet.title,
    category: ref.category,
    amount: totals.total,
    paidBy: owner.memberId,
    split: { method: 'exact', amounts },
  };
}
