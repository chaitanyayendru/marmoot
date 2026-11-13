/**
 * The web app's data: groups of people who share costs (a flat, a trip, a poker
 * crew), the things they spend on, payments between them, recurring bills, and
 * game nights. Balances are never stored; they are recomputed from the items by
 * @marmoot/core, the same way the database does.
 */
import {
  DiscrepancyTooLarge,
  expenseNets,
  greedySettle,
  minTransferSettle,
  nextDue,
  paymentNets,
  settlePokerNight,
  sumNets,
  type PlayerLine,
  type PokerEvent,
  type Rails,
  type Split,
  type Transfer,
} from '@marmoot/core';

// ------------------------------------------------------------------ people

export type PayApp = 'venmo' | 'zelle' | 'paypal' | 'cashapp';
export const PAY_APPS: readonly PayApp[] = ['venmo', 'zelle', 'paypal', 'cashapp'];
export const APP_NAMES: Record<PayApp | 'cash', string> = { venmo: 'Venmo', zelle: 'Zelle', paypal: 'PayPal', cashapp: 'Cash App', cash: 'cash' };

export interface Member {
  id: string;
  name: string;
  /** WhatsApp number, as typed. */
  phone: string;
  handles: Partial<Record<PayApp, string>>;
  /** Happy to settle in cash. */
  cash: boolean;
  /** The Marmoot account of this person, once they've joined a shared group. */
  userId?: string;
}

// ------------------------------------------------------------------ things that happen in a group

export type Category = 'groceries' | 'utilities' | 'rent' | 'dining' | 'transport' | 'travel' | 'household' | 'fun' | 'game' | 'other';
export const CATEGORIES: { id: Category; label: string }[] = [
  { id: 'groceries', label: 'Groceries' },
  { id: 'utilities', label: 'Utilities' },
  { id: 'rent', label: 'Rent' },
  { id: 'dining', label: 'Eating out' },
  { id: 'household', label: 'Household' },
  { id: 'transport', label: 'Transport' },
  { id: 'travel', label: 'Travel' },
  { id: 'fun', label: 'Fun' },
  { id: 'other', label: 'Other' },
];
export const categoryLabel = (c: Category) => (c === 'game' ? 'Game night' : CATEGORIES.find((x) => x.id === c)?.label ?? 'Other');

export interface ExpenseItem {
  kind: 'expense';
  id: string;
  at: number;
  /** YYYY-MM-DD */
  date: string;
  description: string;
  category: Category;
  amount: number;
  paidBy: string;
  split: Split;
  recurringId?: string;
}

export interface PaymentItem {
  kind: 'payment';
  id: string;
  at: number;
  date: string;
  from: string;
  to: string;
  amount: number;
  rail?: string;
}

export type GameEvent =
  | { id: string; at: number; kind: 'buyin'; player: string; amount: number }
  | { id: string; at: number; kind: 'cash'; from: string; to: string; amount: number; forBuyIn?: string };

export type BuyInMode = 'cash-to-host' | 'settle-later';

export interface GameItem {
  kind: 'game';
  id: string;
  at: number;
  date: string;
  name: string;
  buyIn: number;
  mode: BuyInMode;
  tolerance: number;
  hostId: string | null;
  players: string[];
  events: GameEvent[];
  cashouts: Record<string, number>;
  /** Once closed, the night's results count toward the group's balances. */
  closed: boolean;
}

export type Item = ExpenseItem | PaymentItem | GameItem;

export interface Recurring {
  id: string;
  description: string;
  category: Category;
  /** null: the amount changes each time (power, water), so ask for it when it's due. */
  amount: number | null;
  paidBy: string;
  split: Split;
  every: 'week' | 'month';
  /** Next date it falls due, YYYY-MM-DD. */
  next: string;
  /** Day of the month a monthly bill belongs on, so the 31st survives February. Older saves lack it. */
  day?: number;
}

export interface DueBill {
  recurringId: string;
  date: string;
}

/**
 * A bill sheet this device started. The sheet itself lives on the server; the group
 * keeps the owner's link and which group member each person on the sheet is.
 */
export interface SheetRef {
  /** The server's sheet id. */
  id: string;
  /** The owner's secret link token. Never shared. */
  ownerToken: string;
  title: string;
  category: Category;
  date: string;
  createdAt: number;
  /** Sheet person id -> group member id. */
  people: { personId: string; memberId: string }[];
  /** Set once the sheet is closed into the group as this expense. */
  expenseId?: string;
}

export interface Group {
  id: string;
  name: string;
  createdAt: number;
  /** The member who is using this device. */
  me: string;
  members: Member[];
  items: Item[];
  recurring: Recurring[];
  due: DueBill[];
  /** Bill sheets started from this group. Older saves lack it. */
  sheets?: SheetRef[];
  /** Kept on Marmoot's server and shared with everyone who has joined. */
  shared?: boolean;
  /** The sample flat: never shared. */
  sample?: boolean;
}

export type Theme = 'system' | 'light' | 'dark';

export interface State {
  groups: Group[];
  theme: Theme;
  /** The owner's own Gemini key for reading receipts. Stays on this device. */
  geminiKey?: string;
}

// ------------------------------------------------------------------ dates

export function today(now = new Date()): string {
  const y = now.getFullYear(), m = now.getMonth() + 1, d = now.getDate();
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Next due date: +7 days, or the bill's day next month (31 Jan -> 28 Feb -> 31 Mar). */
export function advance(date: string, every: 'week' | 'month', anchorDay?: number): string {
  return nextDue(date, every, anchorDay);
}

export function shortDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ------------------------------------------------------------------ recurring bills

/**
 * Post fixed recurring bills that have fallen due, and queue variable ones as "enter
 * this month's amount". Each posted bill's id comes from the bill and its date, so
 * catching up twice, or on two phones in a shared group, posts it once.
 */
export function catchUpRecurring(g: Group, todayStr: string, now: number): Group {
  if (!g.recurring.some((r) => r.next <= todayStr)) return g;
  const items = [...g.items];
  const due = [...g.due];
  const recurring = g.recurring.map((r) => {
    let next = r.next;
    for (let guard = 0; next <= todayStr && guard < 24; guard++) {
      const id = `${r.id}@${next}`;
      if (r.amount !== null) {
        if (!items.some((i) => i.id === id)) items.push({ kind: 'expense', id, at: now, date: next, description: r.description, category: r.category, amount: r.amount, paidBy: r.paidBy, split: r.split, recurringId: r.id });
      } else if (!due.some((d) => d.recurringId === r.id && d.date === next)) {
        due.push({ recurringId: r.id, date: next });
      }
      next = advance(next, r.every, r.day);
    }
    return { ...r, next };
  });
  return { ...g, items, due, recurring };
}

// ------------------------------------------------------------------ actions

export type Action =
  | { type: 'setTheme'; theme: Theme }
  | { type: 'setGeminiKey'; key: string }
  | { type: 'createGroup'; group: Group }
  | { type: 'deleteGroup'; group: string }
  | { type: 'renameGroup'; group: string; name: string }
  | { type: 'addMember'; group: string; member: Member }
  | { type: 'updateMember'; group: string; member: Member }
  | { type: 'removeMember'; group: string; member: string }
  | { type: 'addItem'; group: string; item: Item }
  | { type: 'deleteItem'; group: string; item: string }
  | { type: 'addRecurring'; group: string; recurring: Recurring }
  | { type: 'deleteRecurring'; group: string; recurring: string }
  | { type: 'catchUp'; today: string; now: number; group?: string }
  | { type: 'resolveDue'; group: string; recurringId: string; date: string; amount: number | null; id: string; at: number }
  | { type: 'updateGame'; group: string; game: string; update: GameUpdate }
  | { type: 'addSheet'; group: string; sheet: SheetRef }
  | { type: 'closeSheet'; group: string; sheet: string; expense: ExpenseItem }
  /** A deleted bill sheet comes off the list, with the expense it added if it was closed. */
  | { type: 'removeSheet'; group: string; sheet: string }
  // From the server, never sent back: shared groups as they now stand, and ones you've left.
  | { type: 'putGroups'; groups: Group[] }
  | { type: 'dropGroups'; ids: string[] };

/** Actions that change one group, and so are shared when the group is. */
export function groupOf(a: Action): string | null {
  switch (a.type) {
    case 'setTheme':
    case 'setGeminiKey':
    case 'putGroups':
    case 'dropGroups':
      return null;
    case 'createGroup':
      return a.group.id;
    case 'catchUp':
      return a.group ?? null;
    default:
      return a.group;
  }
}

export type GameUpdate =
  | { kind: 'buyIn'; player: string; amount: number; ids: [string, string]; at: number }
  | { kind: 'undo'; event: string }
  | { kind: 'cashout'; player: string; amount: number | null }
  | { kind: 'mode'; mode: BuyInMode }
  | { kind: 'host'; player: string }
  | { kind: 'players'; players: string[] }
  | { kind: 'close' };

const mapGroup = (s: State, id: string, f: (g: Group) => Group): State => ({ ...s, groups: s.groups.map((g) => (g.id === id ? f(g) : g)) });

export function memberInUse(g: Group, member: string): boolean {
  return (
    g.me === member ||
    g.items.some((i) =>
      i.kind === 'expense'
        ? i.paidBy === member || splitPeople(i.split).includes(member)
        : i.kind === 'payment'
          ? i.from === member || i.to === member
          : i.players.includes(member),
    ) ||
    g.recurring.some((r) => r.paidBy === member || splitPeople(r.split).includes(member)) ||
    (g.sheets ?? []).some((sh) => !sh.expenseId && sh.people.some((p) => p.memberId === member))
  );
}

export function splitPeople(s: Split): string[] {
  switch (s.method) {
    case 'equal': return s.among;
    case 'exact': return Object.keys(s.amounts);
    case 'percent': return Object.keys(s.basisPoints);
    case 'shares': return Object.keys(s.shares);
  }
}

function updateGame(game: GameItem, u: GameUpdate): GameItem {
  if (game.closed) return game;
  switch (u.kind) {
    case 'buyIn': {
      const events: GameEvent[] = [{ id: u.ids[0], at: u.at, kind: 'buyin', player: u.player, amount: u.amount }];
      if (game.mode === 'cash-to-host' && game.hostId && game.hostId !== u.player) {
        events.push({ id: u.ids[1], at: u.at, kind: 'cash', from: u.player, to: game.hostId, amount: u.amount, forBuyIn: u.ids[0] });
      }
      return { ...game, events: [...game.events, ...events] };
    }
    case 'undo':
      return { ...game, events: game.events.filter((e) => e.id !== u.event && !(e.kind === 'cash' && e.forBuyIn === u.event)) };
    case 'cashout': {
      const cashouts = { ...game.cashouts };
      if (u.amount === null) delete cashouts[u.player];
      else cashouts[u.player] = u.amount;
      return { ...game, cashouts };
    }
    case 'mode':
      return { ...game, mode: u.mode };
    case 'host':
      return { ...game, hostId: u.player };
    case 'players': {
      const keep = u.players.filter((p) => p);
      const busy = new Set(game.events.flatMap((e) => (e.kind === 'buyin' ? [e.player] : [e.from, e.to])));
      const players = [...new Set([...keep, ...[...busy].filter((p) => !keep.includes(p))])];
      return { ...game, players, hostId: game.hostId && players.includes(game.hostId) ? game.hostId : (players[0] ?? null) };
    }
    case 'close':
      return gameResult(game).status === 'ready' ? { ...game, closed: true } : game;
  }
}

export function reducer(s: State, a: Action): State {
  switch (a.type) {
    case 'setTheme':
      return { ...s, theme: a.theme };
    case 'setGeminiKey':
      return { ...s, geminiKey: a.key.trim() || undefined };
    case 'createGroup':
      return { ...s, groups: [a.group, ...s.groups] };
    case 'deleteGroup':
      return { ...s, groups: s.groups.filter((g) => g.id !== a.group) };
    case 'renameGroup':
      return mapGroup(s, a.group, (g) => ({ ...g, name: a.name.trim() || g.name }));
    case 'addMember':
      return mapGroup(s, a.group, (g) => ({ ...g, members: [...g.members, a.member] }));
    case 'updateMember':
      return mapGroup(s, a.group, (g) => ({ ...g, members: g.members.map((m) => (m.id === a.member.id ? a.member : m)) }));
    case 'removeMember':
      return mapGroup(s, a.group, (g) => (memberInUse(g, a.member) ? g : { ...g, members: g.members.filter((m) => m.id !== a.member) }));
    case 'addItem':
      return mapGroup(s, a.group, (g) => ({ ...g, items: [...g.items, a.item] }));
    case 'deleteItem':
      return mapGroup(s, a.group, (g) => ({ ...g, items: g.items.filter((i) => i.id !== a.item) }));
    case 'addSheet':
      return mapGroup(s, a.group, (g) => ({ ...g, sheets: [a.sheet, ...(g.sheets ?? [])] }));
    case 'closeSheet':
      return mapGroup(s, a.group, (g) => ({
        ...g,
        items: g.items.some((i) => i.id === a.expense.id) ? g.items : [...g.items, a.expense],
        sheets: (g.sheets ?? []).map((sh) => (sh.id === a.sheet ? { ...sh, expenseId: a.expense.id } : sh)),
      }));
    case 'removeSheet':
      return mapGroup(s, a.group, (g) => {
        const sheet = (g.sheets ?? []).find((sh) => sh.id === a.sheet);
        return {
          ...g,
          items: sheet?.expenseId ? g.items.filter((i) => i.id !== sheet.expenseId) : g.items,
          sheets: (g.sheets ?? []).filter((sh) => sh.id !== a.sheet),
        };
      });
    case 'addRecurring':
      return mapGroup(s, a.group, (g) => ({ ...g, recurring: [...g.recurring, a.recurring] }));
    case 'deleteRecurring':
      return mapGroup(s, a.group, (g) => ({ ...g, recurring: g.recurring.filter((r) => r.id !== a.recurring), due: g.due.filter((d) => d.recurringId !== a.recurring) }));
    case 'catchUp': {
      // Without a group: every group kept on this phone. Shared groups catch up through their own log.
      const groups = s.groups.map((g) => ((a.group ? g.id === a.group : !g.shared) ? catchUpRecurring(g, a.today, a.now) : g));
      return groups.every((g, i) => g === s.groups[i]) ? s : { ...s, groups };
    }
    case 'putGroups': {
      if (!a.groups.length) return s;
      const byId = new Map(a.groups.map((g) => [g.id, g]));
      const kept = s.groups.map((g) => byId.get(g.id) ?? g);
      const added = a.groups.filter((g) => !s.groups.some((x) => x.id === g.id));
      return { ...s, groups: [...added, ...kept] };
    }
    case 'dropGroups':
      return a.ids.length ? { ...s, groups: s.groups.filter((g) => !a.ids.includes(g.id)) } : s;
    case 'resolveDue':
      return mapGroup(s, a.group, (g) => {
        const r = g.recurring.find((x) => x.id === a.recurringId);
        const due = g.due.filter((d) => !(d.recurringId === a.recurringId && d.date === a.date));
        if (!r || a.amount === null) return { ...g, due };
        const item: ExpenseItem = { kind: 'expense', id: a.id, at: a.at, date: a.date, description: r.description, category: r.category, amount: a.amount, paidBy: r.paidBy, split: r.split, recurringId: r.id };
        return { ...g, due, items: [...g.items, item] };
      });
    case 'updateGame':
      return mapGroup(s, a.group, (g) => ({ ...g, items: g.items.map((i) => (i.kind === 'game' && i.id === a.game ? updateGame(i, a.update) : i)) }));
  }
}

// ------------------------------------------------------------------ game nights

export type GameResult =
  | { status: 'waiting'; missing: string[] }
  | { status: 'recount'; discrepancy: number; limit: number }
  | { status: 'ready'; lines: PlayerLine[]; nets: Map<string, number>; discrepancy: number };

export function gameTotals(game: GameItem) {
  const totals = new Map<string, { buyins: number; count: number }>(game.players.map((p) => [p, { buyins: 0, count: 0 }]));
  for (const e of game.events) {
    if (e.kind !== 'buyin') continue;
    const t = totals.get(e.player) ?? { buyins: 0, count: 0 };
    t.buyins += e.amount;
    t.count += 1;
    totals.set(e.player, t);
  }
  const pot = [...totals.values()].reduce((s, t) => s + t.buyins, 0);
  const cashedOut = Object.values(game.cashouts).reduce((s, v) => s + v, 0);
  return { totals, pot, cashedOut };
}

export function gameResult(game: GameItem): GameResult {
  const missing = game.players.filter((p) => game.cashouts[p] === undefined);
  if (game.players.length === 0 || missing.length > 0) return { status: 'waiting', missing };
  const events: PokerEvent[] = [
    ...game.events.map((e): PokerEvent => (e.kind === 'buyin' ? { kind: 'buyin', player: e.player, amount: e.amount } : { kind: 'cash', from: e.from, to: e.to, amount: e.amount })),
    ...game.players.map((p): PokerEvent => ({ kind: 'cashout', player: p, amount: game.cashouts[p] ?? 0 })),
  ];
  try {
    const r = settlePokerNight(events, { discrepancyTolerance: game.tolerance });
    return { status: 'ready', lines: r.lines, nets: r.nets, discrepancy: r.discrepancy };
  } catch (err) {
    if (err instanceof DiscrepancyTooLarge) return { status: 'recount', discrepancy: err.discrepancy, limit: err.limit };
    throw err;
  }
}

// ------------------------------------------------------------------ balances

export function itemNets(i: Item): Map<string, number> {
  switch (i.kind) {
    case 'expense':
      return expenseNets(i.paidBy, i.amount, i.split);
    case 'payment':
      return paymentNets(i.from, i.to, i.amount);
    case 'game': {
      if (!i.closed) return new Map();
      const r = gameResult(i);
      return r.status === 'ready' ? r.nets : new Map();
    }
  }
}

export const byDate = (a: Item, b: Item) => (a.date === b.date ? a.at - b.at : a.date < b.date ? -1 : 1);

export function groupNets(g: Group): Map<string, number> {
  const nets = sumNets(g.items.map(itemNets));
  for (const m of g.members) if (!nets.has(m.id)) nets.set(m.id, 0);
  return nets;
}

/** Your running balance in this group after each item, oldest first. */
export function balanceHistory(g: Group): { date: string; value: number }[] {
  let v = 0;
  return [...g.items].sort(byDate).map((i) => {
    v += itemNets(i).get(g.me) ?? 0;
    return { date: i.date, value: v };
  });
}

export function railsFor(m: Member): string[] {
  const apps: string[] = PAY_APPS.filter((app) => (m.handles[app] ?? '').trim() !== '');
  if (m.cash) apps.push('cash');
  return apps;
}

export interface Plan {
  transfers: Transfer[];
  greedyCount: number;
  matched: 'apps' | 'no-apps' | 'infeasible';
}

export function settlePlan(g: Group): Plan {
  const nets = groupNets(g);
  const owing = g.members.filter((m) => (nets.get(m.id) ?? 0) !== 0);
  const greedyCount = greedySettle(nets).length;
  if (owing.length > 0 && owing.every((m) => railsFor(m).length > 0)) {
    const rails: Rails = new Map(g.members.map((m) => [m.id, railsFor(m)]));
    const r = minTransferSettle(nets, { rails });
    if (r.feasible) return { transfers: r.transfers, greedyCount, matched: 'apps' };
    return { transfers: minTransferSettle(nets).transfers, greedyCount, matched: 'infeasible' };
  }
  return { transfers: minTransferSettle(nets).transfers, greedyCount, matched: 'no-apps' };
}

export function transferKey(t: Transfer): string {
  return `${t.from}>${t.to}:${t.amount}`;
}

// ------------------------------------------------------------------ helpers

export function newId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

export function newMember(name: string, phone = ''): Member {
  return { id: newId(), name: name.trim(), phone: phone.trim(), handles: {}, cash: false };
}

export function newGroup(name: string, me: Member, others: Member[], now: number): Group {
  return { id: newId(), name: name.trim(), createdAt: now, me: me.id, members: [me, ...others], items: [], recurring: [], due: [] };
}

export function newGame(players: string[], buyIn: number, mode: BuyInMode, date: string, now: number): GameItem {
  return { kind: 'game', id: newId(), at: now, date, name: 'Game night', buyIn, mode, tolerance: 0.01, hostId: players[0] ?? null, players, events: [], cashouts: {}, closed: false };
}
