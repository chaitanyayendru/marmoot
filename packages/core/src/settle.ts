/**
 * Payment mapping: turn net balances into transfers.
 *
 * Sign convention: net > 0 means the person is owed money; net < 0 means they owe.
 *
 * The minimum number of transfers for n people with non-zero balances is
 *   n - (max number of disjoint groups whose balances each sum to zero),
 * because a zero-sum group of k people can always be settled in k - 1 transfers
 * and never in fewer (when it has no zero-sum subgroup). Finding that partition is
 * NP-hard in general, but session sizes are small (a poker table, a dinner), so we
 * solve it exactly with bitmask dynamic programming and fall back to greedy above
 * a size limit.
 *
 * With payment-app ("rail") constraints, a transfer is only allowed between two
 * people who share an app. A zero-sum group can then be settled in k - 1 transfers
 * exactly when its compatibility graph is connected (any spanning tree works), so
 * we maximise the number of zero-sum, connected groups instead.
 */
import { assertCents, type Cents } from './money.ts';

export interface Transfer {
  from: string;
  to: string;
  amount: Cents;
  /** Payment app both people have, when rails were given. */
  rail?: string;
}

export type Nets = ReadonlyMap<string, Cents>;
/** Payment apps per person, in that person's order of preference. */
export type Rails = ReadonlyMap<string, readonly string[]>;

export interface SettleOptions {
  rails?: Rails;
  /** Largest number of non-zero balances solved exactly without rails. Default 20 (2^20 states). */
  exactLimit?: number;
  /** Largest number solved exactly with rails (3^n). Default 16. */
  exactLimitWithRails?: number;
}

export interface SettleResult {
  transfers: Transfer[];
  method: 'exact' | 'greedy';
  /** The zero-sum groups the solver settled independently. */
  groups: string[][];
  /** With rails: false when no valid plan exists (someone shares no app with the people they must pay). */
  feasible: boolean;
  /** Lower bound on transfers; equals transfers.length when method is 'exact'. */
  optimal?: number;
}

const byKey = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function validateNets(nets: Nets): void {
  let s = 0;
  for (const [k, v] of nets) {
    assertCents(v, `net for ${k}`);
    s += v;
  }
  if (s !== 0) throw new Error(`nets must sum to zero, got ${s}`);
}

/**
 * Greedy: repeatedly have the biggest debtor pay the biggest creditor.
 * At most n - 1 transfers; often optimal, not always.
 */
export function greedySettle(nets: Nets): Transfer[] {
  validateNets(nets);
  const cred = [...nets].filter(([, v]) => v > 0).map(([k, v]) => ({ k, v }));
  const debt = [...nets].filter(([, v]) => v < 0).map(([k, v]) => ({ k, v: -v }));
  const order = (a: { k: string; v: number }, b: { k: string; v: number }) => (b.v - a.v) || byKey(a.k, b.k);
  const out: Transfer[] = [];
  while (cred.length && debt.length) {
    cred.sort(order);
    debt.sort(order);
    const c = cred[0]!;
    const d = debt[0]!;
    const amt = Math.min(c.v, d.v);
    out.push({ from: d.k, to: c.k, amount: amt });
    c.v -= amt;
    d.v -= amt;
    if (c.v === 0) cred.shift();
    if (d.v === 0) debt.shift();
  }
  return out;
}

const lowBitIndex = (m: number): number => 31 - Math.clz32(m & -m);

function nonZero(nets: Nets): { ids: string[]; vals: number[] } {
  const ids = [...nets.keys()].filter((k) => nets.get(k) !== 0).sort(byKey);
  return { ids, vals: ids.map((k) => nets.get(k)!) };
}

function subsetSums(vals: number[]): Float64Array {
  const n = vals.length;
  const sum = new Float64Array(1 << n);
  for (let m = 1; m < 1 << n; m++) sum[m] = sum[m & (m - 1)]! + vals[lowBitIndex(m)]!;
  return sum;
}

function maskToIds(mask: number, ids: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < ids.length; i++) if (mask & (1 << i)) out.push(ids[i]!);
  return out;
}

/**
 * Exact partition into the maximum number of zero-sum groups (no constraints).
 * O(2^n * n): dp[mask] = max_i dp[mask without i] + (sum[mask] == 0).
 * Walking back from the full mask gives an insertion order whose zero-sum
 * prefixes mark the group boundaries.
 */
function maxZeroSumGroups(vals: number[]): number[] {
  const n = vals.length;
  const full = (1 << n) - 1;
  const sum = subsetSums(vals);
  const dp = new Int8Array(1 << n);
  for (let m = 1; m <= full; m++) {
    let best = 0;
    for (let r = m; r; r &= r - 1) {
      const v = dp[m ^ (r & -r)]!;
      if (v > best) best = v;
    }
    dp[m] = best + (sum[m] === 0 ? 1 : 0);
  }
  // Backtrack.
  const removed: number[] = [];
  for (let m = full; m; ) {
    const bonus = sum[m] === 0 ? 1 : 0;
    let next = -1;
    for (let r = m; r; r &= r - 1) {
      const b = r & -r;
      if (dp[m ^ b]! + bonus === dp[m]) { next = b; break; }
    }
    removed.push(next);
    m ^= next;
  }
  const groups: number[] = [];
  let prefix = 0;
  let start = 0;
  for (const b of removed.reverse()) {
    prefix |= b;
    if (sum[prefix] === 0) { groups.push(prefix ^ start); start = prefix; }
  }
  return groups;
}

function sharedRail(payer: string, payee: string, rails: Rails): string | undefined {
  const theirs = new Set(rails.get(payee) ?? []);
  return (rails.get(payer) ?? []).find((r) => theirs.has(r));
}

/** Adjacency bitmasks over `ids`: bit j of adj[i] is set when i and j share a payment app. */
function compatibility(ids: string[], rails: Rails): number[] {
  return ids.map((a, i) =>
    ids.reduce((acc, b, j) => (i !== j && sharedRail(a, b, rails) !== undefined ? acc | (1 << j) : acc), 0),
  );
}

function isConnected(mask: number, adj: number[]): boolean {
  let seen = mask & -mask;
  let frontier = seen;
  while (frontier) {
    const i = lowBitIndex(frontier);
    frontier &= frontier - 1;
    const add = adj[i]! & mask & ~seen;
    seen |= add;
    frontier |= add;
  }
  return seen === mask;
}

/**
 * Exact partition into the maximum number of zero-sum groups that are each connected
 * in the compatibility graph. O(3^n) over zero-sum masks only. Returns null if no
 * valid partition exists.
 */
function maxConnectedZeroSumGroups(vals: number[], adj: number[]): number[] | null {
  const n = vals.length;
  const full = (1 << n) - 1;
  const sum = subsetSums(vals);
  const dp = new Int8Array(1 << n).fill(-1);
  const choice = new Int32Array(1 << n);
  dp[0] = 0;
  const valid = new Uint8Array(1 << n);
  for (let m = 1; m <= full; m++) if (sum[m] === 0 && isConnected(m, adj)) valid[m] = 1;
  for (let m = 1; m <= full; m++) {
    if (sum[m] !== 0) continue;
    const low = m & -m;
    const rest = m ^ low;
    // Enumerate groups s ⊆ m that contain the lowest bit.
    for (let sub = rest; ; sub = (sub - 1) & rest) {
      const s = sub | low;
      if (valid[s] && dp[m ^ s]! >= 0 && dp[m ^ s]! + 1 > dp[m]!) {
        dp[m] = dp[m ^ s]! + 1;
        choice[m] = s;
      }
      if (sub === 0) break;
    }
  }
  if (dp[full]! < 0) return null;
  const groups: number[] = [];
  for (let m = full; m; m ^= choice[m]!) groups.push(choice[m]!);
  return groups;
}

/**
 * Settle one connected zero-sum group along a spanning tree of the compatibility graph.
 * The tree is grown breadth-first from the largest balance, preferring larger balances,
 * so it tends to be a star around the night's big winner or loser, which is how people
 * settle up anyway. Flow on each edge is the sum of the balances below it.
 */
function settleTree(ids: string[], nets: Nets, rails: Rails): Transfer[] {
  const mag = (k: string) => Math.abs(nets.get(k)!);
  const order = [...ids].sort((a, b) => mag(b) - mag(a) || byKey(a, b));
  const root = order[0]!;
  const parent = new Map<string, string>();
  const seen = new Set([root]);
  const queue = [root];
  const visit: string[] = [];
  while (queue.length) {
    const u = queue.shift()!;
    visit.push(u);
    for (const v of order) {
      if (!seen.has(v) && sharedRail(u, v, rails) !== undefined) {
        seen.add(v);
        parent.set(v, u);
        queue.push(v);
      }
    }
  }
  if (seen.size !== ids.length) throw new Error('group is not connected');
  const below = new Map(ids.map((k) => [k, nets.get(k)!] as const));
  const out: Transfer[] = [];
  for (const v of visit.reverse()) {
    const p = parent.get(v);
    if (p === undefined) continue;
    const f = below.get(v)!; // balance of v's subtree
    below.set(p, below.get(p)! + f);
    if (f === 0) continue;
    const [from, to] = f > 0 ? [p, v] : [v, p];
    out.push({ from, to, amount: Math.abs(f), rail: sharedRail(from, to, rails) });
  }
  return out;
}

function withRails(ts: Transfer[], rails?: Rails): Transfer[] {
  if (!rails) return ts;
  return ts.map((t) => ({ ...t, rail: sharedRail(t.from, t.to, rails) }));
}

/** Fewest transfers, optionally limited to pairs who share a payment app. */
export function minTransferSettle(nets: Nets, opts: SettleOptions = {}): SettleResult {
  validateNets(nets);
  const { rails } = opts;
  const { ids, vals } = nonZero(nets);
  const n = ids.length;
  if (n === 0) return { transfers: [], method: 'exact', groups: [], feasible: true, optimal: 0 };

  if (!rails) {
    if (n > (opts.exactLimit ?? 20)) {
      const transfers = greedySettle(nets);
      return { transfers, method: 'greedy', groups: [ids], feasible: true };
    }
    const groups = maxZeroSumGroups(vals).map((g) => maskToIds(g, ids));
    const transfers = groups.flatMap((g) => greedySettle(new Map(g.map((k) => [k, nets.get(k)!]))));
    return { transfers, method: 'exact', groups, feasible: true, optimal: n - groups.length };
  }

  return settleWithRails(nets, rails, opts.exactLimitWithRails ?? 16);
}

/**
 * With rails, people who are already square still matter: they can bridge two people
 * who share no app (Ana pays the host on Venmo, the host pays Ben on Zelle). So the
 * rails solver works over everyone in the session, and a person at zero who ends up
 * alone in a group simply costs nothing.
 */
function settleWithRails(nets: Nets, rails: Rails, limit: number): SettleResult {
  const ids = [...nets.keys()].sort(byKey);
  const vals = ids.map((k) => nets.get(k)!);
  const n = ids.length;
  const adj = compatibility(ids, rails);
  if (n > limit) {
    // Too big to solve exactly: settle each connected component along a tree.
    const comps: number[] = [];
    let left = (1 << n) - 1;
    while (left) {
      let comp = left & -left;
      let frontier = comp;
      while (frontier) {
        const i = lowBitIndex(frontier);
        frontier &= frontier - 1;
        const add = adj[i]! & left & ~comp;
        comp |= add;
        frontier |= add;
      }
      comps.push(comp);
      left &= ~comp;
    }
    const groups = comps.map((c) => maskToIds(c, ids));
    const feasible = groups.every((g) => g.reduce((s, k) => s + nets.get(k)!, 0) === 0);
    const transfers = feasible ? groups.flatMap((g) => settleTree(g, nets, rails)) : [];
    return { transfers, method: 'greedy', groups, feasible };
  }

  const masks = maxConnectedZeroSumGroups(vals, adj);
  if (!masks) return { transfers: [], method: 'exact', groups: [], feasible: false };
  const groups = masks.map((g) => maskToIds(g, ids));
  const transfers = groups.flatMap((g) => {
    // Inside a group, prefer greedy if it happens to respect the rails (rounder amounts),
    // otherwise settle along a spanning tree. Both give at most k - 1 transfers.
    const sub = new Map(g.map((k) => [k, nets.get(k)!] as const));
    const greedy = withRails(greedySettle(sub), rails);
    return greedy.every((t) => t.rail !== undefined) && greedy.length <= g.length - 1
      ? greedy
      : settleTree(g, nets, rails);
  });
  const settled = groups.filter((g) => g.length > 1 || nets.get(g[0]!) !== 0);
  return { transfers, method: 'exact', groups: settled, feasible: true, optimal: n - groups.length };
}

/** Apply transfers to balances; every balance should end at zero. */
export function applyTransfers(nets: Nets, transfers: readonly Transfer[]): Map<string, Cents> {
  const out = new Map(nets);
  for (const t of transfers) {
    out.set(t.from, (out.get(t.from) ?? 0) + t.amount);
    out.set(t.to, (out.get(t.to) ?? 0) - t.amount);
  }
  return out;
}

/** Add up balances from several sessions (cross-session netting within a group). */
export function netAcross(sessions: readonly Nets[]): Map<string, Cents> {
  const out = new Map<string, Cents>();
  for (const s of sessions) for (const [k, v] of s) out.set(k, (out.get(k) ?? 0) + v);
  return out;
}
