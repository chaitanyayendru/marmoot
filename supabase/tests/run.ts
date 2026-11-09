/**
 * Database tests: applies the migrations to a throwaway Postgres and checks that
 *   - poker_nets() in SQL agrees with settlePokerNight() in @marmoot/core, cent for cent,
 *     on the worked example and on hundreds of random nights
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
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { DiscrepancyTooLarge, applyTransfers, minTransferSettle, settlePokerNight, type PokerEvent } from '../../packages/core/src/index.ts';

const root = new URL('../', import.meta.url).pathname;

// ------------------------------------------------------------------ database lifecycle

function findPgBin(): string | null {
  if (process.env.PG_BIN && existsSync(join(process.env.PG_BIN, 'initdb'))) return process.env.PG_BIN;
  try {
    const dir = execFileSync('pg_config', ['--bindir'], { encoding: 'utf8' }).trim();
    if (existsSync(join(dir, 'initdb'))) return dir;
  } catch { /* not installed */ }
  const base = '/usr/lib/postgresql';
  if (existsSync(base)) {
    for (const v of readdirSync(base).sort().reverse()) if (existsSync(join(base, v, 'bin', 'initdb'))) return join(base, v, 'bin');
  }
  return null;
}

let server: ChildProcess | undefined;
let dataDir: string | undefined;

async function startCluster(): Promise<string | null> {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const bin = findPgBin();
  if (!bin) return null;
  dataDir = mkdtempSync(join(tmpdir(), 'marmoot-pg-'));
  chmodSync(dataDir, 0o777);
  // initdb refuses to run as root; use the postgres system user when we are root.
  const asPg = (cmd: string, args: string[]) => (process.getuid?.() === 0 ? ['runuser', ['-u', 'postgres', '--', cmd, ...args]] as const : [cmd, args] as const);
  const [c1, a1] = asPg(join(bin, 'initdb'), ['-D', join(dataDir, 'data'), '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--no-locale']);
  execFileSync(c1, a1, { stdio: 'ignore' });
  const port = String(55000 + Math.floor(Math.random() * 5000));
  const [c2, a2] = asPg(join(bin, 'postgres'), ['-D', join(dataDir, 'data'), '-k', dataDir, '-p', port, '-c', "listen_addresses=", '-c', 'fsync=off']);
  server = spawn(c2, a2, { stdio: 'ignore' });
  const url = `postgresql://postgres@/postgres?host=${encodeURIComponent(dataDir)}&port=${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      const c = new pg.Client({ connectionString: url });
      await c.connect();
      await c.end();
      return url;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error('temporary Postgres did not start');
}

function stopCluster() {
  server?.kill('SIGINT');
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
}

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
  if (!url) return;
  db = new pg.Client({ connectionString: url });
  await db.connect();
  await db.query(readFileSync(join(root, 'tests/auth-stub.sql'), 'utf8'));
  for (const f of readdirSync(join(root, 'migrations')).filter((f) => f.endsWith('.sql')).sort()) {
    await db.query(readFileSync(join(root, 'migrations', f), 'utf8'));
  }
  await db.query('insert into auth.users (id) values ($1), ($2)', [userA, userB]);
});

after(async () => {
  await db?.end();
  stopCluster();
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
