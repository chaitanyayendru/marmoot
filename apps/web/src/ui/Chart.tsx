/**
 * Your running balance, drawn the way a brokerage draws a portfolio: one line,
 * green above zero, red below, with a dotted zero line for reference. Every point
 * is a real expense or payment.
 */
import { usd } from '../money.ts';

export function BalanceChart({ points, label }: { points: { date: string; value: number }[]; label: string }) {
  if (points.length < 2) return null;
  const values = [0, ...points.map((p) => p.value)];
  const min = Math.min(...values, 0);
  const max = Math.max(...values, 0);
  const span = max - min || 1;
  const W = 320, H = 96, pad = 6;
  const x = (i: number) => (i / (values.length - 1)) * W;
  const y = (v: number) => pad + (1 - (v - min) / span) * (H - pad * 2);
  const d = values.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
  const last = values.at(-1) ?? 0;
  const tone = last > 0 ? 'up' : last < 0 ? 'down' : 'flat';
  const lo = Math.min(...points.map((p) => p.value));
  const hi = Math.max(...points.map((p) => p.value));
  return (
    <figure className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`${label}: from ${usd(points[0]!.value)} to ${usd(last)}, low ${usd(lo)}, high ${usd(hi)}`}>
        <line x1="0" x2={W} y1={y(0)} y2={y(0)} className="chart-zero" vectorEffect="non-scaling-stroke" />
        <path d={d} className={`chart-line ${tone}`} vectorEffect="non-scaling-stroke" />
      </svg>
    </figure>
  );
}
