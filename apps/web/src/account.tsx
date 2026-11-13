/**
 * The signed-in side of the app: who you are, your shared groups kept in step with
 * the server, and moving the groups on this phone to your account the first time you
 * sign in. Screens read it with useAccount().
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type Dispatch, type ReactNode } from 'react';
import type { Session } from '@supabase/auth-js';
import { api } from './apiClient.ts';
import { displayName, signIn, signOut, useSession } from './auth.ts';
import { groupOf, newId, type Action, type Group, type State } from './model.ts';
import { GroupSync, forgetSync } from './sync.ts';

export interface Account {
  /** Sign-in is possible in this copy of the app (it's connected to a server). */
  available: boolean;
  ready: boolean;
  session: Session | null;
  /** First name from the Google account. */
  name: string;
  sync: GroupSync | null;
  /** Per shared group: people waiting to be let in. */
  requests: Record<string, number>;
  /** Per shared group: whether you created it (and so can delete it for everyone). */
  owner: Record<string, boolean>;
  /** Groups on this phone are moving to the account. */
  moving: boolean;
  message: string | null;
  signIn: (then?: string) => Promise<void>;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
  dismiss: () => void;
}

const AccountContext = createContext<Account | null>(null);

export function useAccount(): Account {
  const a = useContext(AccountContext);
  if (!a) throw new Error('useAccount outside AccountProvider');
  return a;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Wraps the app's dispatch: a change to a shared group goes through its log, a new
 * group is shared when you're signed in, and everything else stays on this phone.
 */
export function AccountProvider({ state, dispatch, children }: { state: State; dispatch: Dispatch<Action>; children: (act: Dispatch<Action>) => ReactNode }) {
  const { session, ready, error } = useSession();
  const userId = session?.user.id ?? null;
  const name = displayName(session?.user);
  const [requests, setRequests] = useState<Record<string, number>>({});
  const [owner, setOwner] = useState<Record<string, boolean>>({});
  const [message, setMessage] = useState<string | null>(error);
  const [moving, setMoving] = useState(false);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => setMessage(error), [error]);

  const sync = useMemo(() => {
    if (!api || !userId) return null;
    return new GroupSync(api, userId, {
      onGroups: (groups, removed) => {
        if (groups.length) dispatch({ type: 'putGroups', groups });
        if (removed.length) dispatch({ type: 'dropGroups', ids: removed });
      },
      onError: (m) => setMessage(m),
      onRows: (rows) => {
        setRequests(Object.fromEntries(rows.map((r) => [r.id, r.pending_requests])));
        setOwner(Object.fromEntries(rows.map((r) => [r.id, r.role === 'owner'])));
      },
    });
  }, [userId, dispatch]);

  // Show what's stored at once, then keep checking while the app is open.
  useEffect(() => {
    if (!sync) return;
    const cached = sync.views();
    if (cached.length) dispatch({ type: 'putGroups', groups: cached });
    sync.start();
    const wake = () => {
      if (document.visibilityState === 'visible') void sync.refresh().catch(() => undefined);
    };
    document.addEventListener('visibilitychange', wake);
    return () => {
      sync.stop();
      document.removeEventListener('visibilitychange', wake);
    };
  }, [sync, dispatch]);

  // First time signed in on this phone: its groups move to the account (not the sample).
  useEffect(() => {
    if (!sync) return;
    const local = stateRef.current.groups.filter((g) => !g.shared && !g.sample && !g.name.endsWith('(sample)'));
    if (!local.length) return;
    setMoving(true);
    void (async () => {
      for (const g of local) {
        let group = g;
        if (!UUID.test(g.id)) {
          group = { ...g, id: newId() };
          dispatch({ type: 'dropGroups', ids: [g.id] });
        }
        try {
          await sync.create(group, name);
        } catch {
          // Shown already; it reaches the server on the next check.
        }
      }
      setMoving(false);
    })();
  }, [sync, dispatch, name]);

  const act = useCallback<Dispatch<Action>>(
    (a) => {
      const id = groupOf(a);
      const g = id ? stateRef.current.groups.find((x) => x.id === id) : undefined;
      if (sync && a.type === 'createGroup' && !a.group.sample) {
        void sync.create(a.group, name).catch(() => undefined);
        return;
      }
      if (sync && g?.shared && id) {
        if (a.type === 'deleteGroup') {
          void sync.leave(id).catch((e) => setMessage(e instanceof Error ? e.message : 'Could not leave the group.'));
          return;
        }
        sync.enqueue(id, a);
        return;
      }
      dispatch(a);
    },
    [sync, dispatch, name],
  );

  const account: Account = {
    available: !!api,
    ready,
    session,
    name,
    sync,
    requests,
    owner,
    moving,
    message,
    signIn: async (then) => {
      const m = await signIn(then);
      if (m) setMessage(m);
    },
    signOut: async () => {
      const shared = stateRef.current.groups.filter((g) => g.shared).map((g) => g.id);
      sync?.stop();
      if (userId) forgetSync(userId);
      await signOut();
      dispatch({ type: 'dropGroups', ids: shared });
      setRequests({});
      setOwner({});
    },
    refresh: async () => {
      if (!sync) return;
      try {
        await sync.refresh();
      } catch (e) {
        setMessage(e instanceof Error ? e.message : String(e));
      }
    },
    dismiss: () => setMessage(null),
  };

  return <AccountContext.Provider value={account}>{children(act)}</AccountContext.Provider>;
}

/** For screens that list people: whether this member has joined with an account. */
export function joined(g: Group, memberId: string): boolean {
  return !!g.members.find((m) => m.id === memberId)?.userId;
}
