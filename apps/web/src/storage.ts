/**
 * Local persistence until the night syncs to Supabase. Browser storage can be
 * missing or throw (private mode, embedded previews), so every access is guarded
 * and the app keeps working in memory.
 */
import type { State } from './model.ts';

const KEY = 'marmoot:v1';

export function load(): State {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (!raw) return { nights: [] };
    const parsed = JSON.parse(raw) as State;
    return Array.isArray(parsed.nights) ? parsed : { nights: [] };
  } catch {
    return { nights: [] };
  }
}

export function save(s: State): boolean {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(s));
    return true;
  } catch {
    return false;
  }
}
