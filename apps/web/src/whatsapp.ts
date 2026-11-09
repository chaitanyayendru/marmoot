/**
 * One-tap WhatsApp, at no cost: every message opens in the user's own WhatsApp with
 * the text already written, addressed to the right person when we have their
 * number. Nothing is sent without that one tap. Fully automatic messages need the
 * paid WhatsApp Business API, which waits for Phase 3 of the plan.
 */
import type { Transfer } from '@marmoot/core';
import { splitAmount } from '@marmoot/core';
import { usd } from './money.ts';
import { APP_NAMES, categoryLabel, type ExpenseItem, type Group, type Member, type PayApp } from './model.ts';
import { payAction } from './payments.ts';

/** Digits for wa.me: full international number, no +. Ten digits are read as a US number. */
export function waNumber(phone: string, defaultCountry = '1'): string | null {
  const trimmed = phone.trim();
  const digits = trimmed.replace(/\D/g, '');
  if (trimmed.startsWith('+') || trimmed.startsWith('00')) {
    const d = trimmed.startsWith('00') ? digits.slice(2) : digits;
    return d.length >= 8 && d.length <= 15 ? d : null;
  }
  if (digits.length === 10) return defaultCountry + digits;
  if (digits.length >= 11 && digits.length <= 15) return digits;
  return null;
}

/** Opens a chat with this number, or WhatsApp's chat picker if there is none. */
export function waLink(text: string, phone?: string): string {
  const n = phone ? waNumber(phone) : null;
  return n ? `https://wa.me/${n}?text=${encodeURIComponent(text)}` : `https://wa.me/?text=${encodeURIComponent(text)}`;
}

const nameOf = (g: Group, id: string) => g.members.find((m) => m.id === id)?.name ?? 'Someone';
const first = (name: string) => name.split(/\s+/)[0] ?? name;

/** How the payee can be paid, as one line with a tappable link where the app has one. */
function payLine(t: Transfer, payee: Member, note: string): string | null {
  const a = payAction(t, payee, note);
  if (!a) return null;
  if (a.kind === 'link') return `${APP_NAMES[a.app]}: ${a.href}`;
  if (a.kind === 'copy') return `Zelle: ${a.value}`;
  return 'Cash is fine.';
}

/** A direct reminder to the person who owes. */
export function reminderText(g: Group, t: Transfer): string {
  const payee = g.members.find((m) => m.id === t.to);
  const line = payee ? payLine(t, payee, g.name) : null;
  return [`Hi ${first(nameOf(g, t.from))}, quick reminder from ${g.name}: you owe ${nameOf(g, t.to)} ${usd(t.amount)}.`, line ? `Pay here, ${line}` : null]
    .filter(Boolean)
    .join('\n');
}

/** The whole plan for the group chat, with a pay link on every line. */
export function planText(g: Group, transfers: Transfer[]): string {
  if (transfers.length === 0) return `${g.name}: everyone is settled up.`;
  const lines = transfers.map((t) => {
    const payee = g.members.find((m) => m.id === t.to);
    const line = payee ? payLine(t, payee, g.name) : null;
    const app = t.rail ? ` on ${APP_NAMES[t.rail as PayApp | 'cash']}` : '';
    return `${nameOf(g, t.from)} pays ${nameOf(g, t.to)} ${usd(t.amount)}${app}${line && line.includes('http') ? `\n${line.split(': ')[1]}` : ''}`;
  });
  return `${g.name}: settle up\n\n${lines.join('\n\n')}`;
}

/** Posted after adding an expense, so nobody is surprised by it. */
export function expenseText(g: Group, e: ExpenseItem): string {
  const shares = splitAmount(e.amount, e.split);
  const parts = [...shares].map(([id, c]) => `${first(nameOf(g, id))} ${usd(c)}`).join(', ');
  const what = e.description.trim() || categoryLabel(e.category);
  return `${nameOf(g, e.paidBy)} paid ${usd(e.amount)} for ${what}.\nSplit: ${parts}.`;
}
