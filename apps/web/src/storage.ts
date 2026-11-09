/**
 * Local persistence until groups sync to Supabase. Browser storage can be missing or
 * throw (private mode, embedded previews), so every access is guarded and the app
 * keeps working in memory.
 */
import type { State } from './model.ts';

const KEY = 'marmoot:v2';

export function load(): State {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (!raw) return { groups: [], theme: 'system' };
    const parsed = JSON.parse(raw) as Partial<State>;
    return { groups: Array.isArray(parsed.groups) ? parsed.groups : [], theme: parsed.theme ?? 'system' };
  } catch {
    return { groups: [], theme: 'system' };
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
