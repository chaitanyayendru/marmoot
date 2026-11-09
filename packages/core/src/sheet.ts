/**
 * Bill sheets: a bill shared item by item, where each person says which items they
 * were part of. Rows are items, columns are people, each cell is in or out.
 *
 * Every cell starts at the sheet's default (usually "in"), and each person flips the
 * items they weren't part of: Hima keeps tomatoes and drops onions. An item's price is
 * split evenly among the people who are in for it. An item nobody is in for falls to
 * the person who paid. Tax and tip are spread in proportion to each person's items.
 * Rounding is largest-remainder throughout, so the totals add up to the bill.
 */
import { computeShares, type Bill, type Claim } from './bill.ts';
import { allocate, assertCents, sumCents, type Cents } from './money.ts';

export interface SheetItem {
  id: string;
  name: string;
  /** What the line cost in total, in cents. */
  price: Cents;
}

export interface SheetInput {
  items: readonly SheetItem[];
  /** Everyone on the sheet, payer included. */
  people: readonly string[];
  paidBy: string;
  tax: Cents;
  tip: Cents;
  /** Cell value when a person hasn't touched it. */
  defaultIn: boolean;
  /** Explicit choices: item id -> person id -> in? */
  choices: ReadonlyMap<string, ReadonlyMap<string, boolean>>;
  /** People who said they weren't part of this bill at all. */
  outOfBill?: ReadonlySet<string>;
}

export interface SheetResult {
  /** item id -> person id -> cents, for every item and every person on it. */
  cells: Map<string, Map<string, Cents>>;
  /** Items nobody is in for; their cost falls to the payer. */
  unclaimed: string[];
  /** Per person: items, their share of tax and tip, and the total. */
  totals: Map<string, { items: Cents; extras: Cents; total: Cents }>;
  subtotal: Cents;
  total: Cents;
}

/** Is this person in for this item, after defaults and "out of the whole bill"? */
export function isIn(input: SheetInput, itemId: string, personId: string): boolean {
  if (input.outOfBill?.has(personId)) return false;
  return input.choices.get(itemId)?.get(personId) ?? input.defaultIn;
}

export function sheetShares(input: SheetInput): SheetResult {
  for (const it of input.items) assertCents(it.price, `price of ${it.name}`);
  assertCents(input.tax, 'tax');
  assertCents(input.tip, 'tip');
  if (!input.people.includes(input.paidBy)) throw new Error('the payer must be on the sheet');

  const subtotal = sumCents(input.items.map((i) => i.price));
  const bill: Bill = {
    lines: input.items.map((i) => ({ id: i.id, name: i.name, quantity: 1, lineTotal: i.price })),
    subtotal,
    tax: input.tax,
    serviceCharge: 0,
    tip: input.tip,
    total: subtotal + input.tax + input.tip,
    paidBy: input.paidBy,
  };

  const claims: Claim[] = [];
  const cells = new Map<string, Map<string, Cents>>();
  const unclaimed: string[] = [];
  for (const it of input.items) {
    const inFor = input.people.filter((p) => isIn(input, it.id, p));
    for (const p of inFor) claims.push({ lineId: it.id, personId: p, weight: 1 });
    if (inFor.length === 0) unclaimed.push(it.id);
    cells.set(it.id, allocate(it.price, new Map((inFor.length ? inFor : [input.paidBy]).map((p) => [p, 1]))));
  }

  const totals = new Map<string, { items: Cents; extras: Cents; total: Cents }>();
  for (const p of input.people) totals.set(p, { items: 0, extras: 0, total: 0 });
  if (subtotal === 0 && input.tax + input.tip > 0) {
    // Nothing itemized yet: the payer carries the extras until items are added.
    totals.set(input.paidBy, { items: 0, extras: input.tax + input.tip, total: input.tax + input.tip });
  } else {
    for (const s of computeShares(bill, claims, input.people, 'payer')) totals.set(s.personId, s);
  }
  return { cells, unclaimed, totals, subtotal, total: bill.total };
}
