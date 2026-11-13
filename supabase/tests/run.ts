/**
 * Database tests: applies the migrations to a throwaway Postgres and checks that
 *   - poker_nets() in SQL agrees with settlePokerNight() in @marmoot/core, cent for cent,
 *     on the worked example and on hundreds of random nights
 *   - split_amount() agrees with splitAmount() and next_due_date() with nextDue(),
 *     including which splits are refused and why
 *   - expenses post zero-sum balances, retries do not double-post, voids and edits
 *     reverse cleanly, and repeating bills post once per due date
 *   - the ledger and the event log are append-only
 *   - closing a night posts balances that sum to zero, and paying the solver's
 *     transfers brings every balance to zero
 *   - row-level security keeps other people's groups invisible
 *
 * Uses $DATABASE_URL if set (it must be a disposable database). Otherwise it starts
 * a temporary cluster with the Postgres binaries on this machine (PG_BIN, pg_config,
 * or /usr/lib/postgresql/<version>/bin), and skips with a message if there are none.
 *
 *   npm run test:db
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { applySchema, startCluster, stopCluster, supabaseDir } from './pg.ts';
import { setupSql } from '../setup-sql.ts';
import { randomUUID } from 'node:crypto';
import {
  DiscrepancyTooLarge,
  applyTransfers,
  expenseNets,
  minTransferSettle,
  nextDue,
  settlePokerNight,
  splitAmount,
  sumNets,
  type PokerEvent,
  type Split,
} from '../../packages/core/src/index.ts';

// ------------------------------------------------------------------ database lifecycle

// ------------------------------------------------------------------ helpers

let db: pg.Client;
const userA = '00000000-0000-4000-8000-00000000000a';
const userB = '00000000-0000-4000-8000-00000000000b';

/** Run fn as a signed-in Supabase user, inside one transaction, with RLS on. */
async function as<T>(user: string, fn: (q: (sql: string, params?: unknown[]) => Promise<pg.QueryResult>) => Promise<T>): Promise<T> {
  await db.query('begin');
  try {
    await db.query('set local role authenticated');
    await db.query("select set_config('request.jwt.claim.sub', $1, true)", [user]);
    const out = await fn((sql, params) => db.query(sql, params));
    await db.query('commit');
    return out;
  } catch (e) {
    await db.query('rollback');
    throw e;
  }
}

interface Night {
  group: string;
  session: string;
  people: Map<string, string>; // name -> uuid
}

async function makeNight(names: string[], tolerance = 0.01): Promise<Night> {
  return as(userA, async (q) => {
    const group = (await q("insert into groups (name) values ('Friday crew') returning id")).rows[0].id as string;
    const people = new Map<string, string>();
    for (const n of names) {
      people.set(n, (await q('insert into people (group_id, display_name) values ($1, $2) returning id', [group, n])).rows[0].id);
    }
    const session = (
      await q("insert into sessions (group_id, name, buy_in_cents, discrepancy_tolerance) values ($1, 'Friday poker', 2000, $2) returning id", [group, tolerance])
    ).rows[0].id as string;
    return { group, session, people };
  });
}

type Ev = { kind: 'buyin' | 'cashout'; who: string; amount: number } | { kind: 'cash'; from: string; to: string; amount: number };

async function addEvents(n: Night, evs: Ev[]): Promise<string[]> {
  return as(userA, async (q) => {
    const ids: string[] = [];
    for (const e of evs) {
      const r =
        e.kind === 'cash'
          ? await q("insert into poker_events (session_id, kind, person_id, to_person_id, amount_cents) values ($1, 'cash', $2, $3, $4) returning id", [n.session, n.people.get(e.from), n.people.get(e.to), e.amount])
          : await q('insert into poker_events (session_id, kind, person_id, amount_cents) values ($1, $2, $3, $4) returning id', [n.session, e.kind, n.people.get(e.who), e.amount]);
      ids.push(r.rows[0].id);
    }
    return ids;
  });
}

function coreEvents(n: Night, evs: Ev[]): PokerEvent[] {
  // The database counts a player's latest cash-out; core adds them up, so pass only the latest.
  const lastCashout = new Map<string, number>();
  evs.forEach((e, i) => { if (e.kind === 'cashout') lastCashout.set(e.who, i); });
  return evs.flatMap((e, i): PokerEvent[] => {
    if (e.kind === 'cash') return [{ kind: 'cash', from: n.people.get(e.from)!, to: n.people.get(e.to)!, amount: e.amount }];
    if (e.kind === 'cashout' && lastCashout.get(e.who) !== i) return [];
    return [{ kind: e.kind, player: n.people.get(e.who)!, amount: e.amount }];
  });
}

async function sqlNets(n: Night) {
  return as(userA, async (q) => (await q('select * from poker_nets($1)', [n.session])).rows as { person_id: string; adjustment: string; net: string }[]);
}

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------------ tests

let url: string | null = null;

before(async () => {
  url = await startCluster();
  if (!url) {
    console.log('# database tests skipped: no Postgres found. Install PostgreSQL 16 or newer, or set PG_BIN or DATABASE_URL.');
    return;
  }
  db = new pg.Client({ connectionString: url });
  await db.connect();
  await applySchema(db);
  await db.query('insert into auth.users (id) values ($1), ($2)', [userA, userB]);
});

after(async () => {
  await db?.end();
  await stopCluster();
});

describe('database', () => {
  test('setup', (t) => {
    if (!url) t.skip('no Postgres binaries found and no DATABASE_URL set; skipping database tests');
  });

  const names = ['chai', 'ravi', 'meera', 'arjun', 'priya', 'dev', 'sana', 'kabir'];
  const buy: Record<string, number> = { chai: 2, ravi: 3, meera: 1, arjun: 2, priya: 1, dev: 3, sana: 2, kabir: 1 };
  const out: Record<string, number> = { chai: 7000, ravi: 1000, meera: 7500, arjun: 1000, priya: 5000, dev: 500, sana: 500, kabir: 7500 };
  const docEvents: Ev[] = [
    ...names.flatMap((w) => Array.from({ length: buy[w]! }, (): Ev => ({ kind: 'buyin', who: w, amount: 2000 }))),
    { kind: 'cash', from: 'meera', to: 'chai', amount: 2000 },
    { kind: 'cash', from: 'priya', to: 'chai', amount: 2000 },
    ...names.map((w): Ev => ({ kind: 'cashout', who: w, amount: out[w]! })),
  ];

  test('poker_nets matches core on the worked example', async (t) => {
    if (!url) return t.skip();
    const n = await makeNight(names);
    await addEvents(n, docEvents);
    const rows = await sqlNets(n);
    const core = settlePokerNight(coreEvents(n, docEvents));
    assert.equal(rows.length, 8);
    for (const r of rows) assert.equal(Number(r.net), core.nets.get(r.person_id), r.person_id);
    assert.equal(Number(rows.find((r) => r.person_id === n.people.get('chai'))!.net), -1000);
  });

  test('poker_nets matches core cent for cent on 300 random nights', async (t) => {
    if (!url) return t.skip();
    const rng = mulberry32(2026);
    let withGap = 0;
    for (let k = 0; k < 300; k++) {
      const players = Array.from({ length: 2 + Math.floor(rng() * 8) }, (_, i) => `p${i}`);
      const n = await makeNight(players, [0.01, 0.02, 0.05][k % 3]!);
      const evs: Ev[] = [];
      for (const p of players) for (let c = 0; c < 1 + Math.floor(rng() * 3); c++) evs.push({ kind: 'buyin', who: p, amount: [500, 1000, 2000, 2500][Math.floor(rng() * 4)]! });
      if (players.length > 2 && rng() < 0.6) evs.push({ kind: 'cash', from: players[1]!, to: players[0]!, amount: 1000 + Math.floor(rng() * 4) * 500 });
      const pot = evs.reduce((s, e) => (e.kind === 'buyin' ? s + e.amount : s), 0);
      const limit = Math.floor(pot * [0.01, 0.02, 0.05][k % 3]!);
      const gap = rng() < 0.5 ? 0 : Math.round((rng() * 2 - 1) * limit);
      if (gap !== 0) withGap++;
      // Random split of pot + gap into cash-outs, plus a corrected cash-out now and then.
      let left = pot + gap;
      players.forEach((p, i) => {
        const amt = i === players.length - 1 ? left : Math.min(left, Math.floor(rng() * (left / 2)));
        left -= amt;
        if (rng() < 0.15) evs.push({ kind: 'cashout', who: p, amount: amt + 700 });
        evs.push({ kind: 'cashout', who: p, amount: amt });
      });
      await addEvents(n, evs);
      const rows = await sqlNets(n);
      const core = settlePokerNight(coreEvents(n, evs), { discrepancyTolerance: [0.01, 0.02, 0.05][k % 3]! });
      const adj = new Map(core.lines.map((l) => [l.player, l.adjustment]));
      for (const r of rows) {
        assert.equal(Number(r.net), core.nets.get(r.person_id), `night ${k}, ${r.person_id}: net`);
        assert.equal(Number(r.adjustment), adj.get(r.person_id), `night ${k}, ${r.person_id}: adjustment`);
      }
      assert.equal(rows.reduce((s, r) => s + Number(r.net), 0), 0);
    }
    assert.ok(withGap > 100, 'enough nights exercised the discrepancy split');
  });

  test('a chip count beyond the tolerance is refused, as in core', async (t) => {
    if (!url) return t.skip();
    const n = await makeNight(['a', 'b']);
    const evs: Ev[] = [{ kind: 'buyin', who: 'a', amount: 2000 }, { kind: 'buyin', who: 'b', amount: 2000 }, { kind: 'cashout', who: 'a', amount: 3000 }, { kind: 'cashout', who: 'b', amount: 1500 }];
    await addEvents(n, evs);
    await assert.rejects(sqlNets(n), /off by 500 cents/);
    assert.throws(() => settlePokerNight(coreEvents(n, evs)), DiscrepancyTooLarge);
  });

  test('voided buy-ins stop counting; a void cannot be voided', async (t) => {
    if (!url) return t.skip();
    const n = await makeNight(['a', 'b']);
    const [b1] = await addEvents(n, [{ kind: 'buyin', who: 'a', amount: 2000 }, { kind: 'buyin', who: 'b', amount: 2000 }]);
    const v = await as(userA, async (q) => (await q("insert into poker_events (session_id, kind, voids_event_id) values ($1, 'void', $2) returning id", [n.session, b1])).rows[0].id as string);
    await addEvents(n, [{ kind: 'cashout', who: 'a', amount: 0 }, { kind: 'cashout', who: 'b', amount: 2000 }]);
    const rows = await sqlNets(n);
    assert.equal(rows.reduce((s, r) => s + Number(r.net), 0), 0);
    assert.equal(Number(rows.find((r) => r.person_id === n.people.get('a'))?.net ?? 0), 0);
    await assert.rejects(as(userA, (q) => q("insert into poker_events (session_id, kind, voids_event_id) values ($1, 'void', $2)", [n.session, v])), /can only void/);
  });

  test('the event log and ledger are append-only, even for the database owner', async (t) => {
    if (!url) return t.skip();
    const n = await makeNight(['a', 'b']);
    await addEvents(n, [{ kind: 'buyin', who: 'a', amount: 2000 }]);
    await assert.rejects(db.query('update poker_events set amount_cents = 1 where session_id = $1', [n.session]), /append-only/);
    await assert.rejects(db.query('delete from poker_events where session_id = $1', [n.session]), /append-only/);
  });

  test('closing posts zero-sum balances; paying the solver’s plan clears them', async (t) => {
    if (!url) return t.skip();
    const n = await makeNight(names);
    await addEvents(n, docEvents);
    const posted = await as(userA, async (q) => (await q('select * from close_poker_session($1)', [n.session])).rows);
    assert.equal(posted.reduce((s, r) => s + Number(r.amount_cents), 0), 0);
    assert.equal(posted.length, 8);

    await assert.rejects(as(userA, (q) => q('select * from close_poker_session($1)', [n.session])), /already closed/);
    await assert.rejects(addEvents(n, [{ kind: 'buyin', who: 'chai', amount: 2000 }]), /is closed/);

    const balances = await as(userA, async (q) => (await q('select person_id, balance_cents from session_balances where session_id = $1', [n.session])).rows);
    const nets = new Map(balances.map((r) => [r.person_id as string, Number(r.balance_cents)]));
    const plan = minTransferSettle(nets);
    assert.equal(plan.transfers.length, 5);
    await as(userA, async (q) => {
      for (const tr of plan.transfers) {
        await q("insert into transfers (group_id, session_id, from_person_id, to_person_id, amount_cents, rail) values ($1, $2, $3, $4, $5, 'venmo')", [n.group, n.session, tr.from, tr.to, tr.amount]);
      }
    });
    const after = await as(userA, async (q) => (await q('select balance_cents from balances where group_id = $1', [n.group])).rows);
    assert.ok(after.every((r) => Number(r.balance_cents) === 0), 'every balance is zero after paying');
    assert.ok([...applyTransfers(nets, plan.transfers).values()].every((v) => v === 0));
  });

  test('a night with a missing cash-out cannot close', async (t) => {
    if (!url) return t.skip();
    const n = await makeNight(['a', 'b']);
    await addEvents(n, [{ kind: 'buyin', who: 'a', amount: 2000 }, { kind: 'buyin', who: 'b', amount: 2000 }, { kind: 'cashout', who: 'a', amount: 4000 }]);
    await assert.rejects(as(userA, (q) => q('select * from close_poker_session($1)', [n.session])), /still need a cash-out/);
  });

  test('row-level security: a non-member sees nothing and can change nothing', async (t) => {
    if (!url) return t.skip();
    const n = await makeNight(['a', 'b']);
    await addEvents(n, [{ kind: 'buyin', who: 'a', amount: 2000 }]);
    const seen = await as(userB, async (q) => ({
      groups: (await q('select 1 from groups where id = $1', [n.group])).rowCount,
      sessions: (await q('select 1 from sessions where id = $1', [n.session])).rowCount,
      events: (await q('select 1 from poker_events where session_id = $1', [n.session])).rowCount,
      people: (await q('select 1 from people where group_id = $1', [n.group])).rowCount,
    }));
    assert.deepEqual(seen, { groups: 0, sessions: 0, events: 0, people: 0 });
    await assert.rejects(
      as(userB, (q) => q("insert into poker_events (session_id, kind, person_id, amount_cents) values ($1, 'buyin', $2, 100)", [n.session, n.people.get('a')])),
      /row-level security/,
    );
    await assert.rejects(as(userB, (q) => q('select * from close_poker_session($1)', [n.session])), /not found/);
  });

  test('members cannot write the ledger directly', async (t) => {
    if (!url) return t.skip();
    const n = await makeNight(['a']);
    await assert.rejects(
      as(userA, (q) => q("insert into ledger_entries (group_id, person_id, amount_cents, currency, source, source_id) values ($1, $2, 100, 'USD', 'poker', $1)", [n.group, n.people.get('a')])),
      /permission denied/,
    );
  });
});

// ------------------------------------------------------------------ everyday expenses

interface Flat {
  group: string;
  people: Map<string, string>; // name -> uuid
}

async function makeFlat(names: string[], tz = 'UTC'): Promise<Flat> {
  return as(userA, async (q) => {
    const group = (await q('insert into groups (name, time_zone) values ($1, $2) returning id', ['Flat 4B', tz])).rows[0].id as string;
    const people = new Map<string, string>();
    for (const n of names) people.set(n, (await q('insert into people (group_id, display_name) values ($1, $2) returning id', [group, n])).rows[0].id);
    return { group, people };
  });
}

async function addExpense(f: Flat, paidBy: string, amount: number, split: Split, extra: { id?: string; on?: string } = {}) {
  return as(userA, async (q) =>
    (await q('select * from add_expense(p_group => $1, p_description => $2, p_amount_cents => $3, p_paid_by => $4, p_split => $5, p_spent_on => $6, p_category => $7, p_id => $8)', [
      f.group, 'Groceries', amount, f.people.get(paidBy), JSON.stringify(split), extra.on ?? null, 'groceries', extra.id ?? null,
    ])).rows[0] as { id: string; voided_at: string | null; replaces_id: string | null },
  );
}

async function groupBalances(f: Flat): Promise<Map<string, number>> {
  const rows = await as(userA, async (q) => (await q('select person_id, balance_cents from balances where group_id = $1', [f.group])).rows);
  return new Map(rows.map((r) => [r.person_id as string, Number(r.balance_cents)]).filter(([, v]) => v !== 0) as [string, number][]);
}

const nonZero = (m: Map<string, number>) => new Map([...m].filter(([, v]) => v !== 0));

/** Run core's splitAmount, returning the shares or the message a person would see. */
function coreSplit(total: number, split: Split): Map<string, number> | string {
  try {
    return splitAmount(total, split);
  } catch (e) {
    return (e as Error).message;
  }
}

async function sqlSplit(total: number, split: unknown): Promise<Map<string, number> | string> {
  try {
    const rows = (await db.query('select person_id, share_cents from split_amount($1, $2)', [total, JSON.stringify(split)])).rows;
    return new Map(rows.map((r) => [r.person_id as string, Number(r.share_cents)]));
  } catch (e) {
    return (e as Error).message;
  }
}

describe('expenses', () => {
  test('split_amount matches core on 600 random splits, refusals included', async (t) => {
    if (!url) return t.skip();
    const rng = mulberry32(1109);
    const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rng() * xs.length)]!;
    const counts = { ok: 0, refused: 0 };
    for (let k = 0; k < 600; k++) {
      const ids = Array.from({ length: 1 + Math.floor(rng() * 7) }, () => randomUUID());
      const total = rng() < 0.03 ? 0 : 1 + Math.floor(rng() * (rng() < 0.5 ? 200 : 500000));
      const method = pick(['equal', 'exact', 'percent', 'shares'] as const);
      let split: Split;
      if (method === 'equal') {
        const among = ids.filter(() => rng() < 0.7);
        if (rng() < 0.2 && among.length) among.push(among[0]!); // a duplicate counts once
        split = { method, among };
      } else if (method === 'exact') {
        const amounts: Record<string, number> = {};
        let left = total;
        ids.forEach((id, i) => {
          const a = i === ids.length - 1 ? left : Math.floor(rng() * (left + 1));
          amounts[id] = a;
          left -= a;
        });
        if (rng() < 0.25) amounts[ids[0]!] = (amounts[ids[0]!] ?? 0) + pick([-7, 1, 250, 99999]);
        split = { method, amounts };
      } else if (method === 'percent') {
        const basisPoints: Record<string, number> = {};
        let left = 10000;
        ids.forEach((id, i) => {
          const b = i === ids.length - 1 ? left : Math.floor(rng() * (left + 1));
          basisPoints[id] = b;
          left -= b;
        });
        if (rng() < 0.25) basisPoints[ids[0]!] = (basisPoints[ids[0]!] ?? 0) + pick([-50, 50, 1, 2.5, 3000]);
        split = { method, basisPoints };
      } else {
        const shares: Record<string, number> = {};
        for (const id of ids) shares[id] = pick([0, 1, 1, 1, 2, 3, 7]);
        if (rng() < 0.1) shares[ids[0]!] = pick([1.5, -1]);
        split = { method, shares };
      }
      const want = coreSplit(total, split);
      const got = await sqlSplit(total, split);
      if (typeof want === 'string') {
        counts.refused++;
        assert.equal(got, want, `case ${k}: ${JSON.stringify({ total, split })}`);
      } else {
        counts.ok++;
        assert.ok(typeof got !== 'string', `case ${k}: SQL refused (${got}) what core accepted: ${JSON.stringify({ total, split })}`);
        assert.deepEqual(nonZero(got), nonZero(want), `case ${k}: ${JSON.stringify({ total, split })}`);
      }
    }
    assert.ok(counts.ok > 350 && counts.refused > 60, `exercised both paths: ${JSON.stringify(counts)}`);
  });

  test('next_due_date matches core, and a bill on the 31st comes back to the 31st', async (t) => {
    if (!url) return t.skip();
    const rng = mulberry32(31);
    for (let k = 0; k < 400; k++) {
      const day = 1 + Math.floor(rng() * 31);
      const d = new Date(Date.UTC(2024 + Math.floor(rng() * 6), Math.floor(rng() * 12), 1 + Math.floor(rng() * 28)));
      const from = d.toISOString().slice(0, 10);
      const every = rng() < 0.3 ? 'week' : 'month';
      const got = (await db.query("select to_char(next_due_date($1::date, $2, $3::smallint), 'YYYY-MM-DD') as d", [from, every, day])).rows[0].d;
      assert.equal(got, nextDue(from, every, day), `${from} ${every} anchor ${day}`);
    }
    const chain = (await db.query(`
      with recursive c(d, n) as (select date '2027-01-31', 0 union all select next_due_date(d, 'month', 31::smallint), n + 1 from c where n < 4)
      select string_agg(to_char(d, 'MM-DD'), ' ' order by n) as s from c`)).rows[0].s;
    assert.equal(chain, '01-31 02-28 03-31 04-30 05-31');
  });

  test('expenses post zero-sum balances that match core; a retried add is not counted twice', async (t) => {
    if (!url) return t.skip();
    const f = await makeFlat(['you', 'ravi', 'meera', 'sana']);
    const id = (n: string) => f.people.get(n)!;
    const all = ['you', 'ravi', 'meera', 'sana'].map(id);
    const entered: [string, number, Split][] = [
      ['you', 320000, { method: 'percent', basisPoints: { [id('you')]: 3000, [id('ravi')]: 2500, [id('meera')]: 2500, [id('sana')]: 2000 } }],
      ['meera', 18642, { method: 'equal', among: all }],
      ['ravi', 14388, { method: 'equal', among: all }],
      ['you', 6417, { method: 'shares', shares: { [id('you')]: 1, [id('ravi')]: 1, [id('meera')]: 2 } }],
      ['sana', 8450, { method: 'exact', amounts: { [id('you')]: 2250, [id('meera')]: 3100, [id('sana')]: 3100 } }],
    ];
    const clientId = randomUUID();
    for (const [i, [who, amount, split]] of entered.entries()) await addExpense(f, who, amount, split, i === 1 ? { id: clientId } : {});
    const again = await addExpense(f, 'meera', 18642, entered[1]![2], { id: clientId });
    assert.equal(again.id, clientId);

    const want = nonZero(sumNets(entered.map(([who, amount, split]) => expenseNets(id(who), amount, split))));
    const got = await groupBalances(f);
    assert.deepEqual(got, want);
    assert.equal([...got.values()].reduce((s, v) => s + v, 0), 0);
    const count = await as(userA, async (q) => (await q('select count(*)::int as n from expenses where group_id = $1', [f.group])).rows[0].n);
    assert.equal(count, 5);
  });

  test('a split with someone outside the group, or a bad split, records nothing', async (t) => {
    if (!url) return t.skip();
    const f = await makeFlat(['you', 'ravi']);
    const other = await makeFlat(['stranger']);
    await assert.rejects(addExpense(f, 'you', 1000, { method: 'equal', among: [f.people.get('you')!, other.people.get('stranger')!] }), /must be in this group/);
    await assert.rejects(addExpense(f, 'you', 1000, { method: 'exact', amounts: { [f.people.get('you')!]: 580 } }), /\$4\.20 still to assign\./);
    await assert.rejects(
      as(userA, (q) => q('select add_expense($1, $2, $3, $4, $5)', [f.group, 'Lunch', 1000, other.people.get('stranger'), JSON.stringify({ method: 'equal', among: [f.people.get('you')] })])),
      /who paid is not in this group/,
    );
    assert.equal((await groupBalances(f)).size, 0);
  });

  test('voiding reverses an expense; editing is a void plus a corrected expense; rows never change otherwise', async (t) => {
    if (!url) return t.skip();
    const f = await makeFlat(['you', 'ravi']);
    const both = [f.people.get('you')!, f.people.get('ravi')!];
    const e = await addExpense(f, 'you', 5000, { method: 'equal', among: both });
    assert.deepEqual(await groupBalances(f), new Map([[both[0]!, 2500], [both[1]!, -2500]]));

    const edited = await as(userA, async (q) =>
      (await q('select * from edit_expense($1, $2, $3, $4, $5, $6, $7)', [e.id, 'Groceries', 6000, both[0], JSON.stringify({ method: 'equal', among: both }), '2026-11-08', 'groceries'])).rows[0],
    );
    assert.equal(edited.replaces_id, e.id);
    assert.deepEqual(await groupBalances(f), new Map([[both[0]!, 3000], [both[1]!, -3000]]));
    await assert.rejects(as(userA, (q) => q('select void_expense($1)', [e.id])), /already void/);

    await as(userA, (q) => q('select void_expense($1)', [edited.id]));
    assert.equal((await groupBalances(f)).size, 0);

    await assert.rejects(db.query('update expenses set amount_cents = 1 where id = $1', [e.id]), /cannot be edited/);
    await assert.rejects(db.query('delete from expenses where id = $1', [e.id]), /append-only/);
    await assert.rejects(db.query('update expense_shares set share_cents = 1 where expense_id = $1', [e.id]), /append-only/);
  });

  test('repeating bills: fixed ones post once per due date, variable ones wait for an amount', async (t) => {
    if (!url) return t.skip();
    const f = await makeFlat(['you', 'ravi']);
    const both = [f.people.get('you')!, f.people.get('ravi')!];
    const equal = JSON.stringify({ method: 'equal', among: both });
    const [rent, power] = await as(userA, async (q) => [
      (await q("insert into recurring_bills (group_id, description, category, amount_cents, paid_by, split, every, next_due) values ($1, 'Rent', 'rent', 200000, $2, $3, 'month', '2027-01-31') returning id, anchor_day", [f.group, both[0], equal])).rows[0],
      (await q("insert into recurring_bills (group_id, description, category, amount_cents, paid_by, split, every, next_due) values ($1, 'Electricity', 'utilities', null, $2, $3, 'month', '2027-02-10') returning id", [f.group, both[1], equal])).rows[0],
    ]);
    assert.equal(rent.anchor_day, 31);

    const first = (await db.query("select recurring_id, to_char(due_on, 'YYYY-MM-DD') as due_on, expense_id from run_recurring($1, '2027-04-05')", [f.group])).rows;
    const rentDates = first.filter((r) => r.recurring_id === rent.id).map((r) => r.due_on);
    assert.deepEqual(rentDates, ['2027-01-31', '2027-02-28', '2027-03-31']);
    assert.deepEqual(first.filter((r) => r.recurring_id === power.id).map((r) => [r.due_on, r.expense_id]), [['2027-02-10', null], ['2027-03-10', null]]);
    assert.equal((await db.query("select * from run_recurring($1, '2027-04-05')", [f.group])).rowCount, 0, 'a second run posts nothing');
    const next = (await db.query("select to_char(next_due, 'YYYY-MM-DD') as d from recurring_bills where id = $1", [rent.id])).rows[0].d;
    assert.equal(next, '2027-04-30');
    assert.deepEqual(await groupBalances(f), new Map([[both[0]!, 300000], [both[1]!, -300000]]));

    await as(userA, (q) => q("select resolve_due_bill($1, '2027-02-10', 9000)", [power.id]));
    await as(userA, (q) => q("select resolve_due_bill($1, '2027-03-10')", [power.id]));
    await assert.rejects(as(userA, (q) => q("select resolve_due_bill($1, '2027-03-10', 100)", [power.id])), /already skipped/);
    assert.deepEqual(await groupBalances(f), new Map([[both[0]!, 300000 - 4500], [both[1]!, -300000 + 4500]]));

    await assert.rejects(
      as(userA, (q) => q("insert into recurring_bills (group_id, description, amount_cents, paid_by, split, every, next_due) values ($1, 'Water', null, $2, $3, 'month', '2027-01-01')", [f.group, both[0], JSON.stringify({ method: 'exact', amounts: { [both[0]!]: 100 } })])),
      /cannot be split by exact amounts/,
    );

    // A member can catch up their own group; the scheduled-job entry point is not theirs to call.
    await as(userA, (q) => q('select * from catch_up_recurring($1)', [f.group]));
    await assert.rejects(as(userA, (q) => q("select * from run_recurring($1, '2030-01-01')", [f.group])), /permission denied/);
    await assert.rejects(as(userA, (q) => q('select catch_up_all_recurring()')), /permission denied/);
  });

  test('row-level security for expenses, and phone numbers in international format', async (t) => {
    if (!url) return t.skip();
    const f = await makeFlat(['you', 'ravi']);
    const both = [f.people.get('you')!, f.people.get('ravi')!];
    const e = await addExpense(f, 'you', 1000, { method: 'equal', among: both });
    const seen = await as(userB, async (q) => ({
      expenses: (await q('select 1 from expenses where id = $1', [e.id])).rowCount,
      shares: (await q('select 1 from expense_shares where expense_id = $1', [e.id])).rowCount,
    }));
    assert.deepEqual(seen, { expenses: 0, shares: 0 });
    await assert.rejects(as(userB, (q) => q('select add_expense($1, $2, $3, $4, $5)', [f.group, 'Lunch', 1000, both[0], JSON.stringify({ method: 'equal', among: both })])), /not found/);
    await assert.rejects(as(userB, (q) => q('select void_expense($1)', [e.id])), /not found/);
    await assert.rejects(
      as(userA, (q) => q("insert into expenses (group_id, description, spent_on, amount_cents, currency, paid_by, split, created_by) values ($1, 'x', '2026-11-08', 1, 'USD', $2, '{}', $3)", [f.group, both[0], userA])),
      /permission denied/,
    );

    await as(userA, (q) => q("update people set phone = '+14045550101' where id = $1", [both[1]]));
    await assert.rejects(as(userA, (q) => q("update people set phone = '404-555-0101' where id = $1", [both[1]])), /people_phone_check/);
  });
});

// ------------------------------------------------------------------ bill sheets

/** Run fn as a Supabase API role (anon by default), inside one transaction. */
async function asRole<T>(role: 'anon' | 'service_role', fn: (q: (sql: string, params?: unknown[]) => Promise<pg.QueryResult>) => Promise<T>): Promise<T> {
  await db.query('begin');
  try {
    await db.query(`set local role ${role}`);
    const out = await fn((sql, params) => db.query(sql, params));
    await db.query('commit');
    return out;
  } catch (e) {
    await db.query('rollback');
    throw e;
  }
}

interface SheetView {
  sheet: { id: string; title: string; status: string; tax_cents: number; default_in: boolean };
  me: { id: string; is_owner: boolean };
  people: { id: string; name: string; is_owner: boolean; phone: string | null; token: string | null; alert_status: string | null; out_of_bill: boolean; viewed_at: string | null; responded_at: string | null }[];
  items: { id: string; name: string; price_cents: number }[];
  choices: { item_id: string; person_id: string; is_in: boolean }[];
  events: { kind: string; person_id: string | null; actor_id: string | null; item_id: string | null }[];
}

const anon = <T,>(sql: string, params: unknown[] = []) => asRole('anon', async (q) => (await q(sql, params)).rows as T[]);
const view = async (token: string) => (await anon<{ v: SheetView }>('select bill_sheet($1) as v', [token]))[0]!.v;

async function costcoSheet() {
  const created = (await anon<{ r: { sheet_id: string; owner_token: string; people: { id: string; name: string; token: string }[] } }>(
    'select create_bill_sheet($1, $2, $3, $4) as r',
    [
      'Costco',
      JSON.stringify([{ name: 'Chai', phone: '+14045550100', owner: true }, { name: 'Chandu', phone: '+919845012345' }, { name: 'Hima' }]),
      JSON.stringify([{ name: 'Tomatoes', price: 600 }, { name: 'Onions', price: 300 }, { name: 'Rice', price: 1000 }]),
      190,
    ],
  ))[0]!.r;
  const token = (name: string) => created.people.find((p) => p.name === name)!.token;
  return { ...created, chai: created.owner_token, chandu: token('Chandu'), hima: token('Hima') };
}

describe('bill sheets', () => {
  test('anyone can start a sheet; guests see every cell but no phones, links or activity', async (t) => {
    if (!url) return t.skip();
    const s = await costcoSheet();
    assert.equal(s.people.length, 3);
    assert.match(s.hima, /^[A-Za-z0-9_-]{22}$/);
    const guest = await view(s.hima);
    assert.equal(guest.me.is_owner, false);
    assert.equal(guest.items.length, 3);
    assert.ok(guest.people.every((p) => p.phone === null && p.token === null && p.alert_status === null));
    assert.deepEqual(guest.events, []);
    const owner = await view(s.chai);
    assert.equal(owner.people.find((p) => p.name === 'Chandu')!.phone, '+919845012345');
    assert.equal(owner.people.find((p) => p.name === 'Hima')!.token, s.hima);
    assert.deepEqual(owner.events.map((e) => e.kind), ['created']);
    await assert.rejects(view('not-a-real-token-00000'), /link is not valid/);
  });

  test('Hima keeps tomatoes and drops onions; people change only their own column; the owner can change any', async (t) => {
    if (!url) return t.skip();
    const s = await costcoSheet();
    const v0 = await view(s.hima);
    const item = (n: string) => v0.items.find((i) => i.name === n)!.id;
    const person = (n: string) => v0.people.find((p) => p.name === n)!.id;

    await anon('select mark_bill_viewed($1)', [s.hima]);
    await anon('select mark_bill_viewed($1)', [s.hima]);
    await anon('select set_bill_choice($1, $2, false)', [s.hima, item('Onions')]);
    await anon('select set_bill_choice($1, $2, false)', [s.hima, item('Onions')]); // no-op, no second event
    await anon('select mark_bill_done($1)', [s.hima]);
    await assert.rejects(anon('select set_bill_choice($1, $2, false, $3)', [s.hima, item('Rice'), person('Chandu')]), /only change your own/);
    await anon('select set_bill_choice($1, $2, false, $3)', [s.chai, item('Rice'), person('Chandu')]);

    const owner = await view(s.chai);
    assert.deepEqual(
      owner.choices.map((c) => [owner.items.find((i) => i.id === c.item_id)!.name, owner.people.find((p) => p.id === c.person_id)!.name, c.is_in]).sort(),
      [['Onions', 'Hima', false], ['Rice', 'Chandu', false]],
    );
    const hima = owner.people.find((p) => p.name === 'Hima')!;
    assert.ok(hima.viewed_at && hima.responded_at);
    assert.deepEqual(owner.events.map((e) => e.kind).reverse(), ['created', 'viewed', 'out', 'done', 'out']);
    const rice = owner.events.find((e) => e.item_id === item('Rice'))!;
    assert.deepEqual([rice.person_id, rice.actor_id], [person('Chandu'), person('Chai')]);
  });

  test('out of the whole bill, back in by ticking an item; a closed sheet refuses changes', async (t) => {
    if (!url) return t.skip();
    const s = await costcoSheet();
    const v0 = await view(s.chandu);
    await anon('select set_out_of_bill($1, true)', [s.chandu]);
    assert.equal((await view(s.chai)).people.find((p) => p.name === 'Chandu')!.out_of_bill, true);
    await anon('select set_bill_choice($1, $2, true)', [s.chandu, v0.items[0]!.id]);
    assert.equal((await view(s.chai)).people.find((p) => p.name === 'Chandu')!.out_of_bill, false);

    await assert.rejects(anon('select close_bill_sheet($1)', [s.chandu]), /Only the person who shared/);
    await anon('select close_bill_sheet($1)', [s.chai]);
    assert.equal((await view(s.hima)).sheet.status, 'closed');
    await assert.rejects(anon('select set_bill_choice($1, $2, false)', [s.hima, v0.items[0]!.id]), /closed/);
    await assert.rejects(anon('select add_bill_item($1, $2, $3)', [s.chai, 'Milk', 450]), /closed/);
    await anon('select close_bill_sheet($1, false)', [s.chai]);
    await anon('select add_bill_item($1, $2, $3)', [s.chai, 'Milk', 450]);
    const after = await view(s.hima);
    assert.deepEqual(after.items.map((i) => i.name), ['Tomatoes', 'Onions', 'Rice', 'Milk']);
    await anon('select remove_bill_item($1, $2)', [s.chai, after.items[1]!.id]);
    assert.deepEqual((await view(s.hima)).items.map((i) => i.name), ['Tomatoes', 'Rice', 'Milk']);
    await assert.rejects(anon('select add_bill_item($1, $2, $3)', [s.hima, 'Chips', 300]), /Only the person who shared/);
  });

  test('WhatsApp alerts: only the server queues them; statuses only move forward', async (t) => {
    if (!url) return t.skip();
    const s = await costcoSheet();
    await assert.rejects(anon('select * from queue_bill_alerts($1)', [s.chai]), /permission denied/);
    await assert.rejects(anon("select record_whatsapp_status('x', 'read')"), /permission denied/);

    const queued = await asRole('service_role', async (q) => (await q('select * from queue_bill_alerts($1)', [s.chai])).rows);
    assert.deepEqual(queued.map((r) => [r.person_name, r.to_phone, r.owner_name, r.sheet_title, Number(r.sheet_total_cents)]), [['Chandu', '+919845012345', 'Chai', 'Costco', 2090]]);
    const again = await asRole('service_role', async (q) => (await q('select * from queue_bill_alerts($1)', [s.chai])).rows);
    assert.equal(again.length, 0, 'not messaged twice');

    const svc = (sql: string, params: unknown[]) => asRole('service_role', (q) => q(sql, params));
    await svc("select record_alert($1, 'sent', 'wamid.1')", [queued[0]!.outbox_id]);
    await svc("select record_whatsapp_status('wamid.1', 'read')", []);
    await svc("select record_whatsapp_status('wamid.1', 'delivered')", []);
    const people = (await view(s.chai)).people;
    assert.equal(people.find((p) => p.name === 'Chandu')!.alert_status, 'read');
    assert.equal(people.find((p) => p.name === 'Hima')!.alert_status, 'no_phone');
    assert.deepEqual((await view(s.chai)).events.map((e) => e.kind).reverse(), ['created', 'alert_queued', 'alert_sent', 'alert_read']);

    await asRole('anon', (q) => q('select set_bill_person_phone($1, $2, $3)', [s.chai, people.find((p) => p.name === 'Hima')!.id, '+14045550199']));
    const second = await asRole('service_role', async (q) => (await q('select * from queue_bill_alerts($1)', [s.chai])).rows);
    assert.deepEqual(second.map((r) => r.person_name), ['Hima']);
  });

  test('sheet tables are closed to the API; only the functions reach them', async (t) => {
    if (!url) return t.skip();
    await costcoSheet();
    for (const table of ['bill_sheets', 'bill_people', 'bill_items', 'bill_choices', 'bill_events', 'whatsapp_outbox']) {
      await assert.rejects(anon(`select * from ${table}`), /permission denied/, table);
    }
  });
});

describe('shared groups', () => {
  const userC = '00000000-0000-4000-8000-00000000000c';
  const snapshot = (id: string) => ({ id, name: 'Flat 4B', createdAt: 1, me: 'm0', members: [{ id: 'm0', name: 'Chai', phone: '', handles: {}, cash: false, userId: userA }], items: [], recurring: [], due: [] });
  const addItem = (group: string, id: string) => ({ type: 'addItem', group, item: { kind: 'expense', id, at: 1, date: '2026-11-13', description: 'Milk', category: 'groceries', amount: 349, paidBy: 'm0', split: { method: 'equal', among: ['m0'] } } });
  const ev = (client_id: string, action: unknown) => ({ client_id, action });
  /** Run as a user whose sign-in carries an email, like Supabase's JWT. */
  const asWithEmail = <T>(user: string, email: string, fn: Parameters<typeof as<T>>[1]) =>
    as(user, async (q) => {
      await q("select set_config('request.jwt.claim.email', $1, true)", [email]);
      return fn(q);
    });

  async function newGroup(): Promise<string> {
    const id = randomUUID();
    await as(userA, (q) => q('select create_shared_group($1, $2, $3, $4)', [id, 'Flat 4B', `create-${id}`, JSON.stringify(snapshot(id))]));
    return id;
  }

  test('a new group starts its log with itself; only members read or add to it', async (t) => {
    if (!url) return t.skip();
    await db.query('insert into auth.users (id) values ($1) on conflict do nothing', [userC]);
    const id = await newGroup();
    // Retrying the same create is harmless.
    assert.equal(await as(userA, async (q) => (await q('select create_shared_group($1, $2, $3, $4) as n', [id, 'Flat 4B', `create-${id}`, JSON.stringify(snapshot(id))])).rows[0].n), 1);
    const mine = await as(userA, async (q) => (await q('select * from my_groups() where id = $1', [id])).rows);
    assert.deepEqual(mine.map((g) => [g.name, g.role, g.members, g.last_seq]), [['Flat 4B', 'owner', 1, 1]]);
    const log = await as(userA, async (q) => (await q('select * from group_events_since($1, 0)', [id])).rows);
    assert.deepEqual(log.map((e) => [e.seq, e.action.type, e.action.group.id]), [[1, 'createGroup', id]]);

    await assert.rejects(as(userB, (q) => q('select * from group_events_since($1, 0)', [id])), /not in this group/);
    await assert.rejects(as(userB, (q) => q('select append_group_events($1, $2)', [id, JSON.stringify([ev('b-1-xxxxxx', addItem(id, 'x'))])])), /not in this group/);
    assert.equal((await as(userB, (q) => q('select * from my_groups() where id = $1', [id]))).rows.length, 0);
    // Someone else can't take over an existing group id.
    await assert.rejects(as(userB, (q) => q('select create_shared_group($1, $2, $3, $4)', [id, 'Mine', `steal-${id}`, JSON.stringify(snapshot(id))])), /already exists/);
  });

  test('changes append in order, a retry is not counted twice, and odd changes are refused', async (t) => {
    if (!url) return t.skip();
    const id = await newGroup();
    const other = await newGroup();
    const n = await as(userA, async (q) => (await q('select append_group_events($1, $2) as n', [id, JSON.stringify([ev('a-1-xxxxxx', addItem(id, 'e1')), ev('a-2-xxxxxx', addItem(id, 'e2'))])])).rows[0].n);
    assert.equal(n, 3);
    // The phone retries after a dropped connection: nothing new.
    assert.equal(await as(userA, async (q) => (await q('select append_group_events($1, $2) as n', [id, JSON.stringify([ev('a-2-xxxxxx', addItem(id, 'e2'))])])).rows[0].n), 3);
    const after1 = await as(userA, async (q) => (await q('select * from group_events_since($1, 1)', [id])).rows);
    assert.deepEqual(after1.map((e) => [e.seq, e.action.item.id]), [[2, 'e1'], [3, 'e2']]);

    const refused = async (action: unknown, re: RegExp) =>
      assert.rejects(as(userA, (q) => q('select append_group_events($1, $2)', [id, JSON.stringify([ev(`r-${randomUUID()}`, action)])])), re);
    await refused({ type: 'createGroup', group: snapshot(id) }, /can't be shared/);
    await refused({ type: 'setGeminiKey', key: 'secret' }, /can't be shared/);
    await refused(addItem(other, 'e3'), /another group/);
    await refused({ type: 'addMember', group: id, member: { id: 'm9', name: 'Ben', phone: '', handles: {}, cash: false, userId: userB } }, /joined the group/);

    await as(userA, (q) => q('select append_group_events($1, $2)', [id, JSON.stringify([ev('a-3-xxxxxx', { type: 'renameGroup', group: id, name: '  Flat 5C ' })])]));
    assert.equal((await as(userA, (q) => q('select name from my_groups() where id = $1', [id]))).rows[0].name, 'Flat 5C');
    await assert.rejects(db.query("update group_events set action = '{\"type\":\"x\"}' where group_id = $1", [id]), /append-only/);
  });

  test('invite link, ask to join, approve with a link to an existing member; decline and ask again', async (t) => {
    if (!url) return t.skip();
    const id = await newGroup();
    const token = await as(userA, async (q) => (await q('select group_invite($1, $2) as t', [id, 'Chai'])).rows[0].t as string);
    assert.equal(await as(userA, async (q) => (await q('select group_invite($1) as t', [id])).rows[0].t), token, 'same link until reset');

    const preview = await asRole('anon', async (q) => (await q('select invite_info($1) as i', [token])).rows[0].i);
    assert.deepEqual(preview, { group_id: id, group_name: 'Flat 4B', inviter: 'Chai', members: 1, status: 'signed_out' });
    assert.equal((await as(userB, async (q) => (await q('select invite_info($1) as i', [token])).rows[0].i)).status, 'none');
    await assert.rejects(asRole('anon', (q) => q('select request_to_join($1, $2)', [token, 'Ben'])), /permission denied/);

    const asked = await asWithEmail(userB, 'ben@example.com', async (q) => (await q('select request_to_join($1, $2) as r', [token, ' Ben '])).rows[0].r);
    assert.deepEqual(asked, { group_id: id, status: 'pending' });
    await assert.rejects(as(userB, (q) => q('select * from group_events_since($1, 0)', [id])), /not in this group/, 'not in until approved');
    await assert.rejects(as(userB, (q) => q('select * from group_join_requests($1)', [id])), /not in this group/);
    const requests = await as(userA, async (q) => (await q('select * from group_join_requests($1)', [id])).rows);
    assert.deepEqual(requests.map((r) => [r.name, r.email, r.user_id]), [['Ben', 'ben@example.com', userB]]);
    assert.equal((await as(userA, (q) => q('select pending_requests from my_groups() where id = $1', [id]))).rows[0].pending_requests, 1);

    // Approving can only link the person who asked.
    const link = (userId: string) => JSON.stringify({ type: 'updateMember', group: id, member: { id: 'm1', name: 'Ben', phone: '', handles: {}, cash: false, userId } });
    await assert.rejects(as(userA, (q) => q('select decide_join_request($1, true, $2, $3)', [requests[0].id, 'approve-xxxxxx', link(userC)])), /person who asked/);
    assert.equal(await as(userA, async (q) => (await q('select decide_join_request($1, true, $2, $3) as s', [requests[0].id, 'approve-ben-1', link(userB)])).rows[0].s), 'approved');
    assert.equal(await as(userA, async (q) => (await q('select decide_join_request($1, false) as s', [requests[0].id])).rows[0].s), 'approved', 'deciding twice changes nothing');

    const bens = await as(userB, async (q) => (await q('select * from group_events_since($1, 0)', [id])).rows);
    assert.deepEqual(bens.map((e) => e.action.type), ['createGroup', 'updateMember']);
    assert.equal(bens[1].action.member.userId, userB);
    assert.equal((await as(userB, async (q) => (await q('select invite_info($1) as i', [token])).rows[0].i)).status, 'member');
    assert.equal((await as(userB, (q) => q('select role from my_groups() where id = $1', [id]))).rows[0].role, 'member');
    // Now Ben is in, he can be linked and can add expenses.
    await as(userB, (q) => q('select append_group_events($1, $2)', [id, JSON.stringify([ev('b-1-yyyyyy', addItem(id, 'eb'))])]));

    // C asks, is declined, asks again.
    await asWithEmail(userC, 'c@example.com', (q) => q('select request_to_join($1, $2)', [token, 'Cy']));
    const cReq = (await as(userA, async (q) => (await q('select * from group_join_requests($1)', [id])).rows))[0];
    assert.equal(await as(userB, async (q) => (await q('select decide_join_request($1, false) as s', [cReq.id])).rows[0].s), 'declined');
    assert.equal((await as(userC, async (q) => (await q('select invite_info($1) as i', [token])).rows[0].i)).status, 'declined');
    await as(userC, (q) => q('select request_to_join($1, $2)', [token, 'Cy']));
    assert.equal((await as(userC, async (q) => (await q('select invite_info($1) as i', [token])).rows[0].i)).status, 'pending');

    // A new link stops the old one.
    const fresh = await as(userB, async (q) => (await q('select group_invite($1, $2, true) as t', [id, 'Ben'])).rows[0].t as string);
    assert.notEqual(fresh, token);
    await assert.rejects(asRole('anon', (q) => q('select invite_info($1)', [token])), /doesn't work any more/);

    // Leaving takes you out; your member and their expenses stay in the group.
    await as(userB, (q) => q('select leave_group($1)', [id]));
    assert.equal((await as(userB, (q) => q('select * from my_groups() where id = $1', [id]))).rows.length, 0);
    assert.equal((await as(userA, (q) => q('select members from my_groups() where id = $1', [id]))).rows[0].members, 1);
  });

  test('shared-group tables are closed to the API', async (t) => {
    if (!url) return t.skip();
    for (const table of ['group_events', 'group_invites', 'join_requests']) {
      await assert.rejects(as(userA, (q) => q(`select * from ${table}`)), /permission denied/, table);
      await assert.rejects(anon(`select * from ${table}`), /permission denied/, table);
    }
    await assert.rejects(anon('select * from my_groups()'), /permission denied/);
    await assert.rejects(as(userA, (q) => q("select insert_group_events(gen_random_uuid(), $1, '[]'::jsonb)", [userA])), /permission denied/);
  });
});

test('supabase/setup.sql matches the migrations (run npm run setup-sql after changing one)', () => {
  assert.equal(readFileSync(`${supabaseDir}setup.sql`, 'utf8'), setupSql());
});
