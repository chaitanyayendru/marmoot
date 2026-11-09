import { describe, expect, it } from 'vitest';
import { applyTransfers } from '@marmoot/core';
import { linkAmount, parseDollars, usd } from './money.ts';
import { derive, reducer, transferKey, type Night, type Player, type State } from './model.ts';
import { payAction } from './payments.ts';
import { settleSummary, whatsappLink } from './share.ts';

const P = (id: string, handles: Player['handles'] = {}, cash = false): Player => ({ id, name: id[0]!.toUpperCase() + id.slice(1), handles, cash });

/** The 8-player night from the architecture doc, built as the app stores it. */
function docNight(): Night {
  const buy: Record<string, number> = { chai: 4000, ravi: 6000, meera: 2000, arjun: 4000, priya: 2000, dev: 6000, sana: 4000, kabir: 2000 };
  const out: Record<string, number> = { chai: 7000, ravi: 1000, meera: 7500, arjun: 1000, priya: 5000, dev: 500, sana: 500, kabir: 7500 };
  const venmo = (h: string) => ({ venmo: h });
  const players = [
    P('chai', { venmo: 'chai', zelle: 'chai@example.com' }), P('ravi', venmo('ravi')), P('meera', venmo('meera')), P('arjun', venmo('arjun')),
    P('priya', venmo('priya')), P('dev', { zelle: 'dev@example.com' }), P('sana', venmo('sana')), P('kabir', { zelle: '555-0100' }),
  ];
  let at = 0;
  const events: Night['events'] = [];
  for (const p of players) for (let c = 0; c < buy[p.id]! / 2000; c++) events.push({ id: `b${at}`, at: at++, kind: 'buyin', player: p.id, amount: 2000 });
  events.push({ id: 'c1', at: at++, kind: 'cash', from: 'meera', to: 'chai', amount: 2000 });
  events.push({ id: 'c2', at: at++, kind: 'cash', from: 'priya', to: 'chai', amount: 2000 });
  return { id: 'n', name: 'Friday poker', createdAt: 0, buyIn: 2000, mode: 'settle-later', tolerance: 0.01, hostId: 'chai', players, events, cashouts: out, paid: {} };
}

describe('money input', () => {
  it('parses what people type', () => {
    expect(parseDollars('20')).toBe(2000);
    expect(parseDollars('$12.5')).toBe(1250);
    expect(parseDollars('1,250.05')).toBe(125005);
    expect(parseDollars('0')).toBe(0);
    expect(parseDollars('')).toBeNull();
    expect(parseDollars('12.345')).toBeNull();
    expect(parseDollars('-5')).toBeNull();
    expect(parseDollars('abc')).toBeNull();
  });
  it('formats cents', () => {
    expect(usd(123456)).toBe('$1,234.56');
    expect(usd(-1000)).toBe('−$10.00');
    expect(linkAmount(5)).toBe('0.05');
  });
});

describe('poker night', () => {
  it('reproduces the doc example: 5 transfers, all on shared apps, greedy needs 7', () => {
    const d = derive(docNight());
    expect(d.pot).toBe(30000);
    expect(d.settlement.status).toBe('ready');
    if (d.settlement.status !== 'ready') return;
    expect(d.settlement.transfers).toHaveLength(5);
    expect(d.settlement.greedyCount).toBe(7);
    expect(d.settlement.matched).toBe('apps');
    const nets = new Map(d.settlement.lines.map((l) => [l.player, l.net]));
    expect([...applyTransfers(nets, d.settlement.transfers).values()].every((v) => v === 0)).toBe(true);
  });

  it('waits until every cash-out is entered', () => {
    const n = docNight();
    delete n.cashouts.dev;
    const d = derive(n);
    expect(d.settlement).toEqual({ status: 'waiting', missing: ['dev'] });
  });

  it('asks for a recount when chips are off by more than 1% of the pot', () => {
    const n = docNight();
    n.cashouts.chai = 7000 + 400; // $4 over on a $300 pot
    expect(derive(n).settlement.status).toBe('recount');
  });

  it('falls back to ignoring apps when someone has none entered', () => {
    const n = docNight();
    n.players = n.players.map((p) => (p.id === 'ravi' ? { ...p, handles: {} } : p));
    const d = derive(n);
    expect(d.settlement.status === 'ready' && d.settlement.matched).toBe('no-apps');
  });

  it('cash-to-host mode records the cash with the buy-in, and undo removes both', () => {
    let s: State = { nights: [] };
    s = reducer(s, { type: 'createNight', id: 'n', name: 'x', buyIn: 2000, mode: 'cash-to-host', at: 0 });
    s = reducer(s, { type: 'addPlayer', night: 'n', id: 'host', name: 'Host' });
    s = reducer(s, { type: 'addPlayer', night: 'n', id: 'ana', name: 'Ana' });
    s = reducer(s, { type: 'buyIn', night: 'n', player: 'ana', amount: 2000, ids: ['b1', 'c1'], at: 1 });
    s = reducer(s, { type: 'buyIn', night: 'n', player: 'host', amount: 2000, ids: ['b2', 'c2'], at: 2 });
    expect(s.nights[0]!.hostId).toBe('host');
    expect(s.nights[0]!.events.map((e) => e.kind)).toEqual(['buyin', 'cash', 'buyin']); // host paying the host is not a cash event
    s = reducer(s, { type: 'undo', night: 'n', event: 'b1' });
    expect(s.nights[0]!.events.map((e) => e.id)).toEqual(['b2']);
  });

  it('will not remove a player who has bought in', () => {
    let s: State = { nights: [] };
    s = reducer(s, { type: 'createNight', id: 'n', name: 'x', buyIn: 2000, mode: 'settle-later', at: 0 });
    s = reducer(s, { type: 'addPlayer', night: 'n', id: 'a', name: 'A' });
    s = reducer(s, { type: 'buyIn', night: 'n', player: 'a', amount: 2000, ids: ['b', 'c'], at: 1 });
    s = reducer(s, { type: 'removePlayer', night: 'n', player: 'a' });
    expect(s.nights[0]!.players).toHaveLength(1);
  });
});

describe('paying', () => {
  const t = { from: 'sana', to: 'meera', amount: 3500, rail: 'venmo' };
  it('builds a Venmo link with the amount and a private note', () => {
    const a = payAction(t, P('meera', { venmo: '@meera-k' }), 'Friday poker');
    expect(a).toEqual({
      kind: 'link', app: 'venmo', label: 'Pay on Venmo',
      href: 'https://venmo.com/meera-k?txn=pay&amount=35.00&note=Friday%20poker&audience=private',
    });
  });
  it('accepts pasted profile links as handles', () => {
    expect(payAction({ ...t, rail: 'paypal' }, P('m', { paypal: 'https://paypal.me/MeeraK' }), 'x')).toMatchObject({ href: 'https://paypal.me/MeeraK/35.00' });
    expect(payAction({ ...t, rail: 'cashapp' }, P('m', { cashapp: '$meera' }), 'x')).toMatchObject({ href: 'https://cash.app/$meera/35.00' });
  });
  it('offers Zelle details to copy, since Zelle has no payment links', () => {
    expect(payAction({ ...t, rail: 'zelle' }, P('m', { zelle: 'meera@example.com' }), 'x')).toMatchObject({ kind: 'copy', value: 'meera@example.com' });
  });
  it('writes a WhatsApp summary', () => {
    const n = docNight();
    const d = derive(n);
    if (d.settlement.status !== 'ready') throw new Error('not ready');
    const text = settleSummary(n, d.settlement.transfers, d.pot);
    expect(text).toContain('Friday poker: settle up');
    expect(text).toContain('Dev pays Kabir $55.00 (Zelle)');
    expect(text).toContain('Pot $300.00, 8 players.');
    expect(whatsappLink('a b')).toBe('https://wa.me/?text=a%20b');
  });
  it('keys transfers stably for marking them paid', () => {
    expect(transferKey(t)).toBe('sana>meera:3500');
  });
});
