import type { ReactNode } from 'react';
import type { WindowInfo } from '../../shared/ipc';
import { api, hostOf } from '../api';
import { PermissionPromptCard } from './Site';
import { Favicon } from './Sidebar';

/** A private window's sidebar: its own tabs only. No Spaces, pinned tabs or Favorites, since none of it is saved. */
export function PrivateSidebar({ win, openCommandBar, children }: { win: WindowInfo; openCommandBar(mode: 'new' | 'current'): void; children?: ReactNode }) {
  const tabs = win.private?.tabs ?? [];
  const selected = tabs.find((t) => t.id === win.private?.selectedId);
  return (
    <aside className="sidebar private-sidebar">
      <div className="sidebar-top">
        <div className="traffic-spacer" />
        <button className="icon-btn" title="Hide sidebar" onClick={() => api.command({ type: 'runAction', id: 'toggleSidebar' })}>⎍</button>
        <button className="icon-btn" title="Back" disabled={!selected?.canGoBack} onClick={() => api.command({ type: 'navigate', op: 'back' })}>←</button>
        <button className="icon-btn" title="Forward" disabled={!selected?.canGoForward} onClick={() => api.command({ type: 'navigate', op: 'forward' })}>→</button>
        <button className="icon-btn" title={selected?.loading ? 'Stop' : 'Reload'} onClick={() => api.command({ type: 'navigate', op: selected?.loading ? 'stop' : 'reload' })}>
          {selected?.loading ? '✕' : '↻'}
        </button>
      </div>

      <div className="url-row">
        <button className="url-pill" onClick={() => openCommandBar('current')} title={selected?.url}>
          {selected ? hostOf(selected.url) : 'Search or enter address'}
          {win.zoom !== 1 && <span className="zoom-badge">{Math.round(win.zoom * 100)}%</span>}
        </button>
      </div>

      {win.permissionPrompt && <PermissionPromptCard prompt={win.permissionPrompt} />}

      <div className="private-label" title="Nothing from this window is saved">◐ Private</div>

      <div className="sidebar-scroll">
        <button className="new-tab-row" onClick={() => openCommandBar('new')}>
          <span className="plus">+</span> New Tab
        </button>
        {tabs.map((t) => (
          <div key={t.id} className={`row private-tab ${t.id === selected?.id ? 'selected' : ''}`} onClick={() => api.command({ type: 'select', id: t.id })}>
            {t.loading ? <span className="row-icon spinner" /> : <Favicon url={t.url} size={16} />}
            <span className="row-title">{t.title || hostOf(t.url) || 'New Tab'}</span>
            <button className="close-btn" title="Close" onClick={(e) => { e.stopPropagation(); void api.command({ type: 'close', id: t.id }); }}>×</button>
          </div>
        ))}
      </div>

      {children}
    </aside>
  );
}
