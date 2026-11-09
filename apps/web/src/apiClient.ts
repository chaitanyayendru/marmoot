/**
 * The app's connection to Marmoot's server, from build-time settings in .env.local:
 *   VITE_SUPABASE_URL=https://<project>.supabase.co
 *   VITE_SUPABASE_ANON_KEY=<anon or publishable key>
 * Without them, everything that doesn't need the server still works.
 */
import { createApi } from './api.ts';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const api = url && key ? createApi(url, key) : null;

/** The link a person opens to see their part of a sheet. */
export function sheetLink(token: string): string {
  return `${window.location.origin}${window.location.pathname}?s=${encodeURIComponent(token)}`;
}
