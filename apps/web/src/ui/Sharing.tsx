/**
 * Sharing a group: your account in Settings, the invite link, and letting people in.
 */
import { useCallback, useEffect, useState } from 'react';
import { ClipboardCopy, LogOut, MessageCircle, RefreshCw, UserPlus } from 'lucide-react';
import { useAccount } from '../account.tsx';
import { ApiError, type JoinRequest } from '../api.ts';
import { api, inviteLink } from '../apiClient.ts';
import { newId, newMember, type Action, type Group } from '../model.ts';
import { waLink } from '../whatsapp.ts';
import { Notice, Sheet } from './bits.tsx';

const message = (e: unknown, fallback: string) => (e instanceof ApiError || e instanceof Error ? e.message : fallback);

/** The Google mark, drawn plainly so it reads as "sign in with Google". */
function GoogleMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.7 13.2l7.9 6.1C12.5 13.6 17.8 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.4 5.7c4.3-4 6.9-9.9 6.9-17.1z" />
      <path fill="#FBBC05" d="M10.6 28.7c-.5-1.4-.8-2.9-.8-4.7s.3-3.2.8-4.7l-7.9-6.1C1 16.6 0 20.2 0 24s1 7.4 2.7 10.8l7.9-6.1z" />
      <path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.4-5.7c-2.1 1.4-4.8 2.3-8.5 2.3-6.2 0-11.5-4.1-13.4-9.8l-7.9 6.1C6.6 42.6 14.6 48 24 48z" />
    </svg>
  );
}

export function SignInButton({ then, label = 'Sign in with Google', primary = false }: { then?: string; label?: string; primary?: boolean }) {
  const account = useAccount();
  const [busy, setBusy] = useState(false);
  return (
    <button
      className={`pill wide${primary ? ' primary' : ''}`}
      disabled={busy || !account.ready}
      onClick={() => {
        setBusy(true);
        void account.signIn(then).finally(() => setBusy(false));
      }}
    >
      <GoogleMark /> {busy ? 'Opening Google…' : label}
    </button>
  );
}

/** In Settings: who's signed in, or a way to sign in. */
export function AccountSection() {
  const account = useAccount();
  if (!account.available) return null;
  const user = account.session?.user;
  return (
    <section className="stack tight" aria-label="Account">
      <h3 className="label">Account</h3>
      {user ? (
        <>
          <p className="account-line">
            <span className="avatar" aria-hidden="true">{(account.name || user.email || '?').slice(0, 1).toUpperCase()}</span>
            <span className="row-main">
              <span className="row-title">{account.name || user.email}</span>
              <span className="row-sub">{user.email}</span>
            </span>
          </p>
          <p className="fine">Your groups are kept on Marmoot's server and on every phone you sign in on. Roommates join a group with its invite link.</p>
          <button className="pill wide" onClick={() => void account.signOut()}>
            <LogOut size={16} /> Sign out
          </button>
        </>
      ) : (
        <>
          <SignInButton />
          <p className="fine">Keeps your groups safe if you lose this phone, and lets roommates join a group and see the same balances.</p>
        </>
      )}
    </section>
  );
}

/** The invite button in a group's top bar. */
export function InviteButton({ group }: { group: Group }) {
  const account = useAccount();
  const [open, setOpen] = useState(false);
  if (!account.available || group.sample) return null;
  return (
    <>
      <button className="icon-btn" aria-label="Invite people" onClick={() => setOpen(true)}>
        <UserPlus size={22} strokeWidth={1.75} />
      </button>
      {open && <InviteSheet group={group} onClose={() => setOpen(false)} />}
    </>
  );
}

function InviteSheet({ group, onClose }: { group: Group; onClose: () => void }) {
  const account = useAccount();
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const me = group.members.find((m) => m.id === group.me)?.name ?? account.name;

  const load = useCallback(
    async (reset = false) => {
      if (!api) return;
      setBusy(true);
      setError(null);
      try {
        setToken(await api.groupInvite(group.id, me, reset));
      } catch (e) {
        setError(message(e, 'Could not make the invite link.'));
      } finally {
        setBusy(false);
      }
    },
    [group.id, me],
  );

  useEffect(() => {
    if (group.shared && account.session) void load();
  }, [group.shared, account.session, load]);

  if (!account.session) {
    return (
      <Sheet title="Invite people" onClose={onClose}>
        <div className="stack">
          <p>To let roommates join {group.name}, sign in first. The group then moves to your account, and they join with a link you share.</p>
          <SignInButton then={`#/g/${group.id}`} primary />
        </div>
      </Sheet>
    );
  }
  if (!group.shared) {
    return (
      <Sheet title="Invite people" onClose={onClose}>
        <p className="muted">Moving {group.name} to your account. Try again in a moment.</p>
      </Sheet>
    );
  }

  const link = token ? inviteLink(token) : '';
  const text = `Join ${group.name} on Marmoot, where we split our bills: ${link}`;
  return (
    <Sheet title={`Invite to ${group.name}`} onClose={onClose}>
      <div className="stack">
        <p className="fine">Anyone with this link can ask to join. Someone already in the group lets them in, and picks who they are in the list.</p>
        {error && <Notice tone="warn">{error}</Notice>}
        {token ? (
          <>
            <code className="copy-block">{link}</code>
            <a className="pill primary wide" href={waLink(text)} target="_blank" rel="noreferrer">
              <MessageCircle size={16} /> Share in WhatsApp
            </a>
            <button
              className="pill wide"
              onClick={() => {
                void navigator.clipboard.writeText(link).then(
                  () => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2000);
                  },
                  () => setError(`Copy this link: ${link}`),
                );
              }}
            >
              <ClipboardCopy size={16} /> {copied ? 'Copied' : 'Copy the link'}
            </button>
            <button className="link" disabled={busy} onClick={() => void load(true)}>
              <RefreshCw size={14} /> Make a new link (the old one stops working)
            </button>
          </>
        ) : (
          <p className="muted">{busy ? 'Making the link…' : ''}</p>
        )}
      </div>
    </Sheet>
  );
}

/** At the top of a shared group: people asking to join, to let in or turn away. */
export function JoinRequests({ group, dispatchError }: { group: Group; dispatchError?: (m: string) => void }) {
  const account = useAccount();
  const [requests, setRequests] = useState<JoinRequest[]>([]);
  const [deciding, setDeciding] = useState<JoinRequest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const waiting = account.requests[group.id] ?? 0;

  const load = useCallback(async () => {
    if (!api || !group.shared || !account.session) return;
    try {
      setRequests(await api.joinRequests(group.id));
    } catch (e) {
      setError(message(e, 'Could not load requests.'));
    }
  }, [group.id, group.shared, account.session]);

  useEffect(() => {
    void load();
  }, [load, waiting]);

  async function decide(r: JoinRequest, approve: boolean, action?: Action) {
    if (!api) return;
    setError(null);
    try {
      await api.decideJoin(r.id, approve, action ? newId() : undefined, action);
      setDeciding(null);
      await account.sync?.pull(group.id);
      await account.refresh();
      await load();
    } catch (e) {
      const m = message(e, 'That didn’t work. Try again.');
      setDeciding(null);
      setError(m);
      dispatchError?.(m);
    }
  }

  if (!requests.length && !error) return null;
  return (
    <section className="requests" aria-label="Asking to join">
      {error && <Notice tone="warn">{error}</Notice>}
      {requests.map((r) => (
        <div key={r.id} className="request">
          <p>
            <b>{r.name}</b> wants to join{r.email ? <span className="fine"> · {r.email}</span> : null}
          </p>
          <div className="two">
            <button className="pill" onClick={() => void decide(r, false)}>Decline</button>
            <button className="pill primary" onClick={() => setDeciding(r)}>Let in</button>
          </div>
        </div>
      ))}
      {deciding && <WhoIsIt group={group} request={deciding} onClose={() => setDeciding(null)} onPick={(action) => void decide(deciding, true, action)} />}
    </section>
  );
}

/** Approving: are they someone already in the list (their past expenses stay theirs), or new? */
function WhoIsIt({ group, request, onClose, onPick }: { group: Group; request: JoinRequest; onClose: () => void; onPick: (a: Action) => void }) {
  const open = group.members.filter((m) => !m.userId);
  const first = request.name.trim().split(/\s+/)[0]!.toLowerCase();
  const guess = open.find((m) => m.name.trim().toLowerCase() === first || m.name.trim().toLowerCase() === request.name.trim().toLowerCase());
  const [pick, setPick] = useState<string>(guess?.id ?? 'new');
  const [busy, setBusy] = useState(false);
  return (
    <Sheet title={`Who is ${request.name}?`} onClose={onClose}>
      <div className="stack">
        <fieldset className="checks">
          {open.map((m) => (
            <label key={m.id} className="check">
              <input type="radio" name="who" checked={pick === m.id} onChange={() => setPick(m.id)} />
              <span className="row-main">
                <span>{m.name}</span>
                <span className="row-sub">Already in the list; keeps their expenses</span>
              </span>
            </label>
          ))}
          <label className="check">
            <input type="radio" name="who" checked={pick === 'new'} onChange={() => setPick('new')} />
            <span className="row-main">
              <span>Someone new: {request.name}</span>
              <span className="row-sub">Added to the group</span>
            </span>
          </label>
        </fieldset>
        <button
          className="pill primary wide"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            const m = group.members.find((x) => x.id === pick);
            onPick(
              m
                ? { type: 'updateMember', group: group.id, member: { ...m, userId: request.user_id } }
                : { type: 'addMember', group: group.id, member: { ...newMember(request.name), userId: request.user_id } },
            );
          }}
        >
          {busy ? 'Letting them in…' : `Let ${request.name.split(/\s+/)[0]} in`}
        </button>
      </div>
    </Sheet>
  );
}
