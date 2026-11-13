/**
 * Keeping shared groups in step with Marmoot's server.
 *
 * A shared group is a log of the app's own actions, kept on the server in order
 * (supabase/migrations/20261113000000_shared_groups.sql). This phone keeps:
 *   - base: the group after every action it has fetched, up to seq;
 *   - pending: its own actions the server hasn't confirmed yet, in order.
 * What you see is base with pending applied on top, so a change shows at once and
 * survives being offline. Fetching new actions rebuilds base and drops the pending
 * ones the server now has. Two phones adding expenses at once both land, in the
 * server's order, and both phones end up with the same group.
 */
import { ApiError, type Api, type GroupRow } from './api.ts';
import { catchUpRecurring, newId, reducer, today, type Action, type Group } from './model.ts';

export interface Pending {
  clientId: string;
  action: Action;
}

export interface GroupLog {
  base: Group | null;
  seq: number;
  pending: Pending[];
  /** Set until the server has the group: a new group, or one moving from this phone. */
  creating?: { clientId: string; snapshot: Group };
}

interface Stored {
  version: 1;
  logs: Record<string, GroupLog>;
}

/** One action on top of a group. The first createGroup in a log makes the group; later ones change nothing. */
export function applyAction(base: Group | null, action: Action): Group | null {
  if (action.type === 'createGroup') return base ?? { ...action.group, shared: true };
  if (!base) return null;
  const next = reducer({ groups: [base], theme: 'system' }, action);
  return next.groups.find((g) => g.id === base.id) ?? base;
}

/** What this person sees: base, their own pending changes, and which member is them. */
export function viewOf(log: GroupLog, userId: string): Group | null {
  let g = log.base ?? (log.creating ? { ...log.creating.snapshot } : null);
  for (const p of log.pending) g = applyAction(g, p.action);
  if (!g) return null;
  const me = g.members.find((m) => m.userId === userId)?.id ?? '';
  return { ...g, me, shared: true };
}

const storeKey = (userId: string) => `marmoot:sync:${userId}`;

function readStore(userId: string): Stored {
  try {
    const raw = globalThis.localStorage?.getItem(storeKey(userId));
    const parsed = raw ? (JSON.parse(raw) as Stored) : null;
    if (parsed?.version === 1 && parsed.logs) return parsed;
  } catch {
    // Start fresh; the server has everything that was sent.
  }
  return { version: 1, logs: {} };
}

export function forgetSync(userId: string) {
  try {
    globalThis.localStorage?.removeItem(storeKey(userId));
  } catch {
    // nothing stored
  }
}

export interface SyncEvents {
  /** Shared groups as they now stand, and ids of ones this person is no longer in. */
  onGroups: (groups: Group[], removed: string[]) => void;
  /** A change the server refused, or why syncing stopped. */
  onError?: (message: string) => void;
  /** The server's list of your groups: your role in each, and how many people are waiting to be let in. */
  onRows?: (rows: GroupRow[]) => void;
}

export class GroupSync {
  private store: Stored;
  /** One server conversation per group at a time. */
  private busy = new Map<string, Promise<void>>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly api: Api,
    readonly userId: string,
    private readonly events: SyncEvents,
    private readonly persist = true,
  ) {
    this.store = persist ? readStore(userId) : { version: 1, logs: {} };
  }

  /** Every shared group this phone knows about, as it should be shown. */
  views(): Group[] {
    return Object.values(this.store.logs)
      .map((log) => viewOf(log, this.userId))
      .filter((g): g is Group => !!g);
  }

  has(group: string): boolean {
    return group in this.store.logs;
  }

  log(group: string): GroupLog | undefined {
    return this.store.logs[group];
  }

  private save() {
    if (!this.persist) return;
    try {
      globalThis.localStorage?.setItem(storeKey(this.userId), JSON.stringify(this.store));
    } catch {
      // Storage full or blocked: pending changes live in memory until sent.
    }
  }

  private emit(ids: string[], removed: string[] = []) {
    const groups = ids.map((id) => this.store.logs[id]).filter((l): l is GroupLog => !!l).map((l) => viewOf(l, this.userId)).filter((g): g is Group => !!g);
    this.events.onGroups(groups, removed);
  }

  private exclusive(group: string, job: () => Promise<void>): Promise<void> {
    const prev = this.busy.get(group) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(job);
    this.busy.set(group, next);
    const done = () => {
      if (this.busy.get(group) === next) this.busy.delete(group);
    };
    next.then(done, done);
    return next;
  }

  /**
   * Start sharing a group: a new one, or one moving from this phone. It shows at once;
   * the server gets it now or on the next try. Your member is linked to your account.
   */
  create(group: Group, myName?: string): Promise<void> {
    const snapshot: Group = {
      ...group,
      shared: undefined,
      members: group.members.map((m) =>
        m.id === group.me ? { ...m, userId: this.userId, name: m.name === 'You' && myName ? myName : m.name } : m,
      ),
    };
    delete snapshot.shared;
    this.store.logs[group.id] = { base: null, seq: 0, pending: [], creating: { clientId: `create-${group.id}`, snapshot } };
    this.save();
    this.emit([group.id]);
    return this.flush(group.id);
  }

  /** A change to a shared group: shown at once, sent in the background. */
  enqueue(group: string, action: Action) {
    const log = this.store.logs[group];
    if (!log) return;
    log.pending.push({ clientId: newId(), action });
    this.save();
    this.emit([group]);
    void this.flush(group).catch(() => undefined);
  }

  /** Send what's waiting, then fetch what's new. */
  flush(group: string): Promise<void> {
    return this.exclusive(group, async () => {
      await this.sendPending(group);
      await this.fetchNew(group);
    });
  }

  private async sendPending(group: string) {
    const log = this.store.logs[group];
    if (!log) return;
    if (log.creating) {
      const { clientId, snapshot } = log.creating;
      await this.api.createSharedGroup(group, snapshot.name, clientId, snapshot);
      log.creating = undefined;
      log.base = { ...snapshot, shared: true };
      this.save();
    }
    // Pending changes stay until the server's copy arrives (fetchNew), so the view never flickers back.
    let sent = 0;
    while (sent < log.pending.length) {
      const batch = log.pending.slice(sent, sent + 50);
      try {
        await this.api.appendEvents(group, batch.map((p) => ({ client_id: p.clientId, action: p.action })));
        sent += batch.length;
      } catch (e) {
        if (!(e instanceof ApiError) || e.status === 0 || e.status >= 500) throw e;
        if (/not in this group/i.test(e.message)) {
          this.drop(group);
          return;
        }
        // The server refused a change: find which by sending one at a time, drop it, keep the rest.
        const bad = await this.firstRefused(group, batch);
        if (!bad) {
          sent += batch.length;
          continue;
        }
        log.pending = log.pending.filter((p) => p !== bad.pending);
        this.save();
        this.emit([group]);
        this.events.onError?.(`A change couldn't be saved: ${bad.message}`);
      }
    }
  }

  private async firstRefused(group: string, batch: Pending[]): Promise<{ pending: Pending; message: string } | null> {
    for (const p of batch) {
      try {
        await this.api.appendEvents(group, [{ client_id: p.clientId, action: p.action }]);
      } catch (e) {
        if (e instanceof ApiError && e.status > 0 && e.status < 500) return { pending: p, message: e.message };
        throw e;
      }
    }
    return null;
  }

  private async fetchNew(group: string) {
    const log = this.store.logs[group];
    if (!log || log.creating) return;
    let changed = false;
    for (;;) {
      const events = await this.api.eventsSince(group, log.seq, 500);
      if (!events.length) break;
      for (const e of events) {
        log.base = applyAction(log.seq === 0 && e.seq === 1 ? null : log.base, e.action);
        log.seq = e.seq;
        log.pending = log.pending.filter((p) => p.clientId !== e.client_id);
      }
      changed = true;
      if (events.length < 500) break;
    }
    if (changed) {
      this.save();
      this.emit([group]);
    }
    // Repeating bills that fell due: whichever phone notices first posts them, once.
    const view = viewOf(log, this.userId);
    if (view && view.recurring.length && !log.pending.some((p) => p.action.type === 'catchUp')) {
      const day = today();
      if (catchUpRecurring(view, day, Date.now()) !== view) {
        // Phones at the same point in the log make the same id, so the server keeps one.
        log.pending.push({ clientId: `catchup-${group}-${day}-${log.seq}`, action: { type: 'catchUp', group, today: day, now: Date.now() } });
        this.save();
        this.emit([group]);
        await this.sendPending(group);
        await this.fetchNew(group);
      }
    }
  }

  private drop(group: string) {
    delete this.store.logs[group];
    this.save();
    this.emit([], [group]);
  }

  /** Check the server: groups joined or left, and new changes in any of them. */
  async refresh(): Promise<GroupRow[]> {
    const rows = await this.api.myGroups();
    const ids = new Set(rows.map((r) => r.id));
    const gone = Object.keys(this.store.logs).filter((id) => !ids.has(id) && !this.store.logs[id]!.creating);
    for (const id of gone) delete this.store.logs[id];
    if (gone.length) {
      this.save();
      this.emit([], gone);
    }
    this.events.onRows?.(rows);
    const work: Promise<void>[] = [];
    for (const r of rows) {
      const log = (this.store.logs[r.id] ??= { base: null, seq: 0, pending: [] });
      if (r.last_seq > log.seq || log.pending.length) work.push(this.flush(r.id));
    }
    // Groups still being created on the server.
    for (const [id, log] of Object.entries(this.store.logs)) if (log.creating) work.push(this.flush(id));
    const results = await Promise.allSettled(work);
    const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed) throw failed.reason;
    return rows;
  }

  /** Stop sharing this group with you. Your past expenses stay in it for everyone else. */
  async leave(group: string) {
    await this.api.leaveGroup(group);
    this.drop(group);
  }

  /** Delete the group for everyone in it (only its creator may). */
  async destroy(group: string) {
    await this.api.deleteSharedGroup(group);
    this.drop(group);
  }

  /** Fetch now, for example right after approving someone. */
  pull(group: string): Promise<void> {
    this.store.logs[group] ??= { base: null, seq: 0, pending: [] };
    return this.flush(group);
  }

  /** Every few seconds while the app is open and visible. */
  start(everyMs = 15000) {
    const tick = () => {
      this.timer = setTimeout(tick, everyMs);
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      void this.refresh().catch((e) => this.events.onError?.(e instanceof Error ? e.message : String(e)));
    };
    tick();
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
