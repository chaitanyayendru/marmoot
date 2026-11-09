/**
 * Money is always an integer number of minor units (cents). Never floats.
 */
export type Cents = number;

export function assertCents(x: number, label = 'amount'): void {
  if (!Number.isSafeInteger(x)) {
    throw new Error(`${label} must be an integer number of cents, got ${x}`);
  }
}

const byKey = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Split `total` cents across keys in proportion to integer `weights`, using the
 * largest-remainder (Hamilton) method:
 *   1. everyone gets floor(total * w / W)
 *   2. the leftover cents go one at a time to the largest fractional remainders
 *   3. ties go to the key that sorts first
 *
 * Deterministic, exact (BigInt arithmetic), and the parts always sum to `total`.
 * Negative totals are allocated by magnitude and the sign re-applied.
 * Keys with weight 0 are kept in the output with 0.
 */
export function allocate(total: Cents, weights: ReadonlyMap<string, number>): Map<string, Cents> {
  assertCents(total, 'total');
  const out = new Map<string, Cents>();
  for (const [k, w] of weights) {
    if (!Number.isSafeInteger(w) || w < 0) throw new Error(`weight for ${k} must be a non-negative integer, got ${w}`);
    out.set(k, 0);
  }
  if (total === 0) return out;

  const live = [...weights.entries()].filter(([, w]) => w > 0).sort(([a], [b]) => byKey(a, b));
  if (live.length === 0) throw new Error('cannot allocate a non-zero total with no positive weights');

  const sign = total < 0 ? -1 : 1;
  const abs = BigInt(Math.abs(total));
  const W = live.reduce((s, [, w]) => s + BigInt(w), 0n);

  let given = 0n;
  const rema: { key: string; rem: bigint }[] = [];
  for (const [k, w] of live) {
    const num = abs * BigInt(w);
    const share = num / W;
    given += share;
    out.set(k, sign * Number(share));
    rema.push({ key: k, rem: num % W });
  }

  let left = Number(abs - given); // always < live.length
  rema.sort((x, y) => (x.rem === y.rem ? byKey(x.key, y.key) : x.rem > y.rem ? -1 : 1));
  for (const { key } of rema) {
    if (left === 0) break;
    out.set(key, (out.get(key) ?? 0) + sign);
    left -= 1;
  }
  return out;
}

export function sumCents(xs: Iterable<Cents>): Cents {
  let s = 0;
  for (const x of xs) s += x;
  return s;
}

export function formatUsd(c: Cents): string {
  const sign = c < 0 ? '-' : '';
  const a = Math.abs(c);
  return `${sign}$${Math.floor(a / 100)}.${String(a % 100).padStart(2, '0')}`;
}
