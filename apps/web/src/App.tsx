import { useEffect, useReducer, useState, useSyncExternalStore } from 'react';
import { reducer } from './model.ts';
import { load, save } from './storage.ts';
import { Home } from './ui/Home.tsx';
import { NightView, type Step } from './ui/NightView.tsx';

const subscribe = (cb: () => void) => {
  window.addEventListener('hashchange', cb);
  return () => window.removeEventListener('hashchange', cb);
};

export function go(path: string) {
  window.location.hash = path;
}

export function App() {
  const [state, dispatch] = useReducer(reducer, undefined, load);
  const [saved, setSaved] = useState(true);
  useEffect(() => setSaved(save(state)), [state]);
  const hash = useSyncExternalStore(subscribe, () => window.location.hash, () => '');

  const m = /^#\/n\/([^/]+)(?:\/(table|cashout|settle))?$/.exec(hash);
  const night = m ? state.nights.find((n) => n.id === m[1]) : undefined;
  if (m && night) {
    return <NightView night={night} step={(m[2] as Step | undefined) ?? 'table'} dispatch={dispatch} saved={saved} />;
  }
  return <Home nights={state.nights} dispatch={dispatch} saved={saved} />;
}
