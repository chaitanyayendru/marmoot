/**
 * Itemized bills: reconcile the extracted receipt, split each line among the people
 * who claimed it, then spread tax, service charge and tip in proportion to each
 * person's claimed subtotal. All rounding is largest-remainder, so the per-person
 * totals add up to the printed total to the cent.
 */
import { allocate, assertCents, sumCents, type Cents } from './money.ts';

export interface BillLine {
  id: string;
  name: string;
  quantity: number;
  lineTotal: Cents;
}

export interface Bill {
  lines: BillLine[];
  subtotal: Cents;
  tax: Cents;
  serviceCharge: Cents;
  tip: Cents;
  total: Cents;
  paidBy: string;
}

export interface Claim {
  lineId: string;
  personId: string;
  /** Share weight: 1 each for an even split, or units eaten when quantity > 1. */
  weight: number;
}

/** What to do with lines nobody claimed when the bill closes. */
export type UnclaimedPolicy = 'split-evenly' | 'payer';

export interface PersonShare {
  personId: string;
  items: Cents;
  extras: Cents;
  total: Cents;
}

/** Hard checks run before claiming opens. Returns human-readable problems; empty means OK. */
export function reconcile(bill: Bill): string[] {
  const problems: string[] = [];
  for (const v of [bill.subtotal, bill.tax, bill.serviceCharge, bill.tip, bill.total]) assertCents(v);
  for (const l of bill.lines) assertCents(l.lineTotal, `line ${l.id}`);
  const lineSum = sumCents(bill.lines.map((l) => l.lineTotal));
  if (lineSum !== bill.subtotal) {
    problems.push(`lines add up to ${lineSum} but the receipt subtotal is ${bill.subtotal} (off by ${lineSum - bill.subtotal})`);
  }
  const computed = bill.subtotal + bill.tax + bill.serviceCharge + bill.tip;
  if (computed !== bill.total) {
    problems.push(`subtotal + tax + service + tip = ${computed} but the receipt total is ${bill.total}`);
  }
  return problems;
}

export function computeShares(
  bill: Bill,
  claims: readonly Claim[],
  participants: readonly string[],
  unclaimed: UnclaimedPolicy = 'split-evenly',
): PersonShare[] {
  const problems = reconcile(bill);
  if (problems.length) throw new Error(`bill does not reconcile: ${problems.join('; ')}`);

  const people = new Set(participants);
  people.add(bill.paidBy);
  const items = new Map<string, Cents>([...people].map((p) => [p, 0]));
  const add = (m: Map<string, Cents>) => {
    for (const [p, c] of m) items.set(p, (items.get(p) ?? 0) + c);
  };

  for (const line of bill.lines) {
    const weights = new Map<string, number>();
    for (const c of claims) {
      if (c.lineId !== line.id) continue;
      if (!people.has(c.personId)) throw new Error(`${c.personId} claimed ${line.id} but is not on this bill`);
      weights.set(c.personId, (weights.get(c.personId) ?? 0) + c.weight);
    }
    if (weights.size === 0) {
      if (unclaimed === 'payer') weights.set(bill.paidBy, 1);
      else for (const p of people) weights.set(p, 1);
    }
    add(allocate(line.lineTotal, weights));
  }

  const extrasTotal = bill.tax + bill.serviceCharge + bill.tip;
  const extras = allocate(extrasTotal, new Map(items));
  return [...people]
    .sort()
    .map((p) => {
      const it = items.get(p) ?? 0;
      const ex = extras.get(p) ?? 0;
      return { personId: p, items: it, extras: ex, total: it + ex };
    });
}

/** Ledger view of a finalized bill: payer is owed the total, everyone owes their share. */
export function billNets(bill: Bill, shares: readonly PersonShare[]): Map<string, Cents> {
  const nets = new Map<string, Cents>();
  for (const s of shares) nets.set(s.personId, -s.total);
  nets.set(bill.paidBy, (nets.get(bill.paidBy) ?? 0) + bill.total);
  return nets;
}
