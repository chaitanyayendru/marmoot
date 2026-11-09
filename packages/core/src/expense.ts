/**
 * Everyday shared expenses: groceries, utilities, rent, dinners, trips.
 *
 * One person pays; the cost is split among some or all of the group in one of four
 * ways. Every split rounds with the largest-remainder rule, so the shares always add
 * up to the amount paid, to the cent.
 */
import { allocate, assertCents, sumCents, type Cents } from './money.ts';

export type Split =
  /** Same share for everyone listed. */
  | { method: 'equal'; among: string[] }
  /** Exact amounts that must add up to the total. */
  | { method: 'exact'; amounts: Record<string, Cents> }
  /** Percentages in basis points (100% = 10000) that must add up to 10000. */
  | { method: 'percent'; basisPoints: Record<string, number> }
  /** Whole-number shares, e.g. 2 for a couple and 1 for everyone else. */
  | { method: 'shares'; shares: Record<string, number> };

export class SplitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SplitError';
  }
}

/** Who owes what for one expense. Throws SplitError with a message a person can act on. */
export function splitAmount(total: Cents, split: Split): Map<string, Cents> {
  assertCents(total, 'amount');
  if (total <= 0) throw new SplitError('Enter an amount above zero.');

  switch (split.method) {
    case 'equal': {
      const among = [...new Set(split.among)];
      if (among.length === 0) throw new SplitError('Choose at least one person to split with.');
      return allocate(total, new Map(among.map((id) => [id, 1])));
    }
    case 'exact': {
      const entries = Object.entries(split.amounts).filter(([, v]) => v !== 0);
      for (const [, v] of entries) {
        if (!Number.isSafeInteger(v) || v < 0) throw new SplitError('Amounts must be zero or more.');
      }
      const assigned = sumCents(entries.map(([, v]) => v));
      if (assigned !== total) {
        const diff = total - assigned;
        throw new SplitError(diff > 0 ? `${fmt(diff)} still to assign.` : `${fmt(-diff)} over the total.`);
      }
      return new Map(entries);
    }
    case 'percent': {
      const entries = Object.entries(split.basisPoints).filter(([, v]) => v !== 0);
      for (const [, v] of entries) {
        if (!Number.isSafeInteger(v) || v < 0) throw new SplitError('Percentages must be zero or more, to two decimals.');
      }
      const sum = entries.reduce((s, [, v]) => s + v, 0);
      if (sum !== 10000) throw new SplitError(`Percentages add up to ${(sum / 100).toFixed(2).replace(/\.00$/, '')}%, not 100%.`);
      return allocate(total, new Map(entries));
    }
    case 'shares': {
      const entries = Object.entries(split.shares).filter(([, v]) => v !== 0);
      for (const [, v] of entries) {
        if (!Number.isSafeInteger(v) || v < 0) throw new SplitError('Shares must be whole numbers.');
      }
      if (entries.length === 0) throw new SplitError('Give at least one person a share.');
      return allocate(total, new Map(entries));
    }
  }
}

/** Ledger view of one expense: the payer is owed the total, each person owes their share. */
export function expenseNets(paidBy: string, total: Cents, split: Split): Map<string, Cents> {
  const nets = new Map<string, Cents>();
  for (const [id, share] of splitAmount(total, split)) nets.set(id, -share);
  nets.set(paidBy, (nets.get(paidBy) ?? 0) + total);
  return nets;
}

/** Ledger view of a payment between two people: the payer's debt shrinks, the payee's credit shrinks. */
export function paymentNets(from: string, to: string, amount: Cents): Map<string, Cents> {
  assertCents(amount);
  if (from === to) throw new Error('a payment needs two different people');
  return new Map([
    [from, amount],
    [to, -amount],
  ]);
}

/** Add several ledgers together. */
export function sumNets(parts: Iterable<ReadonlyMap<string, Cents>>): Map<string, Cents> {
  const out = new Map<string, Cents>();
  for (const p of parts) for (const [k, v] of p) out.set(k, (out.get(k) ?? 0) + v);
  return out;
}

function fmt(c: Cents): string {
  return `$${Math.floor(c / 100)}.${String(c % 100).padStart(2, '0')}`;
}
