/**
 * Worked example used in the architecture doc: an 8-player poker night with rebuys,
 * two players paying the host in cash at the table, and two players who only use Zelle.
 *
 *   npm run example
 */
import { formatUsd } from '../src/money.ts';
import { settlePokerNight, type PokerEvent } from '../src/poker.ts';
import { greedySettle, minTransferSettle, type Rails, type Transfer } from '../src/settle.ts';

export const players = ['chai', 'ravi', 'meera', 'arjun', 'priya', 'dev', 'sana', 'kabir'] as const;

const buyins: Record<string, number> = { chai: 4000, ravi: 6000, meera: 2000, arjun: 4000, priya: 2000, dev: 6000, sana: 4000, kabir: 2000 };
const cashouts: Record<string, number> = { chai: 7000, ravi: 1000, meera: 7500, arjun: 1000, priya: 5000, dev: 500, sana: 500, kabir: 7500 };

export const events: PokerEvent[] = [
  ...players.map((p): PokerEvent => ({ kind: 'buyin', player: p, amount: buyins[p]! })),
  { kind: 'cash', from: 'meera', to: 'chai', amount: 2000 },
  { kind: 'cash', from: 'priya', to: 'chai', amount: 2000 },
  ...players.map((p): PokerEvent => ({ kind: 'cashout', player: p, amount: cashouts[p]! })),
];

export const rails: Rails = new Map([
  ['chai', ['venmo', 'zelle']],
  ['ravi', ['venmo']],
  ['meera', ['venmo']],
  ['arjun', ['venmo']],
  ['priya', ['venmo']],
  ['dev', ['zelle']],
  ['sana', ['venmo']],
  ['kabir', ['zelle']],
]);

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const night = settlePokerNight(events);
  console.log('player  bought-in  cashed-out  cash given  cash recv   net');
  for (const l of night.lines) {
    console.log(
      `${l.player.padEnd(7)} ${formatUsd(l.buyins).padStart(9)} ${formatUsd(l.cashouts).padStart(11)} ${formatUsd(l.cashGiven).padStart(11)} ${formatUsd(l.cashReceived).padStart(10)} ${formatUsd(l.net).padStart(8)}`,
    );
  }
  const show = (label: string, ts: Transfer[]) => {
    console.log(`\n${label}: ${ts.length} transfers`);
    for (const t of ts) {
      const ok = (rails.get(t.from) ?? []).some((r) => (rails.get(t.to) ?? []).includes(r));
      console.log(`  ${t.from.padEnd(6)} -> ${t.to.padEnd(6)} ${formatUsd(t.amount).padStart(7)}  ${t.rail ?? (ok ? '' : 'NO SHARED APP')}`);
    }
  };
  show('Greedy (biggest debtor pays biggest creditor)', greedySettle(night.nets));
  const exact = minTransferSettle(night.nets);
  show('Exact, ignoring payment apps', exact.transfers);
  const withRails = minTransferSettle(night.nets, { rails });
  show('Exact, only between people who share an app', withRails.transfers);
  console.log(`\nzero-sum groups: ${withRails.groups.map((g) => `{${g.join(', ')}}`).join(' ')}`);
}
