import type { Transfer } from '@marmoot/core';
import { usd } from './money.ts';
import { APP_NAMES, type Night, type PayApp } from './model.ts';

/** The message the host pastes into the group chat. Plain text, readable in WhatsApp. */
export function settleSummary(n: Night, transfers: Transfer[], pot: number): string {
  const name = (id: string) => n.players.find((p) => p.id === id)?.name ?? 'Someone';
  const lines = transfers.map((t) => {
    const app = t.rail ? ` (${APP_NAMES[t.rail as PayApp | 'cash'] ?? t.rail})` : '';
    return `${name(t.from)} pays ${name(t.to)} ${usd(t.amount)}${app}`;
  });
  const body = lines.length ? lines.join('\n') : 'Everyone broke even. Nobody pays anyone.';
  return `${n.name}: settle up\n\n${body}\n\nPot ${usd(pot)}, ${n.players.length} players.`;
}

export function whatsappLink(text: string): string {
  return `https://wa.me/?text=${encodeURIComponent(text)}`;
}
