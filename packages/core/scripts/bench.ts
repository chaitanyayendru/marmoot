/**
 * How big a session can be solved exactly, and how long it takes.
 *
 *   npm run bench
 */
import { minTransferSettle, type Rails } from '../src/settle.ts';

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function session(rng: () => number, n: number): Map<string, number> {
  const vals = Array.from({ length: n - 1 }, () => (Math.floor(rng() * 21) - 10) * 500);
  vals.push(-vals.reduce((s, v) => s + v, 0));
  return new Map(vals.map((v, i) => [`p${i}`, v === 0 ? 500 * (i % 2 ? 1 : -1) : v]));
}

function balance(m: Map<string, number>): Map<string, number> {
  const s = [...m.values()].reduce((a, b) => a + b, 0);
  const first = [...m.keys()][0]!;
  m.set(first, m.get(first)! - s);
  return m;
}

const rng = mulberry32(1);
const time = (f: () => void, reps: number) => {
  const t0 = performance.now();
  for (let i = 0; i < reps; i++) f();
  return (performance.now() - t0) / reps;
};

console.log('no app constraints (2^n states)');
for (const n of [8, 12, 16, 18, 20]) {
  const m = balance(session(rng, n));
  const ms = time(() => minTransferSettle(m), n >= 18 ? 3 : 20);
  console.log(`  n=${String(n).padStart(2)}  ${ms.toFixed(1).padStart(8)} ms`);
}

console.log('with app constraints (3^n over zero-sum subsets)');
const apps = ['venmo', 'zelle', 'cashapp'];
for (const n of [8, 10, 12, 14, 16]) {
  const m = balance(session(rng, n));
  const rails: Rails = new Map([...m.keys()].map((k, i) => [k, i % 3 === 0 ? ['venmo', 'zelle'] : [apps[i % 3]!]]));
  const ms = time(() => minTransferSettle(m, { rails }), n >= 14 ? 3 : 10);
  console.log(`  n=${String(n).padStart(2)}  ${ms.toFixed(1).padStart(8)} ms`);
}

console.log('with app constraints, dense case (every +$5/-$5 pair cancels, apps form a chain)');
for (const n of [12, 14, 16]) {
  const m = new Map(Array.from({ length: n }, (_, i) => [`p${i}`, i % 2 ? 500 : -500] as [string, number]));
  const rails: Rails = new Map([...m.keys()].map((k, i) => [k, [`app${i}`, `app${i + 1}`]]));
  const ms = time(() => minTransferSettle(m, { rails }), 3);
  console.log(`  n=${String(n).padStart(2)}  ${ms.toFixed(1).padStart(8)} ms`);
}
