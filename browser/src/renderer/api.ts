import { useEffect, useState } from 'react';
import type { Api, LiveTab, UiEvents, WindowInfo } from '../shared/ipc';
import type { State } from '../shared/model';
import type { Action } from '../shared/reducer';

declare global {
  interface Window {
    openArc: Api;
  }
}

export const api = window.openArc;
export const uid = () => crypto.randomUUID();
export const dispatch = (a: Action) => api.dispatch(a);

export function useAppState() {
  const [state, setState] = useState<State | null>(null);
  const [win, setWin] = useState<WindowInfo | null>(null);
  const [live, setLive] = useState<Record<string, LiveTab>>({});
  useEffect(() => {
    void api.getState().then(setState);
    void api.getWindow().then(setWin);
    void api.getLive().then(setLive);
    const offs = [api.on('state', (patch) => setState((s) => (s ? { ...s, ...patch } : s))), api.on('window', setWin), api.on('live', setLive)];
    return () => offs.forEach((off) => off());
  }, []);
  return { state, win, live };
}

export function useUiEvent<K extends keyof UiEvents>(event: K, cb: (payload: UiEvents[K]) => void) {
  useEffect(() => api.on(event, cb), [event, cb]);
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

export function faviconFor(url: string, known?: string | null): string | null {
  if (known) return known;
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? `${u.origin}/favicon.ico` : null;
  } catch {
    return null;
  }
}
