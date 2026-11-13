/**
 * Signing in with Google, through Supabase Auth. Only needed for shared groups:
 * bill sheets and invite pages work without an account.
 *
 * The session is kept in this browser and refreshed on its own. Signing in leaves the
 * app for Google and always comes back to the app's plain address, so Supabase's
 * allow list can hold that one exact URL; where you were (an invite link, a #route)
 * is kept here and restored. The code in the URL is traded for a session (PKCE).
 */
import { useEffect, useState } from 'react';
import { AuthClient, type Session, type User } from '@supabase/auth-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const auth = url && key
  ? new AuthClient({
      url: `${url.replace(/\/+$/, '')}/auth/v1`,
      headers: { apikey: key, Authorization: `Bearer ${key}` },
      storageKey: 'marmoot:auth',
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: true,
      flowType: 'pkce',
    })
  : null;

const RETURN_KEY = 'marmoot:after-sign-in';

/** The signed-in person's access token, for calls to the server. */
export async function accessToken(): Promise<string | null> {
  if (!auth) return null;
  const { data } = await auth.getSession();
  return data.session?.access_token ?? null;
}

/** Leave for Google; come back to where you were. `then` is a #route to open afterwards. */
export async function signIn(then = window.location.hash): Promise<string | null> {
  if (!auth) return 'Sign-in isn’t set up in this copy of Marmoot.';
  const here = new URL(window.location.href);
  here.searchParams.delete('code');
  try {
    sessionStorage.setItem(RETURN_KEY, JSON.stringify({ search: here.search, hash: then }));
  } catch {
    // Where you were is lost; the app opens on the home screen.
  }
  const back = `${window.location.origin}${window.location.pathname}`;
  const { error } = await auth.signInWithOAuth({ provider: 'google', options: { redirectTo: back } });
  return error ? error.message : null;
}

/** After coming back from Google: put the invite link or #route back in the address. */
function restoreReturn() {
  let saved: { search?: string; hash?: string } | null = null;
  try {
    saved = JSON.parse(sessionStorage.getItem(RETURN_KEY) ?? 'null');
    sessionStorage.removeItem(RETURN_KEY);
  } catch {
    return;
  }
  if (!saved) return;
  const url = new URL(window.location.href);
  if (saved.search && !url.search) url.search = saved.search;
  if (saved.hash && !url.hash) url.hash = saved.hash;
  if (url.toString() === window.location.href) return;
  window.history.replaceState(null, '', url.toString());
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}

export async function signOut(): Promise<void> {
  await auth?.signOut();
}

/** First name for the group, from the Google account. */
export function displayName(user: User | null | undefined): string {
  const meta = (user?.user_metadata ?? {}) as { full_name?: string; name?: string; given_name?: string };
  const full = (meta.given_name || meta.full_name || meta.name || user?.email?.split('@')[0] || '').trim();
  return full.split(/\s+/)[0] ?? full;
}

/** The session, kept current. `ready` turns true once the stored session (or a sign-in coming back) has been read. */
export function useSession(): { session: Session | null; ready: boolean; error: string | null } {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(!auth);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!auth) return;
    let live = true;
    void auth.getSession().then(({ data, error: e }) => {
      if (!live) return;
      setSession(data.session);
      if (e) setError(e.message);
      // Back from Google: reopen where they were.
      if (data.session) restoreReturn();
      setReady(true);
    });
    const { data } = auth.onAuthStateChange((_event, s) => {
      if (live) setSession(s);
    });
    return () => {
      live = false;
      data.subscription.unsubscribe();
    };
  }, []);
  return { session, ready, error };
}
