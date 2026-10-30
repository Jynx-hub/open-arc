// Extensions: pinned toolbar buttons and the extensions menu in the sidebar, and the full list in Library.
import { useCallback, useEffect, useState, type ButtonHTMLAttributes } from 'react';
import type { ArcExtension, ExtensionInfo, WindowInfo } from '../../shared/ipc';
import type { State } from '../../shared/model';
import { WEB_STORE_URL } from '../../shared/extensions';
import { api, dispatch, useUiEvent } from '../api';

/** Injected by the preload (electron-chrome-extensions/browser-action). */
interface BrowserActionApi {
  getState(partition: string): Promise<{ activeTabId?: number; actions: { id: string }[] }>;
  addEventListener(name: 'update', listener: (state: { actions: { id: string }[] }) => void): void;
  removeEventListener(name: 'update', listener: (state: { actions: { id: string }[] }) => void): void;
  addObserver(partition: string): void;
  removeObserver(partition: string): void;
}

declare global {
  interface Window {
    browserAction?: BrowserActionApi;
  }
}

/** This window's Profile's extensions, refreshed when they change or the window moves to another Profile. */
export function useExtensions(win: WindowInfo): ExtensionInfo[] {
  const [list, setList] = useState<ExtensionInfo[]>([]);
  useEffect(() => {
    if (!win.extensionPartition) return setList([]);
    void api.command<ExtensionInfo[]>({ type: 'extensions' }).then(setList);
  }, [win.extensionPartition]);
  useUiEvent('extensions', setList);
  return list;
}

/** Ids of extensions whose button the action API knows (only those can be drawn as `browser-action`). */
function useActionIds(partition: string | null): Set<string> {
  const [ids, setIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    const ba = window.browserAction;
    if (!ba || !partition) return setIds(new Set());
    const update = (s: { actions: { id: string }[] }) => setIds(new Set(s.actions.map((a) => a.id)));
    ba.addEventListener('update', update);
    ba.addObserver(partition);
    void ba.getState(partition).then(update, () => {});
    return () => {
      ba.removeEventListener('update', update);
      ba.removeObserver(partition);
    };
  }, [partition]);
  return ids;
}

/** An extension's button: click opens its popup (or tells it it was clicked), right-click its menu. */
function ActionButton({ id, win }: { id: string; win: WindowInfo }) {
  const attrs = { is: 'browser-action', id, partition: win.extensionPartition!, tab: String(win.activeTabId ?? -1), alignment: 'bottom right', className: 'ext-action' };
  return <button {...(attrs as ButtonHTMLAttributes<HTMLButtonElement>)} />;
}

/** The pinned extension buttons, in a row under the address. */
/** Pinned extensions of the window's Profile. */
function pinnedOf(state: State, win: WindowInfo): { profileId: string; ids: string[] } {
  const profileId = state.spaces.find((s) => s.id === win.spaceId)?.profileId ?? '';
  return { profileId, ids: state.settings.pinnedExtensions[profileId] ?? [] };
}

export function PinnedExtensions({ state, win }: { state: State; win: WindowInfo }) {
  const ids = useActionIds(win.extensionPartition);
  const pinned = pinnedOf(state, win).ids.filter((id) => ids.has(id));
  if (win.activeTabId == null || !pinned.length) return null;
  return (
    <div className="extension-bar">
      {pinned.map((id) => <ActionButton key={id} id={id} win={win} />)}
    </div>
  );
}

/** The extensions menu: every enabled extension, its button, and a pin toggle. */
export function ExtensionsPanel({ state, win, onClose, openLibrary }: { state: State; win: WindowInfo; onClose(): void; openLibrary(): void }) {
  const list = useExtensions(win).filter((e) => e.enabled);
  const ids = useActionIds(win.extensionPartition);
  const { profileId, ids: pinned } = pinnedOf(state, win);
  const togglePin = (id: string) =>
    dispatch({ type: 'settings.update', patch: { pinnedExtensions: { ...state.settings.pinnedExtensions, [profileId]: pinned.includes(id) ? pinned.filter((x) => x !== id) : [...pinned, id] } } });
  return (
    <div className="sidebar-panel extensions-panel">
      <header>
        <span>Extensions</span>
        <button className="link" onClick={openLibrary}>Manage</button>
        <button className="icon-btn" onClick={onClose}>×</button>
      </header>
      {!list.length && <p className="muted small">No extensions yet. Add them from the Chrome Web Store.</p>}
      <ul className="list compact extensions">
        {list.map((e) => (
          <li key={e.id} className="extension-row">
            {ids.has(e.id) && win.activeTabId != null ? <ActionButton id={e.id} win={win} /> : <ExtensionIcon ext={e} />}
            <span className="grow ellipsis" title={e.description}>{e.name}</span>
            {e.hasAction && (
              <button className={`icon-btn pin-btn ${pinned.includes(e.id) ? 'on' : ''}`} title={pinned.includes(e.id) ? 'Unpin from the sidebar' : 'Pin to the sidebar'} onClick={() => togglePin(e.id)}>
                {pinned.includes(e.id) ? '★' : '☆'}
              </button>
            )}
          </li>
        ))}
      </ul>
      <button className="link" onClick={() => void api.command({ type: 'open', url: WEB_STORE_URL, where: 'newTab' })}>Find more in the Chrome Web Store</button>
    </div>
  );
}

function ExtensionIcon({ ext }: { ext: ExtensionInfo }) {
  return ext.icon ? <img className="ext-icon" src={ext.icon} width={18} height={18} alt="" /> : <span className="ext-icon letter">{ext.name.charAt(0).toUpperCase()}</span>;
}

/** Library › Extensions: turn on/off, remove, and bring over the ones installed in Arc. */
export function ExtensionsView({ win, onClose }: { win: WindowInfo; onClose(): void }) {
  const list = useExtensions(win);
  const [arc, setArc] = useState<ArcExtension[] | null>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const run = useCallback(async (op: 'install' | 'remove' | 'enable' | 'disable', id: string) => {
    setBusy((b) => new Set(b).add(id));
    await api.command({ type: 'extension', op, id });
    setBusy((b) => {
      const n = new Set(b);
      n.delete(id);
      return n;
    });
  }, []);
  if (!win.extensionPartition) return <p className="muted small">Private windows don’t run extensions.</p>;
  const installed = new Set(list.map((e) => e.id));
  return (
    <div className="extensions-view">
      <div className="toolbar">
        <span className="grow muted small">Extensions belong to this Space’s Profile.</span>
        <button onClick={() => { onClose(); void api.command({ type: 'open', url: WEB_STORE_URL, where: 'newTab' }); }}>Get more</button>
      </div>
      {!list.length && <p className="muted small">No extensions installed.</p>}
      <ul className="list extensions">
        {list.map((e) => (
          <li key={e.id} className={`extension-row ${e.enabled ? '' : 'disabled'}`}>
            <ExtensionIcon ext={e} />
            <div className="grow">
              <div className="ellipsis">{e.name} <span className="muted small">{e.version}</span></div>
              {e.description && <div className="muted small ellipsis">{e.description}</div>}
            </div>
            <label className="check" title={e.enabled ? 'Turn off' : 'Turn on'}>
              <input type="checkbox" checked={e.enabled} disabled={busy.has(e.id)} onChange={() => void run(e.enabled ? 'disable' : 'enable', e.id)} /> On
            </label>
            <button className="link" disabled={busy.has(e.id)} onClick={() => void run('remove', e.id)}>Remove</button>
          </li>
        ))}
      </ul>
      <h4>From Arc</h4>
      {!arc ? (
        <button onClick={() => void api.command<ArcExtension[]>({ type: 'arcExtensions' }).then(setArc)}>Find extensions installed in Arc</button>
      ) : !arc.length ? (
        <p className="muted small">No Arc extensions found on this Mac.</p>
      ) : (
        <ul className="list compact arc-extensions">
          {arc.map((a) => (
            <li key={a.id} className="extension-row">
              <span className="grow ellipsis" title={a.id}>{a.name}</span>
              {installed.has(a.id) ? (
                <span className="muted small">Installed</span>
              ) : (
                <button disabled={busy.has(a.id)} onClick={() => void run('install', a.id)}>{busy.has(a.id) ? 'Installing…' : 'Reinstall from Web Store'}</button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
