import { useEffect, useReducer, useState, useSyncExternalStore } from 'react';
import { newId, reducer, today } from './model.ts';
import { api } from './apiClient.ts';
import { load, save } from './storage.ts';
import { GameView } from './ui/GameView.tsx';
import { GroupView } from './ui/GroupView.tsx';
import { GuestSheet } from './ui/GuestSheet.tsx';
import { NewSheet } from './ui/NewSheet.tsx';
import { SheetView } from './ui/SheetView.tsx';
import { Home } from './ui/Home.tsx';
import { NewGroup } from './ui/NewGroup.tsx';
import { PeopleView } from './ui/PeopleView.tsx';
import { SettleView } from './ui/SettleView.tsx';

const subscribe = (cb: () => void) => {
  window.addEventListener('hashchange', cb);
  return () => window.removeEventListener('hashchange', cb);
};

export function go(path: string) {
  window.location.hash = path;
  window.scrollTo(0, 0);
}

export function App() {
  const [state, dispatch] = useReducer(reducer, undefined, load);
  const [saved, setSaved] = useState(true);
  const hash = useSyncExternalStore(subscribe, () => window.location.hash, () => '');

  useEffect(() => setSaved(save(state)), [state]);

  // Post recurring bills that fell due since the app was last open.
  useEffect(() => {
    dispatch({ type: 'catchUp', today: today(), ids: newId, now: Date.now() });
  }, []);

  // Light, dark, or follow the phone's setting.
  useEffect(() => {
    const root = document.documentElement;
    if (state.theme === 'system') delete root.dataset.theme;
    else root.dataset.theme = state.theme;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const paint = () => {
      const dark = state.theme === 'dark' || (state.theme === 'system' && media.matches);
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#000000' : '#ffffff');
    };
    paint();
    media.addEventListener('change', paint);
    return () => media.removeEventListener('change', paint);
  }, [state.theme]);

  // Someone opening their link to a bill sheet: ?s=<their token>.
  const guestToken = new URLSearchParams(window.location.search).get('s');
  if (guestToken) {
    return api ? <GuestSheet api={api} token={guestToken} /> : <main className="page"><p className="muted">This copy of Marmoot isn't connected to its server, so it can't open shared bills.</p></main>;
  }

  const common = { dispatch, saved };
  if (hash === '#/new') return <NewGroup {...common} />;
  const m = /^#\/g\/([^/]+)(?:\/(settle|people|game|sheet)(?:\/([^/]+))?)?$/.exec(hash);
  const group = m ? state.groups.find((g) => g.id === m[1]) : undefined;
  if (m && group) {
    if (m[2] === 'sheet' && m[3] === 'new') return <NewSheet group={group} dispatch={dispatch} />;
    if (m[2] === 'sheet' && m[3]) {
      const ref = group.sheets?.find((sh) => sh.id === m[3]);
      if (ref && api) return <SheetView api={api} group={group} sheetRef={ref} dispatch={dispatch} />;
    }
    if (m[2] === 'settle') return <SettleView group={group} {...common} />;
    if (m[2] === 'people') return <PeopleView group={group} {...common} />;
    if (m[2] === 'game' && m[3]) {
      const game = group.items.find((i) => i.kind === 'game' && i.id === m[3]);
      if (game?.kind === 'game') return <GameView group={group} game={game} {...common} />;
    }
    return <GroupView group={group} {...common} />;
  }
  return <Home state={state} {...common} />;
}
