/**
 * Where an invite link lands: ?join=<token>. Sign in with Google, ask to join, and go
 * straight into the group once someone in it lets you in.
 */
import { useCallback, useEffect, useState } from 'react';
import { useAccount } from '../account.tsx';
import type { InviteInfo } from '../api.ts';
import { api } from '../apiClient.ts';
import { Notice } from './bits.tsx';
import { SignInButton } from './Sharing.tsx';

const ASK_AFTER_SIGN_IN = 'marmoot:join-after-sign-in';

function leaveTo(hash: string) {
  const url = new URL(window.location.href);
  url.searchParams.delete('join');
  url.hash = '';
  window.history.replaceState(null, '', url.toString());
  window.location.hash = hash;
}

export function JoinPage({ token }: { token: string }) {
  const account = useAccount();
  const [info, setInfo] = useState<InviteInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const signedIn = !!account.session;

  const load = useCallback(async () => {
    if (!api) return;
    try {
      setInfo(await api.inviteInfo(token));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'This invite link doesn’t work.');
    }
  }, [token]);

  useEffect(() => {
    if (account.ready) void load();
  }, [account.ready, signedIn, load]);

  useEffect(() => {
    if (account.name && !name) setName(account.name);
  }, [account.name, name]);

  const ask = useCallback(
    async (as: string) => {
      if (!api || !as.trim()) return;
      setBusy(true);
      setError(null);
      try {
        const r = await api.requestToJoin(token, as.trim());
        setInfo((i) => (i ? { ...i, status: r.status } : i));
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Asking didn’t work. Try again.');
      } finally {
        setBusy(false);
      }
    },
    [token],
  );

  // Back from Google after tapping "Sign in to join": ask straight away, with the Google name.
  useEffect(() => {
    if (!signedIn || info?.status !== 'none' || !account.name) return;
    let wanted = false;
    try {
      wanted = sessionStorage.getItem(ASK_AFTER_SIGN_IN) === token;
      sessionStorage.removeItem(ASK_AFTER_SIGN_IN);
    } catch {
      // ask by hand
    }
    if (wanted) void ask(account.name);
  }, [signedIn, info?.status, account.name, token, ask]);

  // Waiting to be let in: check every few seconds.
  useEffect(() => {
    if (info?.status !== 'pending') return;
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [info?.status, load]);

  // In: fetch the group, then open it.
  useEffect(() => {
    if (!info || (info.status !== 'member' && info.status !== 'approved') || !signedIn) return;
    void (async () => {
      await account.sync?.pull(info.group_id).catch(() => undefined);
      await account.refresh();
      leaveTo(`#/g/${info.group_id}`);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info?.status, info?.group_id, signedIn]);

  if (!account.available) {
    return <main className="page"><p className="muted">This copy of Marmoot isn't connected to its server, so it can't open invites.</p></main>;
  }

  const who = info?.inviter ? info.inviter.split(/\s+/)[0] : 'Someone';
  return (
    <main className="page">
      <header className="topbar">
        <button className="link" onClick={() => leaveTo('#/')}>Marmoot</button>
      </header>
      {error && <Notice tone="warn">{error}</Notice>}
      {!info && !error && <p className="muted">Opening the invite…</p>}
      {info && (
        <section className="stack">
          <h1>Join {info.group_name}</h1>
          <p className="muted">
            {who} invited you to split bills in {info.group_name}
            {info.members > 1 ? `, with ${info.members - 1} other ${info.members - 1 === 1 ? 'person' : 'people'}` : ''}.
          </p>

          {info.status === 'signed_out' && (
            <>
              <p>Sign in with Google so the group knows it's you and your balance follows you to any phone.</p>
              <div
                onClickCapture={() => {
                  try {
                    sessionStorage.setItem(ASK_AFTER_SIGN_IN, token);
                  } catch {
                    // ask by hand after
                  }
                }}
              >
                <SignInButton label="Sign in with Google to join" primary then="" />
              </div>
            </>
          )}

          {(info.status === 'none' || info.status === 'declined') && (
            <form className="stack" onSubmit={(e) => { e.preventDefault(); void ask(name); }}>
              {info.status === 'declined' && <Notice tone="warn">Your last request wasn’t accepted. You can ask again.</Notice>}
              <label className="field">
                <span>Your name, as the group will see it</span>
                <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoComplete="given-name" />
              </label>
              <button className="pill primary wide" disabled={busy || !name.trim()}>{busy ? 'Asking…' : 'Ask to join'}</button>
            </form>
          )}

          {info.status === 'pending' && (
            <Notice>
              Asked. Waiting for someone in {info.group_name} to let you in. This page opens the group as soon as they do; you can also close it and use the link again later.
            </Notice>
          )}

          {(info.status === 'member' || info.status === 'approved') && <p className="muted">You're in. Opening {info.group_name}…</p>}
        </section>
      )}
    </main>
  );
}
