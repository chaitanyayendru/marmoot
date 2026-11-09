/**
 * Poker night as a ledger. Chips in play sit in a POT account.
 *
 *   buy-in / rebuy of X      player -X, POT +X
 *   cash handed over         payer  +X, receiver -X   (e.g. paying the host in cash)
 *   cash-out of chips = Y    POT -Y, player +Y
 *
 * A player's net = cash-outs - buy-ins + cash given - cash received.
 * The night settles only when POT returns to zero; a small chip-count discrepancy
 * is spread across players in proportion to their buy-ins, a large one blocks.
 */
import { allocate, assertCents, sumCents, type Cents } from './money.ts';

export type PokerEvent =
  | { kind: 'buyin'; player: string; amount: Cents }
  | { kind: 'cash'; from: string; to: string; amount: Cents }
  | { kind: 'cashout'; player: string; amount: Cents };

export interface PokerOptions {
  /** Largest |discrepancy| tolerated, as a fraction of total buy-ins. Default 0.01. */
  discrepancyTolerance?: number;
}

export interface PlayerLine {
  player: string;
  buyins: Cents;
  cashouts: Cents;
  cashGiven: Cents;
  cashReceived: Cents;
  adjustment: Cents;
  net: Cents;
}

export interface PokerResult {
  lines: PlayerLine[];
  nets: Map<string, Cents>;
  totalBuyins: Cents;
  totalCashouts: Cents;
  /** cash-outs minus buy-ins before adjustment; positive = more chips counted than bought. */
  discrepancy: Cents;
}

export class DiscrepancyTooLarge extends Error {
  readonly discrepancy: Cents;
  readonly limit: Cents;
  constructor(discrepancy: Cents, limit: Cents) {
    super(`chip count is off by ${discrepancy} cents, more than the ${limit} cent tolerance; recount before settling`);
    this.name = 'DiscrepancyTooLarge';
    this.discrepancy = discrepancy;
    this.limit = limit;
  }
}

export function settlePokerNight(events: readonly PokerEvent[], opts: PokerOptions = {}): PokerResult {
  const line = new Map<string, PlayerLine>();
  const get = (p: string): PlayerLine => {
    let l = line.get(p);
    if (!l) {
      l = { player: p, buyins: 0, cashouts: 0, cashGiven: 0, cashReceived: 0, adjustment: 0, net: 0 };
      line.set(p, l);
    }
    return l;
  };

  for (const e of events) {
    assertCents(e.amount);
    if (e.amount < 0) throw new Error(`${e.kind} amount must be non-negative`);
    if (e.kind === 'buyin') get(e.player).buyins += e.amount;
    else if (e.kind === 'cashout') get(e.player).cashouts += e.amount;
    else {
      if (e.from === e.to) throw new Error('cash transfer needs two different people');
      get(e.from).cashGiven += e.amount;
      get(e.to).cashReceived += e.amount;
    }
  }

  const lines = [...line.values()].sort((a, b) => (a.player < b.player ? -1 : 1));
  const totalBuyins = sumCents(lines.map((l) => l.buyins));
  const totalCashouts = sumCents(lines.map((l) => l.cashouts));
  const discrepancy = totalCashouts - totalBuyins;

  if (discrepancy !== 0) {
    const limit = Math.floor(totalBuyins * (opts.discrepancyTolerance ?? 0.01));
    if (Math.abs(discrepancy) > limit) throw new DiscrepancyTooLarge(discrepancy, limit);
    // Too many chips counted -> everyone gives a little back, by share of buy-ins.
    const adj = allocate(-discrepancy, new Map(lines.map((l) => [l.player, l.buyins])));
    for (const l of lines) l.adjustment = adj.get(l.player) ?? 0;
  }

  for (const l of lines) l.net = l.cashouts - l.buyins + l.cashGiven - l.cashReceived + l.adjustment;
  const nets = new Map(lines.map((l) => [l.player, l.net]));
  if (sumCents(nets.values()) !== 0) throw new Error('internal: poker nets do not sum to zero');
  return { lines, nets, totalBuyins, totalCashouts, discrepancy };
}
