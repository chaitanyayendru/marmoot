/**
 * A poker night as the web app stores it, plus everything derived from it.
 *
 * The stored shape is an event log (buy-ins and cash handed to the host) plus each
 * player's cash-out. Nets and the settlement plan are never stored: they are
 * recomputed from the log by @marmoot/core every time, the same way the server
 * will once the night lives in Supabase.
 */
import {
  DiscrepancyTooLarge,
  greedySettle,
  minTransferSettle,
  settlePokerNight,
  type PlayerLine,
  type PokerEvent,
  type Rails,
  type Transfer,
} from '@marmoot/core';

export type PayApp = 'venmo' | 'zelle' | 'paypal' | 'cashapp';
export const PAY_APPS: readonly PayApp[] = ['venmo', 'zelle', 'paypal', 'cashapp'];
export const APP_NAMES: Record<PayApp | 'cash', string> = {
  venmo: 'Venmo',
  zelle: 'Zelle',
  paypal: 'PayPal',
  cashapp: 'Cash App',
  cash: 'Cash',
};

export interface Player {
  id: string;
  name: string;
  /** Venmo username, Zelle email or phone, PayPal.me name, Cash App $cashtag. */
  handles: Partial<Record<PayApp, string>>;
  /** Willing to settle in cash before leaving. */
  cash: boolean;
}

export type NightEvent =
  | { id: string; at: number; kind: 'buyin'; player: string; amount: number }
  | { id: string; at: number; kind: 'cash'; from: string; to: string; amount: number; /** the buy-in this cash paid for */ forBuyIn?: string };

/** How buy-ins are paid: handed to the host in cash, or settled at the end. */
export type BuyInMode = 'cash-to-host' | 'settle-later';

export interface Night {
  id: string;
  name: string;
  createdAt: number;
  buyIn: number;
  mode: BuyInMode;
  tolerance: number;
  hostId: string | null;
  players: Player[];
  events: NightEvent[];
  /** Cents each player cashed out; missing until entered. */
  cashouts: Record<string, number>;
  /** Transfer key -> time it was marked paid. */
  paid: Record<string, number>;
}

export interface State {
  nights: Night[];
}

export type Action =
  | { type: 'createNight'; id: string; name: string; buyIn: number; mode: BuyInMode; at: number }
  | { type: 'deleteNight'; night: string }
  | { type: 'addPlayer'; night: string; id: string; name: string }
  | { type: 'updatePlayer'; night: string; player: Player }
  | { type: 'removePlayer'; night: string; player: string }
  | { type: 'setHost'; night: string; player: string | null }
  | { type: 'buyIn'; night: string; player: string; amount: number; ids: [string, string]; at: number }
  | { type: 'undo'; night: string; event: string }
  | { type: 'setCashout'; night: string; player: string; amount: number | null }
  | { type: 'setMode'; night: string; mode: BuyInMode }
  | { type: 'togglePaid'; night: string; key: string; at: number };

const mapNight = (s: State, id: string, f: (n: Night) => Night): State => ({
  nights: s.nights.map((n) => (n.id === id ? f(n) : n)),
});

export function reducer(s: State, a: Action): State {
  switch (a.type) {
    case 'createNight':
      return {
        nights: [
          { id: a.id, name: a.name, createdAt: a.at, buyIn: a.buyIn, mode: a.mode, tolerance: 0.01, hostId: null, players: [], events: [], cashouts: {}, paid: {} },
          ...s.nights,
        ],
      };
    case 'deleteNight':
      return { nights: s.nights.filter((n) => n.id !== a.night) };
    case 'addPlayer':
      return mapNight(s, a.night, (n) => ({
        ...n,
        players: [...n.players, { id: a.id, name: a.name.trim(), handles: {}, cash: false }],
        // The first player added is the host until someone says otherwise.
        hostId: n.hostId ?? a.id,
      }));
    case 'updatePlayer':
      return mapNight(s, a.night, (n) => ({ ...n, players: n.players.map((p) => (p.id === a.player.id ? a.player : p)) }));
    case 'removePlayer':
      return mapNight(s, a.night, (n) => {
        if (n.events.some((e) => (e.kind === 'buyin' ? e.player === a.player : e.from === a.player || e.to === a.player))) return n;
        const players = n.players.filter((p) => p.id !== a.player);
        const { [a.player]: _gone, ...cashouts } = n.cashouts;
        return { ...n, players, cashouts, hostId: n.hostId === a.player ? (players[0]?.id ?? null) : n.hostId };
      });
    case 'setHost':
      return mapNight(s, a.night, (n) => ({ ...n, hostId: a.player }));
    case 'setMode':
      return mapNight(s, a.night, (n) => ({ ...n, mode: a.mode }));
    case 'buyIn':
      return mapNight(s, a.night, (n) => {
        const events: NightEvent[] = [{ id: a.ids[0], at: a.at, kind: 'buyin', player: a.player, amount: a.amount }];
        // In cash-to-host mode the money changed hands at the table, so the host now holds it.
        if (n.mode === 'cash-to-host' && n.hostId && n.hostId !== a.player) {
          events.push({ id: a.ids[1], at: a.at, kind: 'cash', from: a.player, to: n.hostId, amount: a.amount, forBuyIn: a.ids[0] });
        }
        return { ...n, events: [...n.events, ...events] };
      });
    case 'undo':
      // Undo removes a buy-in together with the cash event recorded in the same tap.
      return mapNight(s, a.night, (n) => {
        if (!n.events.some((e) => e.id === a.event)) return n;
        return { ...n, events: n.events.filter((e) => e.id !== a.event && !(e.kind === 'cash' && e.forBuyIn === a.event)) };
      });
    case 'setCashout':
      return mapNight(s, a.night, (n) => {
        const cashouts = { ...n.cashouts };
        if (a.amount === null) delete cashouts[a.player];
        else cashouts[a.player] = a.amount;
        return { ...n, cashouts };
      });
    case 'togglePaid':
      return mapNight(s, a.night, (n) => {
        const paid = { ...n.paid };
        if (paid[a.key]) delete paid[a.key];
        else paid[a.key] = a.at;
        return { ...n, paid };
      });
  }
}

export function railsFor(p: Player): string[] {
  const apps: string[] = PAY_APPS.filter((app) => (p.handles[app] ?? '').trim() !== '');
  if (p.cash) apps.push('cash');
  return apps;
}

export function transferKey(t: Transfer): string {
  return `${t.from}>${t.to}:${t.amount}`;
}

export interface PlayerTotals {
  buyins: number;
  count: number;
}

export type Settlement =
  | { status: 'waiting'; missing: string[] }
  | { status: 'recount'; discrepancy: number; limit: number }
  | {
      status: 'ready';
      lines: PlayerLine[];
      discrepancy: number;
      transfers: Transfer[];
      /** How many transfers biggest-debtor-pays-biggest-creditor would need. */
      greedyCount: number;
      /** 'apps': every transfer is between people who share an app. */
      matched: 'apps' | 'no-apps' | 'infeasible';
    };

export interface Derived {
  pot: number;
  totals: Map<string, PlayerTotals>;
  cashedOut: number;
  settlement: Settlement;
}

export function derive(n: Night): Derived {
  const totals = new Map<string, PlayerTotals>(n.players.map((p) => [p.id, { buyins: 0, count: 0 }]));
  for (const e of n.events) {
    if (e.kind !== 'buyin') continue;
    const t = totals.get(e.player);
    if (t) { t.buyins += e.amount; t.count += 1; }
  }
  const pot = [...totals.values()].reduce((s, t) => s + t.buyins, 0);
  const cashedOut = Object.values(n.cashouts).reduce((s, v) => s + v, 0);

  const missing = n.players.filter((p) => n.cashouts[p.id] === undefined).map((p) => p.id);
  if (n.players.length === 0 || missing.length > 0) return { pot, totals, cashedOut, settlement: { status: 'waiting', missing } };

  const events: PokerEvent[] = [
    ...n.events.map((e): PokerEvent => (e.kind === 'buyin' ? { kind: 'buyin', player: e.player, amount: e.amount } : { kind: 'cash', from: e.from, to: e.to, amount: e.amount })),
    ...n.players.map((p): PokerEvent => ({ kind: 'cashout', player: p.id, amount: n.cashouts[p.id] ?? 0 })),
  ];

  let night;
  try {
    night = settlePokerNight(events, { discrepancyTolerance: n.tolerance });
  } catch (err) {
    if (err instanceof DiscrepancyTooLarge) {
      return { pot, totals, cashedOut, settlement: { status: 'recount', discrepancy: err.discrepancy, limit: err.limit } };
    }
    throw err;
  }

  const greedyCount = greedySettle(night.nets).length;
  const owing = n.players.filter((p) => (night.nets.get(p.id) ?? 0) !== 0);
  const everyoneHasAnApp = owing.every((p) => railsFor(p).length > 0);

  let matched: 'apps' | 'no-apps' | 'infeasible' = 'no-apps';
  let transfers: Transfer[];
  if (everyoneHasAnApp) {
    const rails: Rails = new Map(n.players.map((p) => [p.id, railsFor(p)]));
    const r = minTransferSettle(night.nets, { rails });
    if (r.feasible) {
      matched = 'apps';
      transfers = r.transfers;
    } else {
      matched = 'infeasible';
      transfers = minTransferSettle(night.nets).transfers;
    }
  } else {
    transfers = minTransferSettle(night.nets).transfers;
  }

  return {
    pot,
    totals,
    cashedOut,
    settlement: { status: 'ready', lines: night.lines, discrepancy: night.discrepancy, transfers, greedyCount, matched },
  };
}

export function newId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

export function defaultNightName(at: number): string {
  const d = new Date(at);
  return `Poker, ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
}
