import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, type Api, type SheetData } from '../api.ts';

/**
 * Loads a sheet and keeps it fresh: every few seconds while the page is visible, and
 * right away when it comes back into view. `change` applies an edit on screen first,
 * sends it, and reloads; if the server refuses, the reload puts things back.
 */
export function useSheet(api: Api, token: string, everyMs = 4000) {
  const [data, setData] = useState<SheetData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(0);

  const reload = useCallback(async () => {
    try {
      const d = await api.sheet(token);
      if (pending.current === 0) setData(d);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Something went wrong loading this bill.');
    }
  }, [api, token]);

  useEffect(() => {
    void reload();
    const tick = () => {
      if (document.visibilityState === 'visible') void reload();
    };
    const timer = window.setInterval(tick, everyMs);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [reload, everyMs]);

  const change = useCallback(
    async (optimistic: ((d: SheetData) => SheetData) | null, send: () => Promise<unknown>) => {
      if (optimistic) setData((d) => (d ? optimistic(d) : d));
      pending.current += 1;
      setBusy(true);
      try {
        await send();
        return true;
      } catch (e) {
        setError(e instanceof ApiError ? e.message : 'That change did not save. Try again.');
        return false;
      } finally {
        pending.current -= 1;
        setBusy(pending.current > 0);
        await reload();
      }
    },
    [reload],
  );

  return { data, error, busy, reload, change, setError };
}

/** The sheet with one cell changed, for showing a tap before the server answers. */
export function withChoice(d: SheetData, item: string, person: string, isIn: boolean): SheetData {
  const choices = d.choices.filter((c) => !(c.item_id === item && c.person_id === person));
  choices.push({ item_id: item, person_id: person, is_in: isIn });
  const people = isIn ? d.people.map((p) => (p.id === person ? { ...p, out_of_bill: false } : p)) : d.people;
  return { ...d, choices, people };
}
