import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';
import type { LiveTab, WindowInfo } from '../../shared/ipc';
import { itemTitle, type Item, type Space, type State } from '../../shared/model';
import { isAncestor } from '../../shared/tree';
import { api, dispatch, faviconFor, hostOf } from '../api';
import { originOf } from '../../shared/permissions';
import { DownloadsList, PermissionPromptCard, SitePermissionList, downloadProgress, useDownloads } from './Site';

const DRAG_TYPE = 'application/x-openarc-item';

interface Props {
  state: State;
  win: WindowInfo;
  live: Record<string, LiveTab>;
  renamingId: string | null;
  setRenamingId(id: string | null): void;
  openCommandBar(mode: 'new' | 'current'): void;
  openOverlay(name: string, arg?: string): void;
  children?: ReactNode;
}

type DropPos = 'before' | 'after' | 'inside';

export function Sidebar(p: Props) {
  const { state, win } = p;
  const space = state.spaces.find((s) => s.id === win.spaceId) ?? state.spaces[0]!;
  const favRoot = state.items[state.favorites[space.profileId] ?? ''];
  const pinnedRoot = state.items[space.pinnedRootId];
  const todayRoot = state.items[space.todayRootId];
  const selected = win.selectedId ? p.live[win.selectedId] : undefined;
  const swipe = useRef({ dx: 0, at: 0 });
  const [panel, setPanel] = useState<'site' | 'downloads' | null>(null);
  const origin = selected ? originOf(selected.url) : null;

  // Two-finger horizontal swipe switches Spaces.
  const onWheel = (e: React.WheelEvent) => {
    if (Math.abs(e.deltaX) < Math.abs(e.deltaY)) return;
    const now = Date.now();
    if (now - swipe.current.at > 400) swipe.current.dx = 0;
    swipe.current.at = now;
    swipe.current.dx += e.deltaX;
    if (Math.abs(swipe.current.dx) > 140) {
      const i = state.spaces.findIndex((s) => s.id === space.id);
      const next = state.spaces[(i + (swipe.current.dx > 0 ? 1 : -1) + state.spaces.length) % state.spaces.length];
      swipe.current.dx = 0;
      swipe.current.at = now + 600;
      if (next) void api.command({ type: 'switchSpace', spaceId: next.id });
    }
  };

  return (
    <aside className="sidebar" onWheel={onWheel} style={{ ['--space' as string]: space.color }}>
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
        <button className="url-pill" onClick={() => p.openCommandBar('current')} title={selected?.url}>
          {selected ? hostOf(selected.url) : 'Search or enter address'}
          {win.zoom !== 1 && <span className="zoom-badge">{Math.round(win.zoom * 100)}%</span>}
          {!!selected?.capturing?.length && <span className="capture-dot" title={`Using your ${selected.capturing.join(' and ')}`}>●</span>}
        </button>
        <button className={`icon-btn site-btn ${panel === 'site' ? 'on' : ''}`} title="Site settings" disabled={!origin} onClick={() => setPanel(panel === 'site' ? null : 'site')}>⚙︎</button>
      </div>

      {win.permissionPrompt && <PermissionPromptCard prompt={win.permissionPrompt} />}
      {panel === 'site' && origin && (
        <div className="sidebar-panel site-panel">
          <header><span className="ellipsis">{hostOf(origin)}</span><button className="icon-btn" onClick={() => setPanel(null)}>×</button></header>
          <SitePermissionList state={state} origin={origin} />
        </div>
      )}

      {favRoot && (
        <FavoritesGrid state={state} root={favRoot} win={win} live={p.live} />
      )}

      <div className="sidebar-scroll">
        {state.settings.showSpaceHeader && (
          <div className="space-header" onContextMenu={(e) => { e.preventDefault(); void api.command({ type: 'contextMenu', target: { kind: 'space', id: space.id } }); }}>
            <span className="space-icon">{space.icon ?? '●'}</span>
            <span className="space-title">{space.title}</span>
          </div>
        )}

        {pinnedRoot && (
          <Section
            {...p}
            root={pinnedRoot}
            section="pinned"
            space={space}
            collapsed={!!space.pinnedCollapsed}
            header={
              <div className="section-label" onClick={() => dispatch({ type: 'space.update', id: space.id, patch: { pinnedCollapsed: !space.pinnedCollapsed } })}>
                <span className={`chev ${space.pinnedCollapsed ? '' : 'open'}`}>›</span> Pinned
              </div>
            }
          />
        )}

        <div className="divider" onContextMenu={(e) => { e.preventDefault(); void api.command({ type: 'contextMenu', target: { kind: 'section', spaceId: space.id, section: 'today' } }); }}>
          <span className="divider-line" />
          {(todayRoot?.children.length ?? 0) > 0 && (
            <button className="clear-btn" title="Archive all Today tabs" onClick={() => api.command({ type: 'runAction', id: 'clearToday' })}>↓ Clear</button>
          )}
        </div>

        <button className="new-tab-row" onClick={() => p.openCommandBar('new')}>
          <span className="plus">+</span> New Tab
        </button>

        {todayRoot && <Section {...p} root={todayRoot} section="today" space={space} collapsed={false} header={null} />}
      </div>

      {p.children}

      {panel === 'downloads' && (
        <div className="sidebar-panel downloads-panel">
          <header>
            <span>Downloads</span>
            <button className="link" onClick={() => { setPanel(null); p.openOverlay('downloads'); }}>Show all</button>
            <button className="icon-btn" onClick={() => setPanel(null)}>×</button>
          </header>
          <DownloadsList state={state} limit={6} />
        </div>
      )}

      <MiniPlayer state={state} win={win} live={p.live} />

      <SpaceBar state={state} space={space} openOverlay={p.openOverlay} downloadsOpen={panel === 'downloads'} toggleDownloads={() => setPanel(panel === 'downloads' ? null : 'downloads')} />
    </aside>
  );
}

/**
 * Media playing in a tab you can't see: its title, play/pause, mute, and a jump back to the tab.
 * A paused player stays until you go back to that tab, so you can resume it from here.
 */
function MiniPlayer({ state, win, live }: { state: State; win: WindowInfo; live: Record<string, LiveTab> }) {
  const sel = win.selectedId ? state.items[win.selectedId] : null;
  const split = sel?.parentId ? state.items[sel.parentId] : null;
  const visible = new Set(split?.kind === 'split' ? split.children : win.selectedId ? [win.selectedId] : []);
  const playingId = Object.keys(live).find((id) => live[id]!.playing && !visible.has(id) && state.items[id]);
  const [kept, setKept] = useState<string | null>(null);
  useEffect(() => {
    if (playingId) setKept(playingId);
    else if (kept && visible.has(kept)) setKept(null);
  }, [playingId, kept, win.selectedId]);
  const id = playingId ?? (kept && live[kept] && state.items[kept] && !visible.has(kept) ? kept : null);
  const t = id ? live[id] : null;
  if (!id || !t) return null;
  return (
    <div className="mini-player">
      <Favicon url={t.url} known={t.favicon} size={16} />
      <button className="mini-player-title" title="Go to tab" onClick={() => api.command({ type: 'select', id })}>{t.title || hostOf(t.url)}</button>
      <button className="icon-btn" title={t.playing ? 'Pause' : 'Play'} onClick={() => api.command({ type: 'media', id, op: 'playPause' })}>{t.playing ? '❚❚' : '▶'}</button>
      <button className="icon-btn" title={t.muted ? 'Unmute' : 'Mute'} onClick={() => api.command({ type: 'media', id, op: 'mute' })}>{t.muted ? '🔇' : '🔊'}</button>
    </div>
  );
}

function FavoritesGrid({ state, root, win, live }: { state: State; root: Item; win: WindowInfo; live: Record<string, LiveTab> }) {
  const [over, setOver] = useState(false);
  const onDrop = (e: DragEvent) => {
    const id = e.dataTransfer.getData(DRAG_TYPE);
    setOver(false);
    if (id) dispatch({ type: 'item.move', id, parentId: root.id, index: Infinity });
  };
  return (
    <div
      className={`favorites ${over ? 'drop-target' : ''} ${root.children.length ? '' : 'empty'}`}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
      onContextMenu={(e) => { e.preventDefault(); void api.command({ type: 'contextMenu', target: { kind: 'favorites' } }); }}
    >
      {root.children.map((id) => {
        const item = state.items[id];
        if (!item?.tab) return null;
        const lt = live[id];
        return (
          <button
            key={id}
            className={`fav ${win.selectedId === id ? 'selected' : ''} ${lt ? 'loaded' : ''}`}
            title={item.title || lt?.title || itemTitle(item)}
            draggable
            onDragStart={(e) => e.dataTransfer.setData(DRAG_TYPE, id)}
            onClick={() => api.command({ type: 'select', id })}
            onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); void api.command({ type: 'contextMenu', target: { kind: 'item', id } }); }}
          >
            <Favicon url={item.tab.savedURL} known={lt?.favicon ?? item.tab.faviconURL} size={20} />
            {lt?.audible && <span className="fav-audio">♪</span>}
          </button>
        );
      })}
      {!root.children.length && <div className="fav-hint">Drag tabs here to keep them as Favorites</div>}
    </div>
  );
}

function Section(p: Props & { root: Item; section: 'pinned' | 'today'; space: Space; collapsed: boolean; header: ReactNode }) {
  const [endOver, setEndOver] = useState(false);
  return (
    <div className={`section section-${p.section}`}>
      {p.header}
      {!p.collapsed && (
        <ul className="tree">
          {p.root.children.map((id) => (
            <Row key={id} {...p} id={id} depth={0} />
          ))}
        </ul>
      )}
      <div
        className={`section-end ${endOver ? 'drop-line' : ''} ${p.root.children.length ? '' : 'empty'}`}
        onDragOver={(e) => { e.preventDefault(); setEndOver(true); }}
        onDragLeave={() => setEndOver(false)}
        onDrop={(e) => {
          setEndOver(false);
          const id = e.dataTransfer.getData(DRAG_TYPE);
          if (id) dispatch({ type: 'item.move', id, parentId: p.root.id, index: Infinity });
        }}
        onContextMenu={(e) => { e.preventDefault(); void api.command({ type: 'contextMenu', target: { kind: 'section', spaceId: p.space.id, section: p.section } }); }}
      >
        {!p.root.children.length && p.section === 'pinned' && <span className="hint">Drag tabs here to pin them</span>}
      </div>
    </div>
  );
}

function Row(p: Props & { id: string; depth: number; section: 'pinned' | 'today' }) {
  const { state, win, live, id } = p;
  const item = state.items[id];
  const [drop, setDrop] = useState<DropPos | null>(null);
  if (!item) return null;
  const lt = live[id];
  const isContainer = item.kind === 'folder' || item.kind === 'group';
  const selected = win.selectedId === id || (item.kind === 'split' && item.children.includes(win.selectedId ?? ''));
  const title = item.title || lt?.title || itemTitle(item);
  const persistent = p.section === 'pinned';
  const awayFromHome = persistent && item.tab && lt && lt.url && stripHash(lt.url) !== stripHash(item.tab.savedURL);

  const onDragOver = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const y = (e.clientY - r.top) / r.height;
    setDrop(isContainer && y > 0.3 && y < 0.7 ? 'inside' : y < 0.5 ? 'before' : 'after');
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const dragged = e.dataTransfer.getData(DRAG_TYPE);
    const pos = drop;
    setDrop(null);
    if (!dragged || dragged === id || !pos || isAncestor(state, dragged, id)) return;
    if (pos === 'inside') return dispatch({ type: 'item.move', id: dragged, parentId: id, index: Infinity });
    const parent = state.items[item.parentId!]!;
    const at = parent.children.indexOf(id) + (pos === 'after' ? 1 : 0);
    dispatch({ type: 'item.move', id: dragged, parentId: parent.id, index: at });
  };
  const onClick = () => {
    if (isContainer) dispatch({ type: 'item.toggleCollapsed', id });
    else void api.command({ type: 'select', id });
  };
  const onClose = (e: React.MouseEvent) => {
    e.stopPropagation();
    void api.command({ type: persistent ? 'unload' : 'close', id });
  };

  return (
    <li className="tree-li">
      <div
        className={`row kind-${item.kind} ${selected ? 'selected' : ''} ${item.tab && !lt && persistent ? 'unloaded' : ''} ${drop ? `drop-${drop}` : ''} ${item.isUnread ? 'unread' : ''}`}
        style={{ paddingLeft: 8 + p.depth * 14 }}
        draggable
        onDragStart={(e) => { e.stopPropagation(); e.dataTransfer.setData(DRAG_TYPE, id); e.dataTransfer.effectAllowed = 'move'; }}
        onDragOver={onDragOver}
        onDragLeave={() => setDrop(null)}
        onDrop={onDrop}
        onClick={onClick}
        onAuxClick={(e) => e.button === 1 && item.tab && onClose(e)}
        onDoubleClick={(e) => { e.stopPropagation(); p.setRenamingId(id); }}
        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); void api.command({ type: 'contextMenu', target: { kind: 'item', id } }); }}
      >
        {isContainer && <span className={`chev ${item.collapsed ? '' : 'open'}`}>›</span>}
        <RowIcon item={item} live={lt} state={state} />
        {p.renamingId === id ? (
          <input
            className="rename"
            autoFocus
            defaultValue={item.title ?? ''}
            placeholder={itemTitle(item)}
            onClick={(e) => e.stopPropagation()}
            onBlur={(e) => { dispatch({ type: 'item.rename', id, title: e.target.value }); p.setRenamingId(null); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              if (e.key === 'Escape') p.setRenamingId(null);
            }}
          />
        ) : item.kind === 'split' ? (
          <span className="split-chips">
            {item.children.map((c) => {
              const ci = state.items[c];
              return ci ? (
                <span key={c} className={`chip ${win.selectedId === c ? 'on' : ''}`} onClick={(e) => { e.stopPropagation(); void api.command({ type: 'select', id: c }); }}>
                  <Favicon url={ci.tab?.savedURL ?? ''} known={live[c]?.favicon ?? ci.tab?.faviconURL} size={14} />
                  <span className="chip-title">{live[c]?.title || itemTitle(ci)}</span>
                </span>
              ) : null;
            })}
          </span>
        ) : (
          <span className="row-title">{title}</span>
        )}
        {lt?.audible && <span className="audio" title={lt.muted ? 'Muted' : 'Playing audio'}>{lt.muted ? '🔇' : '♪'}</span>}
        {awayFromHome && (
          <button className="home-btn" title="Back to the pinned page" onClick={(e) => { e.stopPropagation(); void api.command({ type: 'goHome', id }); }}>⌂</button>
        )}
        {item.kind === 'folder' && item.live && <span className="badge">{item.children.filter((c) => state.items[c]?.isUnread).length || ''}</span>}
        {(item.tab || item.kind === 'split' || item.kind === 'note' || item.kind === 'easel') && (persistent ? !!lt : true) && (
          <button className="close-btn" title={persistent ? 'Unload' : 'Close'} onClick={onClose}>{persistent ? '–' : '×'}</button>
        )}
      </div>
      {isContainer && !item.collapsed && (
        <ul className={`tree ${item.kind === 'group' ? 'group-children' : ''}`}>
          {item.children.map((c) => (
            <Row key={c} {...p} id={c} depth={p.depth + 1} />
          ))}
          {!item.children.length && <li className="empty-folder" style={{ paddingLeft: 22 + (p.depth + 1) * 14 }}>Empty</li>}
        </ul>
      )}
    </li>
  );
}

function RowIcon({ item, live, state }: { item: Item; live?: LiveTab; state: State }) {
  if (item.kind === 'folder') return <span className="row-icon">{item.live ? '⟳' : item.collapsed ? '▸' : '▾'}</span>;
  if (item.kind === 'group') return <span className="row-icon group-dot" />;
  if (item.kind === 'note') return <span className="row-icon">✎</span>;
  if (item.kind === 'easel') return <span className="row-icon">◩</span>;
  if (item.kind === 'split') return <span className="row-icon">◫</span>;
  void state;
  if (live?.loading) return <span className="row-icon spinner" />;
  return <Favicon url={item.tab?.savedURL ?? ''} known={live?.favicon ?? item.tab?.faviconURL} size={16} />;
}

export function Favicon({ url, known, size }: { url: string; known?: string | null; size: number }) {
  const [status, setStatus] = useState<'loading' | 'ok' | 'failed'>('loading');
  const src = faviconFor(url, known);
  useEffect(() => setStatus('loading'), [src]);
  // The letter shows until the icon has actually loaded, so slow or missing icons never leave a blank.
  return (
    <span className="favicon-box" style={{ width: size, height: size }}>
      {status !== 'ok' && <span className="favicon-fallback" style={{ width: size, height: size, fontSize: size * 0.6 }}>{(hostOf(url)[0] ?? '•').toUpperCase()}</span>}
      {src && status !== 'failed' && (
        <img className="favicon" src={src} width={size} height={size} onLoad={() => setStatus('ok')} onError={() => setStatus('failed')} alt="" style={status === 'ok' ? undefined : { position: 'absolute', opacity: 0 }} />
      )}
    </span>
  );
}

function SpaceBar({ state, space, openOverlay, downloadsOpen, toggleDownloads }: { state: State; space: Space; openOverlay(name: string, arg?: string): void; downloadsOpen: boolean; toggleDownloads(): void }) {
  const [over, setOver] = useState<string | null>(null);
  const progress = downloadProgress(useDownloads(state));
  return (
    <div className="space-bar">
      <button className="icon-btn" title="Library" onClick={() => openOverlay('library')}>▤</button>
      <button className={`icon-btn downloads-btn ${downloadsOpen ? 'on' : ''} ${progress !== null ? 'active' : ''}`} title="Downloads" onClick={toggleDownloads}>
        {progress !== null && <ProgressRing value={progress} />}
        <span>↓</span>
      </button>
      <div className="space-dots">
        {state.spaces.map((s, i) => (
          <button
            key={s.id}
            className={`space-dot ${s.id === space.id ? 'active' : ''} ${over === s.id ? 'drop-target' : ''}`}
            style={{ ['--dot' as string]: s.color }}
            title={`${s.title} (⌃${i + 1})`}
            onClick={() => api.command({ type: 'switchSpace', spaceId: s.id })}
            onDoubleClick={() => openOverlay('editSpace', s.id)}
            onContextMenu={(e) => { e.preventDefault(); void api.command({ type: 'contextMenu', target: { kind: 'space', id: s.id } }); }}
            onDragOver={(e) => { e.preventDefault(); setOver(s.id); }}
            onDragLeave={() => setOver(null)}
            onDrop={(e) => {
              setOver(null);
              const id = e.dataTransfer.getData(DRAG_TYPE);
              if (id) dispatch({ type: 'item.move', id, parentId: s.todayRootId, index: 0 });
            }}
          >
            {s.icon ?? ''}
          </button>
        ))}
      </div>
      <button className="icon-btn" title="New Space" onClick={() => openOverlay('editSpace')}>+</button>
    </div>
  );
}

function ProgressRing({ value }: { value: number }) {
  const r = 11;
  const c = 2 * Math.PI * r;
  return (
    <svg className="progress-ring" viewBox="0 0 26 26" aria-hidden>
      <circle cx="13" cy="13" r={r} className="track" />
      <circle cx="13" cy="13" r={r} className="fill" strokeDasharray={c} strokeDashoffset={c * (1 - value)} />
    </svg>
  );
}

function stripHash(u: string) {
  return u.replace(/#.*$/, '').replace(/\/$/, '');
}

