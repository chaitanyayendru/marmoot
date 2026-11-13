import { describe, expect, it } from 'vitest';
import { ApiError, type Api, type GroupEvent } from './api.ts';
import { groupNets, newMember, today, type Action, type ExpenseItem, type Group } from './model.ts';
import { GroupSync, applyAction, viewOf } from './sync.ts';

/**
 * A pretend server with the same rules as the SQL functions: one log per group,
 * seq in order, retries (same client_id) skipped, only members read or write,
 * createGroup only as the first entry.
 */
class FakeServer {
  logs = new Map<string, GroupEvent[]>();
  members = new Map<string, Set<string>>();
  seen = new Set<string>();
  offline = false;
  /** Save the next append, then fail as if the reply was lost. */
  loseNextReply = false;

  api(user: string): Api {
    const need = (group: string) => {
      if (this.offline) throw new ApiError("Can't reach Marmoot's server.", 0, 'offline');
      if (!this.members.get(group)?.has(user)) throw new ApiError("You're not in this group.", 403);
    };
    const append = (group: string, events: { client_id: string; action: Action }[]) => {
      const log = this.logs.get(group)!;
      for (const e of events) {
        if (this.seen.has(e.client_id)) continue;
        if (e.action.type === 'createGroup' && log.length) throw new ApiError("That change can't be shared (createGroup).", 400);
        if ('group' in e.action && typeof e.action.group === 'string' && e.action.group !== group) throw new ApiError('That change belongs to another group.', 400);
        if (e.action.type === 'renameGroup' && e.action.name === 'REFUSE') throw new ApiError('Refused for the test.', 400);
        this.seen.add(e.client_id);
        log.push({ seq: log.length + 1, client_id: e.client_id, action: structuredClone(e.action), actor: user, created_at: new Date().toISOString() });
      }
      return log.length;
    };
    const fake: Partial<Api> = {
      myGroups: async () => {
        if (this.offline) throw new ApiError('offline', 0);
        return [...this.members].filter(([, m]) => m.has(user)).map(([id]) => ({ id, name: 'x', role: 'member' as const, members: this.members.get(id)!.size, last_seq: this.logs.get(id)!.length, pending_requests: 0 }));
      },
      createSharedGroup: async (id, _name, clientId, snapshot) => {
        if (this.offline) throw new ApiError('offline', 0);
        if (this.logs.has(id)) return this.logs.get(id)!.length;
        this.logs.set(id, []);
        this.members.set(id, new Set([user]));
        return append(id, [{ client_id: clientId, action: { type: 'createGroup', group: snapshot } }]);
      },
      appendEvents: async (group, events) => {
        need(group);
        const n = append(group, events);
        if (this.loseNextReply) {
          this.loseNextReply = false;
          throw new ApiError("Can't reach Marmoot's server.", 0, 'offline');
        }
        return n;
      },
      eventsSince: async (group, after, limit = 500) => {
        need(group);
        return structuredClone(this.logs.get(group)!.filter((e) => e.seq > after).slice(0, limit));
      },
      leaveGroup: async (group) => {
        this.members.get(group)?.delete(user);
        return null;
      },
    };
    return fake as Api;
  }

  /** What approving someone does: they're in, linked to a member. */
  join(group: string, user: string, member: string) {
    this.members.get(group)!.add(user);
    const log = this.logs.get(group)!;
    const base = log.reduce<Group | null>((g, e) => applyAction(g, e.action), null)!;
    const m = base.members.find((x) => x.id === member)!;
    const id = `approve-${user}`;
    this.seen.add(id);
    log.push({ seq: log.length + 1, client_id: id, action: { type: 'updateMember', group, member: { ...m, userId: user } }, actor: 'x', created_at: '' });
  }
}

function phone(server: FakeServer, user: string) {
  const shown = new Map<string, Group>();
  const errors: string[] = [];
  const sync = new GroupSync(server.api(user), user, {
    onGroups: (groups, removed) => {
      for (const g of groups) shown.set(g.id, g);
      for (const id of removed) shown.delete(id);
    },
    onError: (m) => errors.push(m),
  }, false);
  return { sync, shown, errors };
}

const chaiId = 'user-chai';
const ashaId = 'user-asha';

function flat(): Group {
  const me = { ...newMember('You'), id: 'm-chai' };
  const asha = { ...newMember('Asha'), id: 'm-asha' };
  return { id: 'g1', name: 'Flat 4B', createdAt: 1, me: me.id, members: [me, asha], items: [], recurring: [], due: [] };
}

const expense = (id: string, paidBy: string, amount: number): ExpenseItem => ({
  kind: 'expense', id, at: 1, date: '2026-11-13', description: id, category: 'groceries', amount, paidBy, split: { method: 'equal', among: ['m-chai', 'm-asha'] },
});

describe('shared groups', () => {
  it('moves a group to the server, links you, and a second person sees it once approved', async () => {
    const server = new FakeServer();
    const chai = phone(server, chaiId);
    await chai.sync.create(flat(), 'Chai');
    const mine = chai.shown.get('g1')!;
    expect(mine.shared).toBe(true);
    expect(mine.me).toBe('m-chai');
    expect(mine.members[0]).toMatchObject({ name: 'Chai', userId: chaiId });

    const asha = phone(server, ashaId);
    await asha.sync.refresh();
    expect(asha.shown.size).toBe(0);
    server.join('g1', ashaId, 'm-asha');
    await asha.sync.refresh();
    expect(asha.shown.get('g1')!.me).toBe('m-asha');
  });

  it('two phones adding at the same time end up with the same group', async () => {
    const server = new FakeServer();
    const chai = phone(server, chaiId);
    await chai.sync.create(flat(), 'Chai');
    server.join('g1', ashaId, 'm-asha');
    const asha = phone(server, ashaId);
    await asha.sync.refresh();

    chai.sync.enqueue('g1', { type: 'addItem', group: 'g1', item: expense('milk', 'm-chai', 400) });
    asha.sync.enqueue('g1', { type: 'addItem', group: 'g1', item: expense('rice', 'm-asha', 1000) });
    // Shown at once, before the server answers.
    expect(chai.shown.get('g1')!.items.map((i) => i.id)).toEqual(['milk']);
    await Promise.all([chai.sync.flush('g1'), asha.sync.flush('g1')]);
    await chai.sync.refresh();
    await asha.sync.refresh();
    const a = chai.shown.get('g1')!, b = asha.shown.get('g1')!;
    expect(a.items.map((i) => i.id)).toEqual(b.items.map((i) => i.id));
    expect(a.items).toHaveLength(2);
    expect(groupNets(a).get('m-chai')).toBe(-300);
    expect(groupNets(b).get('m-chai')).toBe(-300);
  });

  it('offline changes wait and go later; a lost reply is not counted twice', async () => {
    const server = new FakeServer();
    const chai = phone(server, chaiId);
    await chai.sync.create(flat(), 'Chai');
    server.offline = true;
    chai.sync.enqueue('g1', { type: 'addItem', group: 'g1', item: expense('milk', 'm-chai', 400) });
    await chai.sync.flush('g1').catch(() => undefined);
    expect(chai.shown.get('g1')!.items).toHaveLength(1);
    expect(chai.sync.log('g1')!.pending).toHaveLength(1);

    server.offline = false;
    server.loseNextReply = true;
    await chai.sync.flush('g1').catch(() => undefined);
    await chai.sync.flush('g1');
    expect(server.logs.get('g1')!.filter((e) => e.action.type === 'addItem')).toHaveLength(1);
    expect(chai.sync.log('g1')!.pending).toHaveLength(0);
    expect(chai.shown.get('g1')!.items).toHaveLength(1);
  });

  it('a refused change is dropped with a message; the others still go', async () => {
    const server = new FakeServer();
    const chai = phone(server, chaiId);
    await chai.sync.create(flat(), 'Chai');
    chai.sync.enqueue('g1', { type: 'renameGroup', group: 'g1', name: 'REFUSE' });
    chai.sync.enqueue('g1', { type: 'addItem', group: 'g1', item: expense('milk', 'm-chai', 400) });
    await chai.sync.flush('g1');
    await chai.sync.flush('g1');
    expect(chai.errors[0]).toMatch(/Refused for the test/);
    expect(chai.shown.get('g1')!.name).toBe('Flat 4B');
    expect(chai.shown.get('g1')!.items.map((i) => i.id)).toEqual(['milk']);
    expect(chai.sync.log('g1')!.pending).toHaveLength(0);
  });

  it('a repeating bill that fell due is posted once, even with two phones catching up', async () => {
    const server = new FakeServer();
    const chai = phone(server, chaiId);
    const g = flat();
    g.recurring = [{ id: 'rent', description: 'Rent', category: 'rent', amount: 200000, paidBy: 'm-chai', split: { method: 'equal', among: ['m-chai', 'm-asha'] }, every: 'month', next: today(), day: 1 }];
    await chai.sync.create(g, 'Chai');
    server.join('g1', ashaId, 'm-asha');
    const asha = phone(server, ashaId);
    await Promise.all([asha.sync.refresh(), chai.sync.refresh()]);
    await Promise.all([asha.sync.refresh(), chai.sync.refresh()]);
    const rentPosts = (x: Group) => x.items.filter((i) => i.kind === 'expense' && i.recurringId === 'rent');
    expect(rentPosts(chai.shown.get('g1')!)).toHaveLength(1);
    expect(rentPosts(asha.shown.get('g1')!)).toHaveLength(1);
    expect(chai.shown.get('g1')!.recurring[0]!.next > today()).toBe(true);
  });

  it('leaving, or being removed, takes the group off this phone', async () => {
    const server = new FakeServer();
    const chai = phone(server, chaiId);
    await chai.sync.create(flat(), 'Chai');
    server.join('g1', ashaId, 'm-asha');
    const asha = phone(server, ashaId);
    await asha.sync.refresh();
    expect(asha.shown.has('g1')).toBe(true);
    await asha.sync.leave('g1');
    expect(asha.shown.has('g1')).toBe(false);
    server.members.get('g1')!.delete(chaiId);
    await chai.sync.refresh();
    expect(chai.shown.has('g1')).toBe(false);
  });

  it('the view puts your pending changes on top of what the server has', () => {
    const g = { ...flat(), members: flat().members.map((m) => (m.id === 'm-asha' ? { ...m, userId: ashaId } : m)) };
    const v = viewOf({ base: g, seq: 3, pending: [{ clientId: 'c1', action: { type: 'addItem', group: 'g1', item: expense('x', 'm-asha', 100) } }] }, ashaId)!;
    expect(v.me).toBe('m-asha');
    expect(v.items).toHaveLength(1);
    expect(applyAction(g, { type: 'createGroup', group: { ...g, name: 'other' } })!.name).toBe('Flat 4B');
  });
});
