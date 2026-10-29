import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Rect, UiEvents } from '../shared/ipc';
import { api, useAppState, useUiEvent } from './api';
import { Sidebar } from './components/Sidebar';
import { CommandBar, type CommandBarMode } from './components/CommandBar';
import { ArchiveEducation, BoostEditor, ConfirmDialog, Library, LiveFolderDialog, Settings, SpaceEditor, SpaceManager, Welcome } from './components/Overlays';
import { EaselView, NoteEditor } from './components/Editors';
import { PermissionPromptCard } from './components/Site';

type Overlay =
  | { name: 'commandBar'; mode: CommandBarMode; initial: string }
  | { name: 'library'; tab?: string }
  | { name: 'settings'; tab?: string }
  | { name: 'editSpace'; id?: string }
  | { name: 'deleteSpace'; id: string }
  | { name: 'spaceManager' }
  | { name: 'boost'; id?: string }
  | { name: 'welcome' }
  | { name: 'archiveEducation' }
  | { name: 'liveFolder'; id: string }
  | { name: 'capture' };

const SPLIT_GAP = 6;

export function App({ kind }: { kind: 'main' | 'little' }) {
  const { state, win, live } = useAppState();
  const [overlay, setOverlayState] = useState<Overlay | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [toasts, setToasts] = useState<(UiEvents['toast'] & { id: number })[]>([]);
  const [findOpen, setFindOpen] = useState(false);
  const viewport = useRef<HTMLDivElement>(null);

  // While any overlay is open the live page is swapped for a still picture so the UI can draw on top.
  const setOverlay = useCallback((o: Overlay | null) => {
    setOverlayState(o);
    void api.command({ type: 'overlay', open: !!o });
  }, []);
  const close = useCallback(() => setOverlay(null), [setOverlay]);

  const openCommandBar = useCallback(
    (mode: CommandBarMode) => {
      const url = mode === 'current' && win?.selectedId ? live[win.selectedId]?.url ?? '' : '';
      setOverlay({ name: 'commandBar', mode, initial: url });
    },
    [setOverlay, win?.selectedId, live],
  );

  const runUiAction = useCallback(
    (id: string, arg?: string) => {
      switch (id) {
        case 'commandBar': return openCommandBar(arg === 'split' ? 'split' : 'new');
        case 'focusURL': return openCommandBar(kind === 'little' ? 'current' : 'current');
        case 'library': return setOverlay({ name: 'library' });
        case 'archive': return setOverlay({ name: 'library', tab: 'archive' });
        case 'history': return setOverlay({ name: 'library', tab: 'history' });
        case 'downloads':
        case 'showDownloads': return setOverlay({ name: 'library', tab: 'downloads' });
        case 'settings': return setOverlay({ name: 'settings' });
        case 'linkRules': return setOverlay({ name: 'settings', tab: 'links' });
        case 'newSpace': return setOverlay({ name: 'editSpace' });
        case 'editSpace': return setOverlay({ name: 'editSpace', id: arg });
        case 'deleteSpace': return arg && setOverlay({ name: 'deleteSpace', id: arg });
        case 'spaceManager': return setOverlay({ name: 'spaceManager' });
        case 'boost': return setOverlay({ name: 'boost' });
        case 'welcome': return setOverlay({ name: 'welcome' });
        case 'archiveEducation': return setOverlay({ name: 'archiveEducation' });
        case 'liveFolder': return arg && setOverlay({ name: 'liveFolder', id: arg });
        case 'capture': return setOverlay({ name: 'capture' });
        case 'rename': return setRenamingId(arg ?? null);
        case 'find': return setFindOpen(true);
      }
    },
    [openCommandBar, setOverlay, kind],
  );

  useUiEvent('action', useCallback(({ id, arg }) => runUiAction(id, arg), [runUiAction]));
  useEffect(() => void api.command({ type: 'ready' }), []);
  useUiEvent(
    'toast',
    useCallback((t: UiEvents['toast']) => {
      const id = Date.now() + Math.random();
      setToasts((ts) => [...ts.slice(-2), { ...t, id }]);
      setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== id)), 4000);
    }, []),
  );

  // Report where page views go: the viewport box, which moves with the sidebar and the find bar.
  useLayoutEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const report = () => {
      const r = el.getBoundingClientRect();
      const rect: Rect = { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
      api.setContentBounds(rect);
    };
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    window.addEventListener('resize', report);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', report);
    };
  }, [state === null, win?.sidebarHidden, findOpen, kind, !!win?.permissionPrompt]);

  if (!state || !win) return <div className="loading" />;
  const space = state.spaces.find((s) => s.id === win.spaceId) ?? state.spaces[0]!;
  const selected = win.selectedId ? state.items[win.selectedId] : null;
  const selectedUrl = win.selectedId ? live[win.selectedId]?.url ?? selected?.tab?.savedURL ?? null : win.little?.url ?? null;
  const parent = selected?.parentId ? state.items[selected.parentId] : null;
  const split = parent?.kind === 'split' ? parent : null;

  const toastStack = (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className="toast">
          <span>{t.message}</span>
          {t.actionLabel && t.command && (
            <button
              className="link"
              onClick={() => {
                const c = t.command!;
                if (c.type === 'runAction' && ['archive', 'library', 'downloads'].includes(c.id)) runUiAction(c.id);
                else void api.command(c);
                setToasts((ts) => ts.filter((x) => x.id !== t.id));
              }}
            >
              {t.actionLabel}
            </button>
          )}
        </div>
      ))}
    </div>
  );

  return (
    <div className={`app kind-${kind} ${win.sidebarHidden ? 'no-sidebar' : ''}`} style={{ ['--space' as string]: space.color }}>
      {kind === 'main' && !win.sidebarHidden && (
        <Sidebar state={state} win={win} live={live} renamingId={renamingId} setRenamingId={setRenamingId} openCommandBar={openCommandBar} openOverlay={(n, a) => runUiAction(n, a)}>
          {toastStack}
        </Sidebar>
      )}
      <main className="content">
        {kind === 'little' && <LittleBar state={state} url={win.little?.url ?? ''} title={win.little?.title ?? ''} onEdit={() => openCommandBar('current')} />}
        {kind === 'main' && win.sidebarHidden && <div className="hidden-sidebar-strip" onMouseEnter={() => api.command({ type: 'runAction', id: 'toggleSidebar' })} />}
        {win.permissionPrompt && (kind === 'little' || win.sidebarHidden) && <PermissionPromptCard prompt={win.permissionPrompt} bar />}
        {findOpen && <FindBar onClose={() => { setFindOpen(false); void api.find(''); }} />}
        <div className="viewport" ref={viewport}>
          {win.snapshots?.map((s, i) => (
            <img key={i} className="snapshot" src={s.dataURL} style={{ left: s.rect.x - (viewport.current?.getBoundingClientRect().left ?? 0), top: s.rect.y - (viewport.current?.getBoundingClientRect().top ?? 0), width: s.rect.width, height: s.rect.height }} alt="" />
          ))}
          {win.peek && (
            <div className="peek-chrome">
              <span className="ellipsis">{win.peek.title || win.peek.url}</span>
              <button onClick={() => api.command({ type: 'peek', op: 'expand' })}>Open as Tab</button>
              <button className="icon-btn" onClick={() => api.command({ type: 'peek', op: 'close' })}>×</button>
            </div>
          )}
          {split && !win.snapshots && <SplitDividers split={split} viewport={viewport} />}
          {selected?.kind === 'note' && <NoteEditor item={selected} />}
          {selected?.kind === 'easel' && <EaselView item={selected} />}
          {kind === 'main' && !selected && !win.snapshots && (
            <div className="empty-content">
              <p>No tab open in {space.title}.</p>
              <button className="primary" onClick={() => openCommandBar('new')}>New Tab <kbd>⌘T</kbd></button>
            </div>
          )}
        </div>
        {(kind === 'little' || win.sidebarHidden) && toastStack}
      </main>

      {overlay?.name === 'commandBar' && <CommandBar state={state} mode={overlay.mode} initial={overlay.initial} onClose={close} onRendererAction={(id) => setTimeout(() => runUiAction(id), 0)} />}
      {overlay?.name === 'library' && <Library state={state} initialTab={overlay.tab} onClose={close} />}
      {overlay?.name === 'settings' && <Settings state={state} initialTab={overlay.tab} onClose={close} onEditBoost={(id) => setOverlay({ name: 'boost', id })} />}
      {overlay?.name === 'editSpace' && <SpaceEditor state={state} spaceId={overlay.id} onClose={close} />}
      {overlay?.name === 'deleteSpace' && (
        <ConfirmDialog
          title={`Delete “${state.spaces.find((s) => s.id === overlay.id)?.title}”?`}
          body="Its tabs and folders move to the Archive."
          confirm="Delete Space"
          onConfirm={() => api.dispatch({ type: 'space.delete', id: overlay.id, now: Date.now() })}
          onClose={close}
        />
      )}
      {overlay?.name === 'spaceManager' && <SpaceManager state={state} onClose={close} onEdit={(id) => setOverlay({ name: 'editSpace', id })} />}
      {overlay?.name === 'boost' && <BoostEditor state={state} boostId={overlay.id} currentUrl={selectedUrl} onClose={close} />}
      {overlay?.name === 'welcome' && <Welcome onClose={close} />}
      {overlay?.name === 'archiveEducation' && <ArchiveEducation onClose={close} onSettings={() => setOverlay({ name: 'settings', tab: 'profiles' })} />}
      {overlay?.name === 'liveFolder' && <LiveFolderDialog folderId={overlay.id} onClose={close} />}
      {overlay?.name === 'capture' && <CaptureOverlay onDone={close} />}
    </div>
  );
}

function LittleBar({ state, url, title, onEdit }: { state: import('../shared/model').State; url: string; title: string; onEdit(): void }) {
  return (
    <div className="little-bar">
      <div className="traffic-spacer" />
      <button className="url-pill grow" onClick={onEdit} title={url}>{title || url || 'Search or enter address'}</button>
      <select value="" onChange={(e) => e.target.value && api.command({ type: 'little', op: 'moveToSpace', spaceId: e.target.value })} title="Move this page into a Space">
        <option value="">Open in…</option>
        {state.spaces.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
      </select>
    </div>
  );
}

function FindBar({ onClose }: { onClose(): void }) {
  const [text, setText] = useState('');
  return (
    <div className="find-bar">
      <input
        autoFocus
        value={text}
        placeholder="Find in page"
        onChange={(e) => { setText(e.target.value); void api.find(e.target.value); }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
          if (e.key === 'Enter') void api.find(text, { forward: !e.shiftKey, findNext: true });
        }}
      />
      <button className="icon-btn" onClick={onClose}>×</button>
    </div>
  );
}

/** Drag handles in the gaps between Split View panes; sizes are saved on the split item. */
function SplitDividers({ split, viewport }: { split: import('../shared/model').Item; viewport: React.RefObject<HTMLDivElement | null> }) {
  const sizes = split.split?.sizes ?? [];
  const row = split.split?.orientation !== 'column';
  const [box, setBox] = useState<DOMRect | null>(null);
  useEffect(() => setBox(viewport.current?.getBoundingClientRect() ?? null), [viewport, split.id, sizes.length]);
  if (!box || sizes.length < 2) return null;
  const total = (row ? box.width : box.height) - SPLIT_GAP * (sizes.length - 1);
  let offset = 0;
  return (
    <>
      {sizes.slice(0, -1).map((s, i) => {
        offset += total * s + (i ? SPLIT_GAP : 0);
        const at = offset + (i ? 0 : 0);
        return (
          <div
            key={i}
            className={`split-divider ${row ? 'col' : 'row'}`}
            style={row ? { left: at + SPLIT_GAP * i, width: SPLIT_GAP } : { top: at + SPLIT_GAP * i, height: SPLIT_GAP }}
            onPointerDown={(e) => {
              (e.target as HTMLElement).setPointerCapture(e.pointerId);
              const start = row ? e.clientX : e.clientY;
              const startSizes = [...sizes];
              let frame = 0;
              const move = (ev: PointerEvent) => {
                // One update per frame while dragging.
                if (frame) return;
                frame = requestAnimationFrame(() => (frame = 0));
                const delta = ((row ? ev.clientX : ev.clientY) - start) / total;
                const a = Math.max(0.1, startSizes[i]! + delta);
                const b = Math.max(0.1, startSizes[i + 1]! - delta);
                const next = [...startSizes];
                next[i] = a;
                next[i + 1] = b;
                api.dispatch({ type: 'split.update', id: split.id, sizes: next });
              };
              const up = () => {
                window.removeEventListener('pointermove', move);
                window.removeEventListener('pointerup', up);
              };
              window.addEventListener('pointermove', move);
              window.addEventListener('pointerup', up);
            }}
          />
        );
      })}
    </>
  );
}

/** Drag a rectangle over the page picture; the area is captured from the live page. */
function CaptureOverlay({ onDone }: { onDone(): void }) {
  const [start, setStart] = useState<[number, number] | null>(null);
  const [end, setEnd] = useState<[number, number] | null>(null);
  const rect = start && end ? { x: Math.min(start[0], end[0]), y: Math.min(start[1], end[1]), width: Math.abs(end[0] - start[0]), height: Math.abs(end[1] - start[1]) } : null;
  return (
    <div
      className="capture-overlay"
      onPointerDown={(e) => { setStart([e.clientX, e.clientY]); setEnd([e.clientX, e.clientY]); }}
      onPointerMove={(e) => start && setEnd([e.clientX, e.clientY])}
      onPointerUp={async () => {
        onDone();
        if (rect && rect.width > 4 && rect.height > 4) {
          await new Promise((r) => setTimeout(r, 120)); // let the live page come back first
          void api.command({ type: 'capture', rect });
        }
      }}
      onKeyDown={(e) => e.key === 'Escape' && onDone()}
      tabIndex={-1}
    >
      <div className="capture-hint">Drag to capture an area · Esc to cancel</div>
      {rect && <div className="capture-rect" style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }} />}
    </div>
  );
}
