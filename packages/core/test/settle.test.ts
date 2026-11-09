import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyTransfers, greedySettle, minTransferSettle, netAcross, type Rails } from '../src/settle.ts';

const nets = (o: Record<string, number>) => new Map(Object.entries(o));
const allZero = (m: Map<string, number>) => [...m.values()].every((v) => v === 0);

/** Independent exact answer: classic backtracking (settle person i against each later opposite-sign j). */
function bruteMinTransfers(vals: number[]): number {
  const a = vals.filter((v) => v !== 0);
  const go = (i: number): number => {
    while (i < a.length && a[i] === 0) i++;
    if (i === a.length) return 0;
    let best = Infinity;
    for (let j = i + 1; j < a.length; j++) {
      if (a[i]! * a[j]! < 0) {
        a[j]! += a[i]!;
        best = Math.min(best, 1 + go(i + 1));
        a[j]! -= a[i]!;
        if (a[j]! + a[i]! === 0) break; // exact cancel is never worse
      }
    }
    return best;
  };
  return go(0);
}

/** Independent exact answer with rails: enumerate every set partition, keep zero-sum connected blocks. */
function bruteWithRails(ids: string[], vals: number[], rails: Rails): number | null {
  const share = (a: string, b: string) => (rails.get(a) ?? []).some((r) => (rails.get(b) ?? []).includes(r));
  const connected = (block: number[]) => {
    const seen = new Set([block[0]!]);
    const q = [block[0]!];
    while (q.length) {
      const u = q.pop()!;
      for (const v of block) if (!seen.has(v) && share(ids[u]!, ids[v]!)) { seen.add(v); q.push(v); }
    }
    return seen.size === block.length;
  };
  let best = -1;
  const blocks: number[][] = [];
  const rec = (i: number) => {
    if (i === ids.length) {
      if (blocks.every((b) => b.reduce((s, k) => s + vals[k]!, 0) === 0 && connected(b))) best = Math.max(best, blocks.length);
      return;
    }
    for (const b of blocks) { b.push(i); rec(i + 1); b.pop(); }
    blocks.push([i]); rec(i + 1); blocks.pop();
  };
  rec(0);
  return best < 0 ? null : ids.length - best;
}

function randomNets(rng: () => number, n: number): Map<string, number> {
  // Small magnitudes so zero-sum subgroups actually occur.
  const vals = Array.from({ length: n - 1 }, () => (Math.floor(rng() * 9) - 4) * 500);
  vals.push(-vals.reduce((s, v) => s + v, 0));
  return new Map(vals.map((v, i) => [`p${i}`, v]));
}

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('greedy settles everything in at most n - 1 transfers', () => {
  const m = nets({ a: 5000, b: -2000, c: -3000 });
  const t = greedySettle(m);
  assert.ok(allZero(applyTransfers(m, t)));
  assert.equal(t.length, 2);
});

test('exact solver finds pairs greedy misses', () => {
  // Greedy pairs the biggest creditor with the biggest debtor first and needs 4 transfers;
  // {a, c} cancel on their own and {b, d, e} settle in 2, so 3 is optimal.
  const m = nets({ a: 3500, b: -3000, c: -3500, d: -1000, e: 4000 });
  assert.equal(greedySettle(m).length, 4);
  const r = minTransferSettle(m);
  assert.equal(r.transfers.length, 3);
  assert.equal(r.optimal, 3);
  assert.ok(allZero(applyTransfers(m, r.transfers)));
});

test('worked poker night from the architecture doc', async () => {
  const { events, rails } = await import('../scripts/poker-night.ts');
  const { settlePokerNight } = await import('../src/poker.ts');
  const night = settlePokerNight(events);
  assert.deepEqual(Object.fromEntries(night.nets), {
    arjun: -3000, chai: -1000, dev: -5500, kabir: 5500, meera: 7500, priya: 5000, ravi: -5000, sana: -3500,
  });
  const greedy = greedySettle(night.nets);
  assert.equal(greedy.length, 7);
  const exact = minTransferSettle(night.nets, { rails });
  assert.equal(exact.transfers.length, 5);
  assert.ok(exact.transfers.every((t) => t.rail));
  assert.ok(allZero(applyTransfers(night.nets, exact.transfers)));
});

test('exact solver matches brute force on 500 random sessions', () => {
  const rng = mulberry32(42);
  for (let k = 0; k < 500; k++) {
    const m = randomNets(rng, 3 + Math.floor(rng() * 6));
    const r = minTransferSettle(m);
    assert.ok(allZero(applyTransfers(m, r.transfers)), 'balances clear');
    assert.ok(r.transfers.every((t) => t.amount > 0));
    assert.equal(r.transfers.length, bruteMinTransfers([...m.values()]), JSON.stringify([...m]));
    assert.ok(r.transfers.length <= greedySettle(m).length);
  }
});

test('rails: only pairs who share an app pay each other', () => {
  const m = nets({ host: 0, ana: 4000, ben: -4000 });
  const rails: Rails = new Map([
    ['host', ['venmo', 'zelle']],
    ['ana', ['venmo']],
    ['ben', ['zelle']],
  ]);
  // Ana and Ben share no app. The host is already square but has both,
  // so the money is routed through the host: two transfers instead of an impossible one.
  const r = minTransferSettle(m, { rails });
  assert.equal(r.feasible, true);
  assert.equal(r.transfers.length, 2);
  for (const t of r.transfers) assert.ok(t.rail, 'every transfer has a shared app');
  assert.ok(allZero(applyTransfers(m, r.transfers)));
});

test('rails: infeasible when someone shares no app with anyone', () => {
  const m = nets({ ana: 4000, ben: -4000 });
  const rails: Rails = new Map([['ana', ['venmo']], ['ben', ['zelle']]]);
  assert.equal(minTransferSettle(m, { rails }).feasible, false);
});

test('rails: exact solver matches brute force on 300 random sessions', () => {
  const rng = mulberry32(7);
  const apps = ['venmo', 'zelle', 'cashapp'];
  for (let k = 0; k < 300; k++) {
    const m = randomNets(rng, 3 + Math.floor(rng() * 5));
    const ids = [...m.keys()];
    const rails: Rails = new Map(ids.map((id) => [id, apps.filter(() => rng() < 0.5)]));
    const r = minTransferSettle(m, { rails });
    // Everyone takes part, including people at zero: they can bridge two people with no shared app.
    const expected = bruteWithRails(ids, ids.map((id) => m.get(id)!), rails);
    if (expected === null) {
      assert.equal(r.feasible, false);
      continue;
    }
    assert.equal(r.feasible, true);
    assert.equal(r.transfers.length, expected);
    assert.ok(allZero(applyTransfers(m, r.transfers)));
    for (const t of r.transfers) assert.ok(t.rail);
  }
});

test('cross-session netting can remove transfers', () => {
  const night1 = nets({ a: 2000, b: -2000 });
  const night2 = nets({ a: -2000, b: 2000 });
  assert.equal(minTransferSettle(netAcross([night1, night2])).transfers.length, 0);
});
