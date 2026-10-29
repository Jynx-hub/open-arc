// Window controller: which Space and tab each window shows, how live views are laid out, and every
// command the UI or a shortcut can run.
import { BrowserWindow, ClipboardItem, Menu, WebContentsView, app, clipboard, dialog, shell, type MenuItemConstructorOptions, type WebContents } from 'electron';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Command, ContextTarget, Rect, Snapshot, UiEvents, WindowInfo } from '../shared/ipc';
import { itemTitle, type Item, type State } from '../shared/model';
import type { Action } from '../shared/reducer';
import { isPersistent, rootOf, sectionOf, spaceOf, subtree } from '../shared/tree';
import { KEY_ACTIONS, acceleratorFor } from '../shared/keymap';
import { clearProfileData, sessionFor } from './profiles';
import type { Store } from './store';
import { TabViews } from './tabs';
import { search } from '../shared/search';
import { applyBoosts, exportBoostCss } from './boosts';
import { routeExternalUrl } from '../shared/routing';

const SPLIT_GAP = 6;
const PEEK_INSET = 48;

interface Win {
  win: BrowserWindow;
  kind: 'main' | 'little';
  spaceId: string;
  selectedId: string | null;
  /** The tab selected before the current one (⌃⇥ jumps back to it). */
  previousId: string | null;
  lastSelected: Map<string, string>;
  bounds: Rect;
  sidebarHidden: boolean;
  overlay: boolean;
  snapshots: Snapshot[] | null;
  attached: WebContentsView[];
  peek: { view: WebContentsView; fromItemId: string | null } | null;
  /** Dimmed picture of the page behind an open Peek. */
  peekBackdrop: Snapshot[] | null;
  /** Little Arc: a standalone view that isn't in any Space until moved there. */
  little: WebContentsView | null;
  /** UI actions queued until the window's UI says it is listening. */
  pending: UiEvents['action'][] | null;
  overlaySeq: number;
  peekSeq: number;
}

export class Browser {
  readonly tabs: TabViews;
  private wins = new Map<number, Win>();
  private lastFocused: number | null = null;
  private liveTimer: NodeJS.Timeout | null = null;

  constructor(private store: Store, private rendererURL: string) {
    this.tabs = new TabViews(store, {
      openFrom: (itemId, url, disposition) => this.openFromPage(itemId, url, disposition),
      willNavigate: (itemId, url, wc) => this.maybePeek(itemId, url, wc),
      domReady: (_itemId, wc) => applyBoosts(this.store.state, wc),
      liveChanged: () => this.scheduleLive(),
    });
    store.subscribe((state, prev) => this.onState(state, prev));
  }

  // ── windows ──────────────────────────────────────────────────────────────

  createWindow(opts: { kind?: 'main' | 'little'; spaceId?: string; url?: string } = {}): Win {
    const kind = opts.kind ?? 'main';
    const state = this.store.state;
    const win = new BrowserWindow({
      width: kind === 'little' ? 760 : 1400,
      height: kind === 'little' ? 620 : 900,
      minWidth: 480,
      minHeight: 320,
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 14, y: 14 },
      backgroundColor: '#e9e7f5',
      show: false,
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true },
    });
    const spaceId = opts.spaceId ?? this.focused()?.spaceId ?? state.spaces[0]!.id;
    const w: Win = {
      win, kind, spaceId, selectedId: null, previousId: null, lastSelected: new Map(), bounds: { x: 0, y: 0, width: 0, height: 0 },
      sidebarHidden: false, overlay: false, snapshots: null, attached: [], peek: null, peekBackdrop: null, little: null, pending: [], overlaySeq: 0, peekSeq: 0,
    };
    this.wins.set(win.id, w);
    win.on('focus', () => (this.lastFocused = win.id));
    win.on('closed', () => this.onWindowClosed(w));
    win.once('ready-to-show', () => win.show());
    void win.loadURL(`${this.rendererURL}#${kind}`);

    if (kind === 'little') {
      const view = new WebContentsView({ webPreferences: { session: sessionFor(this.store.state.spaces.find((s) => s.id === spaceId)?.profileId ?? 'default'), sandbox: true } });
      view.setBorderRadius(8);
      w.little = view;
      view.webContents.on('page-title-updated', () => this.pushWindow(w));
      view.webContents.on('did-navigate', () => this.pushWindow(w));
      view.webContents.setWindowOpenHandler(({ url }) => {
        void view.webContents.loadURL(url);
        return { action: 'deny' };
      });
      if (opts.url) void view.webContents.loadURL(opts.url);
      this.layout(w);
    } else {
      this.selectDefaultForSpace(w);
    }
    this.lastFocused = win.id;
    return w;
  }

  focused(): Win | null {
    const id = BrowserWindow.getFocusedWindow()?.id ?? this.lastFocused;
    return (id != null && this.wins.get(id)) || [...this.wins.values()].find((w) => w.kind === 'main') || null;
  }

  winFor(sender: WebContents): Win | null {
    for (const w of this.wins.values()) if (w.win.webContents === sender) return w;
    return null;
  }

  windowInfo(w: Win): WindowInfo {
    const peekWc = w.peek?.view.webContents;
    const littleWc = w.little?.webContents;
    const selectedView = w.selectedId ? this.tabs.get(w.selectedId) : null;
    return {
      id: w.win.id,
      kind: w.kind,
      spaceId: w.spaceId,
      selectedId: w.selectedId,
      sidebarHidden: w.sidebarHidden,
      snapshots: w.snapshots ?? w.peekBackdrop,
      peek: peekWc ? { url: peekWc.getURL(), title: peekWc.getTitle() } : null,
      little: littleWc ? { url: littleWc.getURL(), title: littleWc.getTitle() } : null,
      zoom: selectedView ? selectedView.webContents.getZoomFactor() : 1,
    };
  }

  setContentBounds(w: Win, rect: Rect) {
    w.bounds = rect;
    this.layout(w);
  }

  private onWindowClosed(w: Win) {
    this.wins.delete(w.win.id);
    for (const v of w.attached) this.detach(w, v);
    if (w.little && !w.little.webContents.isDestroyed()) {
      const wc = w.little.webContents;
      if (wc.getURL()) this.archiveLittle(wc.getURL(), wc.getTitle());
      wc.close();
    }
    if (w.peek) w.peek.view.webContents.close();
  }

  /** Closed Little Arc pages land in the Archive with source "littleArc". */
  private archiveLittle(url: string, title: string) {
    const now = Date.now();
    const id = randomUUID();
    this.store.dispatch({
      type: 'state.replace',
      state: {
        ...this.store.state,
        archive: [
          { id: `${id}@${now}`, archivedAt: now, reason: 'manual', source: { kind: 'littleArc' }, items: [{ id, parentId: null, children: [], title: null, createdAt: now, kind: 'tab', tab: { savedURL: url, savedTitle: title, lastActiveAt: now } }] },
          ...this.store.state.archive,
        ],
      },
    });
  }

  // ── selection & layout ───────────────────────────────────────────────────

  /** Items shown in the content area for the current selection (all panes of a Split View). */
  private visibleIds(w: Win): string[] {
    const state = this.store.state;
    const sel = w.selectedId ? state.items[w.selectedId] : null;
    if (!sel) return [];
    const parent = sel.parentId ? state.items[sel.parentId] : null;
    if (parent?.kind === 'split') return parent.children;
    if (sel.kind === 'split') return sel.children;
    return sel.kind === 'tab' ? [sel.id] : [];
  }

  select(w: Win, id: string | null, { focus = true } = {}) {
    const state = this.store.state;
    let item = id ? state.items[id] : null;
    if (item?.kind === 'split') item = state.items[item.children[0] ?? ''] ?? null;
    if (item?.kind === 'folder' || item?.kind === 'group' || item?.kind === 'root') return;
    // Selecting a tab in another Space switches this window to that Space.
    const space = item ? spaceOf(state, item.id) : null;
    if (space && space.id !== w.spaceId) w.spaceId = space.id;
    const left = w.selectedId && w.selectedId !== item?.id ? w.selectedId : null;
    if (left) w.previousId = left;
    // Update the selection before dispatching: store listeners lay out this window right away.
    w.selectedId = item?.id ?? null;
    // Idle time counts from when the user left an item, not when they arrived.
    if (left && state.items[left]) this.store.dispatch({ type: 'tab.touch', id: left, now: Date.now() });
    if (item) {
      w.lastSelected.set(w.spaceId, item.id);
      this.store.dispatch({ type: 'tab.touch', id: item.id, now: Date.now() });
      if (item.kind === 'tab') {
        this.tabs.ensure(item.id);
        this.store.dispatch({ type: 'ranking.pick', query: '', key: `tab:${item.id}`, now: Date.now() });
      }
      if (item.isUnread) this.store.dispatch({ type: 'item.markRead', id: item.id });
    }
    this.closePeek(w);
    this.layout(w);
    this.pushWindow(w);
    if (focus && item?.kind === 'tab') this.tabs.get(item.id)?.webContents.focus();
  }

  private selectDefaultForSpace(w: Win) {
    const state = this.store.state;
    const space = state.spaces.find((s) => s.id === w.spaceId);
    if (!space) return;
    const remembered = w.lastSelected.get(space.id);
    const candidate =
      (remembered && state.items[remembered] && spaceOf(state, remembered)?.id === space.id ? remembered : null) ??
      firstTab(state, space.todayRootId) ??
      firstTab(state, space.pinnedRootId);
    w.selectedId = null;
    if (candidate) this.select(w, candidate, { focus: false });
    else {
      this.layout(w);
      this.pushWindow(w);
    }
  }

  switchSpace(w: Win, spaceId: string) {
    if (!this.store.state.spaces.some((s) => s.id === spaceId) || w.spaceId === spaceId) return;
    w.spaceId = spaceId;
    this.selectDefaultForSpace(w);
  }

  private layout(w: Win) {
    if (w.win.isDestroyed()) return;
    const want: WebContentsView[] = [];
    const rects: Rect[] = [];
    const b = w.bounds;
    if (w.little) {
      want.push(w.little);
      rects.push(b);
    } else if (!w.overlay && !w.peek) {
      const ids = this.visibleIds(w);
      const state = this.store.state;
      const sel = w.selectedId ? state.items[w.selectedId] : null;
      const split = sel?.parentId && state.items[sel.parentId]?.kind === 'split' ? state.items[sel.parentId]! : null;
      const sizes = split?.split?.sizes ?? [1];
      const row = (split?.split?.orientation ?? 'row') === 'row';
      const total = (row ? b.width : b.height) - SPLIT_GAP * Math.max(0, ids.length - 1);
      let offset = 0;
      ids.forEach((id, i) => {
        const view = this.tabs.ensure(id);
        if (!view) return;
        const size = Math.round(total * (sizes[i] ?? 1 / ids.length));
        const r = row ? { x: b.x + offset, y: b.y, width: size, height: b.height } : { x: b.x, y: b.y + offset, width: b.width, height: size };
        offset += size + SPLIT_GAP;
        want.push(view);
        rects.push(r);
      });
    }
    for (const v of w.attached) if (!want.includes(v)) this.detach(w, v);
    want.forEach((v, i) => {
      if (!w.attached.includes(v)) {
        // A view lives in one window at a time; take it from whichever window has it.
        for (const other of this.wins.values()) if (other !== w && other.attached.includes(v)) this.detach(other, v);
        w.win.contentView.addChildView(v);
        w.attached.push(v);
      }
      v.setBounds(rects[i]!);
    });
    if (w.peek && !w.overlay) {
      w.win.contentView.addChildView(w.peek.view); // re-adding raises it above the page
      w.peek.view.setBounds({ x: b.x + PEEK_INSET, y: b.y + PEEK_INSET, width: Math.max(200, b.width - PEEK_INSET * 2), height: Math.max(200, b.height - PEEK_INSET - 16) });
    }
  }

  private detach(w: Win, v: WebContentsView) {
    if (!w.win.isDestroyed()) w.win.contentView.removeChildView(v);
    w.attached = w.attached.filter((x) => x !== v);
  }

  /** While the Command Bar or a sheet is open, show still pictures of the page so the UI can sit on top. */
  async setOverlay(w: Win, open: boolean) {
    // The latest request wins: a close that arrives while an open is still capturing cancels it.
    const seq = ++w.overlaySeq;
    if (open === w.overlay) return;
    if (open) {
      const views = [...w.attached, ...(w.peek ? [w.peek.view] : [])];
      const snapshots = await Promise.all(
        views.map(async (v) => ({ rect: v.getBounds(), dataURL: (await v.webContents.capturePage()).toDataURL() })),
      ).catch(() => []);
      if (seq !== w.overlaySeq || w.win.isDestroyed()) return;
      w.snapshots = snapshots;
      w.overlay = true;
      if (w.peek) w.win.contentView.removeChildView(w.peek.view);
      if (w.peekBackdrop) w.snapshots = [...w.peekBackdrop, ...w.snapshots];
    } else {
      w.overlay = false;
      w.snapshots = null;
    }
    this.layout(w);
    this.pushWindow(w);
    if (!open && w.selectedId) this.tabs.get(w.selectedId)?.webContents.focus();
  }

  // ── tabs ─────────────────────────────────────────────────────────────────

  private currentSpace(w: Win) {
    return this.store.state.spaces.find((s) => s.id === w.spaceId) ?? this.store.state.spaces[0]!;
  }

  newTab(w: Win, url: string, parentId?: string, index = 0): string {
    const id = randomUUID();
    this.store.dispatch({ type: 'tab.create', id, parentId: parentId ?? this.currentSpace(w).todayRootId, index, url, title: '', now: Date.now() });
    this.select(w, id);
    return id;
  }

  open(w: Win, url: string, where: Command & { type: 'open' } extends { where: infer W } ? W : never, parentId?: string) {
    switch (where) {
      case 'current': {
        const view = w.selectedId ? this.tabs.get(w.selectedId) : null;
        if (view) void view.webContents.loadURL(url);
        else if (w.little) void w.little.webContents.loadURL(url);
        else this.newTab(w, url, parentId);
        return;
      }
      case 'split':
        if (w.selectedId) this.splitWith(w, w.selectedId, { url });
        else this.newTab(w, url, parentId);
        return;
      case 'peek':
        void this.openPeek(w, url, w.selectedId);
        return;
      case 'littleArc':
        this.createWindow({ kind: 'little', url });
        return;
      default:
        this.newTab(w, url, parentId);
    }
  }

  /** Close: pinned tabs and Favorites unload but stay; Today tabs go to the Archive. */
  close(w: Win, id: string) {
    const state = this.store.state;
    const item = state.items[id];
    if (!item) return;
    const next = w.selectedId && (id === w.selectedId || subtree(state, id).some((i) => i.id === w.selectedId)) ? this.neighbor(w, id) : undefined;
    if (isPersistent(state, id)) {
      for (const t of subtree(state, id)) this.tabs.unload(t.id);
    } else {
      this.store.dispatch({ type: 'item.archive', ids: [id], reason: 'manual', now: Date.now() });
    }
    if (next !== undefined) this.select(w, next);
    else {
      this.layout(w);
      this.pushWindow(w);
    }
  }

  /** The tab to select after `id` goes away: the next one below it in the sidebar, else the one above. */
  private neighbor(w: Win, id: string): string | null {
    const order = this.sidebarOrder(w).filter((x) => x === id || !isAncestorOrSelf(this.store.state, id, x));
    const i = order.indexOf(id);
    if (i < 0) return order[0] ?? null;
    return order[i + 1] ?? order[i - 1] ?? null;
  }

  /** Tabs in visual order: Favorites, Pinned, Today. */
  sidebarOrder(w: Win): string[] {
    const state = this.store.state;
    const space = this.currentSpace(w);
    const fav = state.favorites[space.profileId];
    return [fav, space.pinnedRootId, space.todayRootId]
      .filter((x): x is string => !!x)
      .flatMap((root) => subtree(state, root).filter((i) => i.kind === 'tab' || i.kind === 'note' || i.kind === 'easel').map((i) => i.id));
  }

  togglePin(w: Win, id: string) {
    const state = this.store.state;
    const space = spaceOf(state, id) ?? this.currentSpace(w);
    const section = sectionOf(state, id);
    if (section === 'today') {
      this.store.dispatch({ type: 'item.move', id, parentId: space.pinnedRootId, index: Infinity });
      this.toast(w, 'Pinned');
    } else {
      this.store.dispatch({ type: 'item.move', id, parentId: space.todayRootId, index: 0 });
      this.toast(w, 'Moved to Today');
    }
  }

  goHome(id: string) {
    const item = this.store.state.items[id];
    const view = this.tabs.get(id);
    if (item?.tab && view) void view.webContents.loadURL(item.tab.savedURL);
  }

  setHomeToCurrent(id: string) {
    const live = this.tabs.live.get(id);
    if (live) this.store.dispatch({ type: 'tab.setHome', id, url: live.url, title: live.title });
  }

  splitWith(w: Win, id: string, opts: { url?: string; withId?: string; side?: 'before' | 'after' }) {
    const state = this.store.state;
    const item = state.items[id];
    if (!item || item.kind !== 'tab' || !item.parentId) return;
    const parent = state.items[item.parentId]!;
    let otherId = opts.withId;
    if (!otherId) {
      otherId = randomUUID();
      this.store.dispatch({ type: 'tab.create', id: otherId, parentId: item.parentId, url: opts.url ?? 'about:blank', now: Date.now() });
    }
    if (parent.kind === 'split') {
      const at = parent.children.indexOf(id) + (opts.side === 'before' ? 0 : 1);
      this.store.dispatch({ type: 'item.move', id: otherId, parentId: parent.id, index: at });
    } else {
      const ids = opts.side === 'before' ? [otherId, id] : [id, otherId];
      this.store.dispatch({ type: 'split.create', id: randomUUID(), parentId: item.parentId, childIds: ids, orientation: 'row', now: Date.now() });
    }
    this.select(w, otherId);
  }

  // ── Peek ─────────────────────────────────────────────────────────────────

  /** Links to a different site from a pinned tab or Favorite open in Peek (spec: little-arc-and-peek.md). */
  private maybePeek(itemId: string, url: string, wc: WebContents): boolean {
    const s = this.store.state.settings;
    if (!s.peekFromPinned || !isPersistent(this.store.state, itemId)) return false;
    if (sameSite(wc.getURL(), url)) return false;
    const w = [...this.wins.values()].find((x) => x.attached.some((v) => v.webContents === wc));
    if (!w) return false;
    void this.openPeek(w, url, itemId);
    return true;
  }

  async openPeek(w: Win, url: string, fromItemId: string | null) {
    this.closePeek(w);
    const seq = ++w.peekSeq;
    const backdrop = await Promise.all(w.attached.map(async (v) => ({ rect: v.getBounds(), dataURL: (await v.webContents.capturePage()).toDataURL() }))).catch(() => []);
    // A newer Peek request (or the window closing) supersedes this one.
    if (seq !== w.peekSeq || w.win.isDestroyed()) return;
    w.peekBackdrop = backdrop;
    const profileId = this.currentSpace(w).profileId;
    const view = new WebContentsView({ webPreferences: { session: sessionFor(profileId), sandbox: true } });
    view.setBorderRadius(10);
    view.webContents.on('page-title-updated', () => this.pushWindow(w));
    view.webContents.setWindowOpenHandler(({ url: u }) => {
      void view.webContents.loadURL(u);
      return { action: 'deny' };
    });
    view.webContents.on('before-input-event', (e, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape') {
        e.preventDefault();
        this.closePeek(w);
      }
    });
    w.peek = { view, fromItemId };
    void view.webContents.loadURL(url);
    this.layout(w);
    this.pushWindow(w);
    view.webContents.focus();
  }

  closePeek(w: Win) {
    w.peekSeq += 1;
    if (!w.peek) return;
    const { view } = w.peek;
    w.peek = null;
    w.peekBackdrop = null;
    this.layout(w);
    if (!w.win.isDestroyed()) w.win.contentView.removeChildView(view);
    view.webContents.close();
    this.pushWindow(w);
  }

  expandPeek(w: Win) {
    const url = w.peek?.view.webContents.getURL();
    this.closePeek(w);
    if (url) this.newTab(w, url);
  }

  // ── pages asking for new tabs ────────────────────────────────────────────

  private openFromPage(itemId: string, url: string, disposition: string) {
    const w = [...this.wins.values()].find((x) => x.attached.some((v) => v === this.tabs.get(itemId))) ?? this.focused();
    if (!w) return;
    const state = this.store.state;
    const space = spaceOf(state, itemId) ?? this.currentSpace(w);
    if (disposition === 'new-window') {
      const nw = this.createWindow({ spaceId: space.id });
      this.newTab(nw, url);
      return;
    }
    // New tabs from a page open in Today, at the top. Background dispositions don't steal focus.
    const id = randomUUID();
    this.store.dispatch({ type: 'tab.create', id, parentId: space.todayRootId, index: 0, url, now: Date.now() });
    if (disposition !== 'background-tab') this.select(w, id);
    else this.tabs.ensure(id);
  }

  /** A URL from another app (default-browser handling), routed by the link rules. */
  openExternal(url: string) {
    const dest = routeExternalUrl(this.store.state, url);
    if (dest.kind === 'littleArc') {
      this.createWindow({ kind: 'little', url, spaceId: this.focused()?.spaceId });
      return;
    }
    let w = this.focused();
    if (!w || w.kind !== 'main') w = this.createWindow();
    if (dest.kind === 'space') this.switchSpace(w, dest.spaceId);
    this.newTab(w, url);
    w.win.show();
    w.win.focus();
  }

  littleToSpace(w: Win, spaceId: string) {
    const url = w.little?.webContents.getURL();
    if (!url) return;
    let target = [...this.wins.values()].find((x) => x.kind === 'main');
    if (!target) target = this.createWindow({ spaceId });
    this.switchSpace(target, spaceId);
    this.newTab(target, url);
    w.little?.webContents.close();
    w.little = null;
    w.win.close();
    target.win.focus();
  }

  // ── commands ─────────────────────────────────────────────────────────────

  async command(w: Win, c: Command): Promise<unknown> {
    switch (c.type) {
      case 'ready': {
        const queued = w.pending ?? [];
        w.pending = null;
        for (const a of queued) this.sendUi(w, 'action', a);
        return;
      }
      case 'select': return this.select(w, c.id);
      case 'switchSpace': return this.switchSpace(w, c.spaceId);
      case 'open': return this.open(w, c.url, c.where, c.parentId);
      case 'navigate': {
        const wc = this.activeContents(w);
        if (!wc) return;
        if (c.op === 'back') wc.navigationHistory.goBack();
        else if (c.op === 'forward') wc.navigationHistory.goForward();
        else if (c.op === 'reload') wc.reload();
        else wc.stop();
        return;
      }
      case 'close': return this.close(w, c.id);
      case 'unload': {
        const next = w.selectedId === c.id ? this.neighbor(w, c.id) : undefined;
        this.tabs.unload(c.id);
        if (next !== undefined) this.select(w, next);
        return;
      }
      case 'goHome': return this.goHome(c.id);
      case 'setHomeToCurrent': return this.setHomeToCurrent(c.id);
      case 'overlay': return this.setOverlay(w, c.open);
      case 'contextMenu': return this.contextMenu(w, c.target);
      case 'runAction': return this.runAction(w, c.id);
      case 'search': return search(this.store.state, this.tabs.live, c.query, w.spaceId);
      case 'pickResult': return this.store.dispatch({ type: 'ranking.pick', query: c.query, key: c.key, now: Date.now() });
      case 'importArc': return this.importArc(w, c.dir);
      case 'peek': return c.op === 'close' ? this.closePeek(w) : this.expandPeek(w);
      case 'little': return this.littleToSpace(w, c.spaceId);
      case 'splitWith': return this.splitWith(w, c.id, c);
      case 'capture': return this.capture(w, c.rect);
      case 'exportBoost': return this.exportBoost(c.id);
      case 'setDefaultBrowser': {
        const ok = app.setAsDefaultProtocolClient('http') && app.setAsDefaultProtocolClient('https');
        this.toast(w, ok ? 'Set as the default browser' : 'Could not set the default browser');
        return ok;
      }
      case 'liveFolderRefresh': {
        const { refreshLiveFolder } = await import('./liveFolders');
        return refreshLiveFolder(this.store, c.id);
      }
    }
  }

  private activeContents(w: Win): WebContents | null {
    if (w.peek) return w.peek.view.webContents;
    if (w.little) return w.little.webContents;
    return w.selectedId ? this.tabs.get(w.selectedId)?.webContents ?? null : null;
  }

  /** Menu and shortcut actions. Those that need UI are forwarded to the window's sidebar. */
  runAction(w: Win | null, id: string) {
    if (!w) {
      if (id === 'newWindow' || id === 'commandBar') this.createWindow();
      if (id === 'littleArc') this.createWindow({ kind: 'little' });
      return;
    }
    const state = this.store.state;
    const wc = this.activeContents(w);
    const sel = w.selectedId;
    const space = this.currentSpace(w);
    const m = /^(space|tab|pane)(\d)$/.exec(id);
    if (m) {
      const n = Number(m[2]) - 1;
      if (m[1] === 'pane') {
        const target = this.visibleIds(w)[n];
        if (target) this.select(w, target);
      } else if (m[1] === 'space') {
        const target = state.spaces[n];
        if (target) this.switchSpace(w, target.id);
      } else {
        const order = this.sidebarOrder(w);
        const target = n === 8 ? order[order.length - 1] : order[n];
        if (target) this.select(w, target);
      }
      return;
    }
    switch (id) {
      case 'newWindow': return void this.createWindow();
      case 'newBlankWindow': {
        const nw = this.createWindow();
        nw.selectedId = null;
        return this.layout(nw);
      }
      case 'recentTab':
        if (w.previousId && state.items[w.previousId]) this.select(w, w.previousId);
        return;
      case 'duplicate': {
        const item = sel ? state.items[sel] : null;
        if (!item?.tab || !item.parentId) return;
        const url = this.tabs.live.get(item.id)?.url ?? item.tab.savedURL;
        this.newTab(w, url, item.parentId, state.items[item.parentId]!.children.indexOf(item.id) + 1);
        return;
      }
      case 'splitClosePane': {
        const split = sel ? state.items[state.items[sel]?.parentId ?? ''] : null;
        if (split?.kind === 'split' && sel) {
          this.store.dispatch({ type: 'split.separate', id: split.id, childId: sel });
          this.close(w, sel);
        }
        return;
      }
      case 'undoClear': {
        const latest = state.archive.find((e) => e.reason === 'clearButton');
        if (!latest) return;
        for (const e of state.archive.filter((x) => x.reason === 'clearButton' && x.archivedAt === latest.archivedAt)) {
          this.store.dispatch({ type: 'archive.restore', entryId: e.id });
        }
        return;
      }
      case 'littleArc': return void this.createWindow({ kind: 'little' });
      case 'closeTab':
        if (w.peek) return this.closePeek(w);
        if (w.kind === 'little') return w.win.close();
        if (sel) return this.close(w, sel);
        return w.win.close();
      case 'reopenClosed': {
        const entry = state.archive.find((e) => e.source.kind !== 'space' || e.source.spaceId === space.id) ?? state.archive[0];
        if (!entry) return;
        const rootId = entry.items[0]!.id;
        this.store.dispatch({ type: 'archive.restore', entryId: entry.id });
        return this.select(w, rootId);
      }
      case 'copyURL':
      case 'copyMarkdownLink': {
        if (!wc) return;
        const url = wc.getURL();
        clipboard.writeText(id === 'copyURL' ? url : `[${wc.getTitle() || url}](${url})`);
        return this.toast(w, id === 'copyURL' ? 'Address copied' : 'Markdown link copied');
      }
      case 'reload': return wc?.reload();
      case 'back': return wc?.navigationHistory.goBack();
      case 'forward': return wc?.navigationHistory.goForward();
      case 'zoomIn':
      case 'zoomOut':
      case 'zoomReset': {
        if (!wc) return;
        const z = wc.getZoomFactor();
        wc.setZoomFactor(id === 'zoomReset' ? 1 : Math.min(5, Math.max(0.25, z + (id === 'zoomIn' ? 0.1 : -0.1))));
        return this.pushWindow(w);
      }
      case 'devTools': return wc?.toggleDevTools();
      case 'toggleSidebar':
        w.sidebarHidden = !w.sidebarHidden;
        return this.pushWindow(w);
      case 'nextSpace':
      case 'prevSpace': {
        const i = state.spaces.findIndex((s) => s.id === w.spaceId);
        const next = state.spaces[(i + (id === 'nextSpace' ? 1 : -1) + state.spaces.length) % state.spaces.length];
        if (next) this.switchSpace(w, next.id);
        return;
      }
      case 'nextTab':
      case 'prevTab': {
        const order = this.sidebarOrder(w);
        const i = sel ? order.indexOf(sel) : -1;
        const next = order[(i + (id === 'nextTab' ? 1 : -1) + order.length) % order.length];
        if (next) this.select(w, next);
        return;
      }
      case 'togglePin': return sel ? this.togglePin(w, sel) : undefined;
      case 'resetPinned': return sel ? this.goHome(sel) : undefined;
      case 'clearToday': return this.clearToday(w);
      case 'newFolder': {
        const fid = randomUUID();
        this.store.dispatch({ type: 'folder.create', id: fid, parentId: space.pinnedRootId, index: Infinity, now: Date.now() });
        return this.sendUi(w, 'action', { id: 'rename', arg: fid });
      }
      case 'newNote':
      case 'newEasel': {
        const nid = randomUUID();
        this.store.dispatch({ type: id === 'newNote' ? 'note.create' : 'easel.create', id: nid, parentId: space.todayRootId, index: 0, now: Date.now() });
        return this.select(w, nid);
      }
      case 'splitAdd':
        if (sel && state.items[sel]?.kind === 'tab') return this.sendUi(w, 'action', { id: 'commandBar', arg: 'split' });
        return;
      case 'splitFlip': {
        const split = sel ? state.items[state.items[sel]?.parentId ?? ''] : null;
        if (split?.split) this.store.dispatch({ type: 'split.update', id: split.id, orientation: split.split.orientation === 'row' ? 'column' : 'row' });
        return this.layout(w);
      }
      case 'splitSeparate': {
        const split = sel ? state.items[state.items[sel]?.parentId ?? ''] : null;
        if (split?.kind === 'split') this.store.dispatch({ type: 'split.separate', id: split.id });
        return this.layout(w);
      }
      case 'importArc': return void this.importArc(w);
      case 'setDefaultBrowser': return void this.command(w, { type: 'setDefaultBrowser' });
      case 'capture': return this.sendUi(w, 'action', { id: 'capture' });
      case 'find': return this.sendUi(w, 'action', { id: 'find' });
      default:
        // commandBar, focusURL, library, newSpace, spaceManager, boost, linkRules, settings
        return this.sendUi(w, 'action', { id });
    }
  }

  clearToday(w: Win) {
    const space = this.currentSpace(w);
    const before = this.store.state.items[space.todayRootId]?.children.length ?? 0;
    this.store.dispatch({ type: 'space.clearToday', spaceId: space.id, keepIds: [], now: Date.now() });
    if (w.selectedId && !this.store.state.items[w.selectedId]) this.selectDefaultForSpace(w);
    if (before) this.toast(w, `Archived ${before} ${before === 1 ? 'item' : 'items'}`, 'Undo', { type: 'runAction', id: 'undoClear' });
  }

  find(w: Win, text: string, opts: { forward?: boolean; findNext?: boolean } = {}) {
    const wc = this.activeContents(w);
    if (!wc) return;
    if (!text) wc.stopFindInPage('clearSelection');
    else wc.findInPage(text, opts);
  }

  private async capture(w: Win, rect?: Rect) {
    const wc = this.activeContents(w);
    const view = w.selectedId ? this.tabs.get(w.selectedId) : null;
    if (!wc || !view) return null;
    const vb = view.getBounds();
    const local = rect ? { x: rect.x - vb.x, y: rect.y - vb.y, width: rect.width, height: rect.height } : undefined;
    const image = await wc.capturePage(local);
    await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(image.toPNG())], { type: 'image/png' }) })]);
    const { downloadsCapture } = await import('./library');
    const file = downloadsCapture(image.toPNG());
    this.toast(w, 'Capture copied and saved to the Library');
    return file;
  }

  private async exportBoost(id: string) {
    const boost = this.store.state.boosts.find((b) => b.id === id);
    if (!boost) return;
    const res = await dialog.showSaveDialog({ defaultPath: `${boost.name || boost.host}.user.css` });
    if (res.filePath) {
      const fs = await import('node:fs');
      fs.writeFileSync(res.filePath, exportBoostCss(boost));
    }
  }

  private async importArc(w: Win, dir?: string) {
    const { importFromArc } = await import('./importer');
    const summary = await importFromArc(this.store, dir);
    if (summary) {
      w.lastSelected.clear();
      w.spaceId = this.store.state.spaces[0]!.id;
      this.selectDefaultForSpace(w);
      this.toast(w, `Imported ${summary.spaces} Spaces, ${summary.tabs} tabs and ${summary.favorites} Favorites`);
    }
    return summary;
  }

  // ── context menus ────────────────────────────────────────────────────────

  private contextMenu(w: Win, target: ContextTarget) {
    const state = this.store.state;
    const d = (a: Action) => () => this.store.dispatch(a);
    const ui = (id: string, arg?: string) => () => this.sendUi(w, 'action', { id, arg });
    const now = () => Date.now();
    let template: MenuItemConstructorOptions[] = [];

    if (target.kind === 'item') {
      const item = state.items[target.id];
      if (!item) return;
      const section = sectionOf(state, item.id);
      const space = spaceOf(state, item.id) ?? this.currentSpace(w);
      const loaded = this.tabs.has(item.id);
      const otherSpaces = state.spaces.filter((s) => s.id !== space.id);
      const moveTo: MenuItemConstructorOptions = {
        label: 'Move to Space',
        enabled: otherSpaces.length > 0,
        submenu: otherSpaces.map((s) => ({ label: s.title, click: d({ type: 'item.move', id: item.id, parentId: s.todayRootId, index: 0 }) })),
      };
      if (item.kind === 'tab') {
        const live = this.tabs.live.get(item.id);
        template = [
          { label: 'Open in New Window', click: () => this.select(this.createWindow({ spaceId: space.id }), item.id) },
          { label: 'Show Side by Side', enabled: !!w.selectedId && w.selectedId !== item.id, click: () => w.selectedId && this.splitWith(w, w.selectedId, { withId: item.id }) },
          { type: 'separator' },
          { label: 'Rename…', click: ui('rename', item.id) },
          { label: 'Copy Address', click: () => clipboard.writeText(live?.url ?? item.tab!.savedURL) },
          { label: 'Duplicate', click: () => this.newTab(w, live?.url ?? item.tab!.savedURL, item.parentId ?? undefined, (state.items[item.parentId!]?.children.indexOf(item.id) ?? 0) + 1) },
          { type: 'separator' },
          section === 'favorites'
            ? { label: 'Remove from Favorites', click: d({ type: 'item.move', id: item.id, parentId: space.pinnedRootId, index: Infinity }) }
            : { label: 'Add to Favorites', click: d({ type: 'item.move', id: item.id, parentId: state.favorites[space.profileId]!, index: Infinity }) },
          section === 'today'
            ? { label: 'Pin', click: () => this.togglePin(w, item.id) }
            : { label: 'Move to Today', enabled: section === 'pinned', click: () => this.togglePin(w, item.id) },
          ...(section !== 'today'
            ? ([
                { label: 'Go to Home URL', enabled: loaded, click: () => this.goHome(item.id) },
                { label: 'Make Current Page the Home URL', enabled: !!live && live.url !== item.tab!.savedURL, click: () => this.setHomeToCurrent(item.id) },
              ] as MenuItemConstructorOptions[])
            : []),
          moveTo,
          { label: 'New Folder with Tab', enabled: section !== 'favorites', click: () => this.store.dispatch({ type: 'folder.create', id: randomUUID(), parentId: item.parentId!, childIds: [item.id], now: now() }) },
          { type: 'separator' },
          ...(section !== 'today' ? ([{ label: 'Unload', enabled: loaded, click: () => this.command(w, { type: 'unload', id: item.id }) }] as MenuItemConstructorOptions[]) : []),
          { label: 'Archive Everything Below', enabled: section === 'today', click: () => this.archiveRelative(item.id, 'below') },
          { label: 'Archive Everything Above', enabled: section === 'today', click: () => this.archiveRelative(item.id, 'above') },
          { label: 'Archive All but This', enabled: section === 'today', click: () => this.archiveRelative(item.id, 'others') },
          { label: section === 'today' ? 'Archive' : 'Delete', click: () => (section === 'today' ? this.close(w, item.id) : this.deleteItem(w, item.id)) },
        ];
      } else if (item.kind === 'split') {
        template = [
          { label: 'Rename…', click: ui('rename', item.id) },
          { label: 'Flip Layout', click: d({ type: 'split.update', id: item.id, orientation: item.split?.orientation === 'row' ? 'column' : 'row' }) },
          { label: 'Separate All', click: d({ type: 'split.separate', id: item.id }) },
          moveTo,
          { type: 'separator' },
          { label: 'Archive', click: () => this.close(w, item.id) },
        ];
      } else {
        // folder, group, note, easel
        const isFolder = item.kind === 'folder';
        template = [
          { label: 'Rename…', click: ui('rename', item.id) },
          ...(isFolder
            ? ([
                { label: 'New Folder Inside', click: d({ type: 'folder.create', id: randomUUID(), parentId: item.id, index: 0, now: now() }) },
                { label: 'Turn into Space', click: () => this.store.dispatch({ type: 'folder.toSpace', id: item.id, spaceId: randomUUID(), pinnedRootId: randomUUID(), todayRootId: randomUUID(), now: now() }) },
                { label: item.live ? 'Refresh Live Folder' : 'Make Live Folder…', click: item.live ? () => this.command(w, { type: 'liveFolderRefresh', id: item.id }) : ui('liveFolder', item.id) },
              ] as MenuItemConstructorOptions[])
            : []),
          ...(item.kind === 'group' ? ([{ label: 'Clear Group', click: d({ type: 'item.archive', ids: [...item.children], reason: 'clearTabGroup', now: now() }) }] as MenuItemConstructorOptions[]) : []),
          moveTo,
          { type: 'separator' },
          { label: section === 'today' ? 'Archive' : 'Delete', click: () => (section === 'today' ? this.close(w, item.id) : this.deleteItem(w, item.id)) },
        ];
      }
    } else if (target.kind === 'space') {
      const space = state.spaces.find((s) => s.id === target.id);
      if (!space) return;
      const others = state.spaces.filter((s) => s.id !== space.id);
      template = [
        { label: 'Edit Space…', click: ui('editSpace', space.id) },
        { label: 'New Folder', click: d({ type: 'folder.create', id: randomUUID(), parentId: space.pinnedRootId, index: Infinity, now: now() }) },
        { label: 'Profile', submenu: state.profiles.map((p) => ({ label: p.name, type: 'radio', checked: p.id === space.profileId, click: d({ type: 'space.update', id: space.id, patch: { profileId: p.id } }) })) },
        { label: 'Turn into Folder in', enabled: others.length > 0, submenu: others.map((o) => ({ label: o.title, click: d({ type: 'space.toFolder', id: space.id, targetSpaceId: o.id, folderId: randomUUID(), now: now() }) })) },
        { type: 'separator' },
        { label: 'Delete Space…', enabled: state.spaces.length > 1, click: ui('deleteSpace', space.id) },
      ];
    } else if (target.kind === 'section') {
      const space = state.spaces.find((s) => s.id === target.spaceId);
      if (!space) return;
      template =
        target.section === 'pinned'
          ? [
              { label: 'New Folder', click: d({ type: 'folder.create', id: randomUUID(), parentId: space.pinnedRootId, index: Infinity, now: now() }) },
              { label: 'Go Home in All Pinned Tabs', click: () => subtree(state, space.pinnedRootId).forEach((i) => i.tab && this.goHome(i.id)) },
              { label: space.pinnedCollapsed ? 'Expand' : 'Collapse', click: d({ type: 'space.update', id: space.id, patch: { pinnedCollapsed: !space.pinnedCollapsed } }) },
            ]
          : [
              { label: 'New Tab', click: ui('commandBar') },
              { label: 'Archive All Today Tabs', click: () => this.clearToday(w) },
              { label: 'Archive Unselected Today Tabs', click: () => this.store.dispatch({ type: 'space.clearToday', spaceId: space.id, keepIds: w.selectedId ? [w.selectedId] : [], now: now() }) },
            ];
    } else {
      template = [{ label: 'Add Current Tab', enabled: !!w.selectedId, click: () => w.selectedId && this.store.dispatch({ type: 'item.move', id: w.selectedId, parentId: state.favorites[this.currentSpace(w).profileId]!, index: Infinity }) }];
    }
    Menu.buildFromTemplate(template).popup({ window: w.win });
  }

  /** Delete a pinned item or folder. Deleting a folder archives the tabs inside it (spec). */
  deleteItem(w: Win, id: string) {
    const state = this.store.state;
    const next = w.selectedId && subtree(state, id).some((i) => i.id === w.selectedId) ? this.neighbor(w, id) : undefined;
    this.store.dispatch({ type: 'item.archive', ids: [id], reason: 'manual', now: Date.now() });
    if (next !== undefined) this.select(w, next);
  }

  private archiveRelative(id: string, which: 'above' | 'below' | 'others') {
    const state = this.store.state;
    const parent = state.items[state.items[id]?.parentId ?? ''];
    if (!parent) return;
    const i = parent.children.indexOf(id);
    const ids = parent.children.filter((_, j) => (which === 'above' ? j < i : which === 'below' ? j > i : j !== i));
    this.store.dispatch({ type: 'item.archive', ids, reason: 'manual', now: Date.now() });
  }

  // ── app menu ─────────────────────────────────────────────────────────────

  buildMenu() {
    const overrides = this.store.state.settings.keyOverrides;
    const groups = ['File', 'Edit', 'View', 'Spaces', 'Tabs', 'Window'] as const;
    const item = (id: string, label: string): MenuItemConstructorOptions => ({
      label,
      accelerator: acceleratorFor(id, overrides) ?? undefined,
      click: () => this.runAction(this.focused(), id),
    });
    const template: MenuItemConstructorOptions[] = [
      { role: 'appMenu' },
      ...groups.map((g) => {
        const actions = KEY_ACTIONS.filter((a) => a.menu === g).map((a) => item(a.id, a.label));
        const extra: MenuItemConstructorOptions[] =
          g === 'Edit'
            ? [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }, { type: 'separator' }]
            : g === 'Window'
              ? [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }]
              : [];
        return { label: g, submenu: [...extra, ...actions] } as MenuItemConstructorOptions;
      }),
      { role: 'help', submenu: [{ label: 'Open Arc on GitHub', click: () => shell.openExternal('https://github.com/Jynx-hub/open-arc') }] },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  }

  // ── pushing to the UI ────────────────────────────────────────────────────

  private onState(state: State, prev: State) {
    // Only slices that changed are sent; the UI merges them.
    const patch = changedSlices(state, prev);
    for (const w of this.wins.values()) {
      this.sendUi(w, 'state', patch);
      this.layout(w);
    }
    // Repair windows whose selection or Space vanished, after the current command has had the chance
    // to pick a neighbour itself (dispatching from inside a store listener would reorder updates).
    setImmediate(() => {
      const now = this.store.state;
      for (const w of this.wins.values()) {
        if (!now.spaces.some((s) => s.id === w.spaceId)) {
          w.spaceId = now.spaces[0]!.id;
          this.selectDefaultForSpace(w);
        } else if (w.selectedId && !now.items[w.selectedId]) this.selectDefaultForSpace(w);
      }
    });
    if (state.settings.keyOverrides !== prev.settings.keyOverrides) this.buildMenu();
    // Deleting a Profile deletes its browsing data, as the confirmation says.
    for (const p of prev.profiles) if (!state.profiles.some((x) => x.id === p.id)) void clearProfileData(p.id);
  }

  uiState(): State {
    return uiState(this.store.state);
  }

  pushWindow(w: Win) {
    this.sendUi(w, 'window', this.windowInfo(w));
  }

  private scheduleLive() {
    if (this.liveTimer) return;
    this.liveTimer = setTimeout(() => {
      this.liveTimer = null;
      const live = Object.fromEntries(this.tabs.live);
      for (const w of this.wins.values()) this.sendUi(w, 'live', live);
    }, 50);
  }

  toast(w: Win, message: string, actionLabel?: string, command?: Command) {
    this.sendUi(w, 'toast', { message, actionLabel, command });
  }

  toastFocused(message: string) {
    const w = this.focused();
    if (w) this.toast(w, message);
  }

  sendUi<K extends keyof UiEvents>(w: Win, event: K, payload: UiEvents[K]) {
    if (event === 'action' && w.pending) {
      w.pending.push(payload as UiEvents['action']);
      return;
    }
    if (!w.win.isDestroyed()) w.win.webContents.send(`ui:${event}`, payload);
  }

  allWindows() {
    return [...this.wins.values()];
  }
}

/** History and ranking stay in the main process; the Command Bar asks for results instead. */
function uiState(state: State): State {
  return { ...state, history: [], ranking: { picks: {}, visits: {} } };
}

function changedSlices(state: State, prev: State): Partial<State> {
  const ui = uiState(state);
  const out: Partial<State> = {};
  for (const key of Object.keys(ui) as (keyof State)[]) {
    if (key === 'history' || key === 'ranking') continue;
    if (state[key] !== prev[key]) (out as Record<string, unknown>)[key] = ui[key];
  }
  return out;
}

function firstTab(state: State, rootId: string): string | null {
  return subtree(state, rootId).find((i: Item) => i.kind === 'tab' || i.kind === 'note' || i.kind === 'easel')?.id ?? null;
}

function isAncestorOrSelf(state: State, ancestorId: string, id: string): boolean {
  let cur: Item | undefined = state.items[id];
  while (cur) {
    if (cur.id === ancestorId) return true;
    cur = cur.parentId ? state.items[cur.parentId] : undefined;
  }
  return false;
}

function sameSite(a: string, b: string): boolean {
  try {
    const ha = new URL(a).hostname.split('.').slice(-2).join('.');
    const hb = new URL(b).hostname.split('.').slice(-2).join('.');
    return ha === hb;
  } catch {
    return true;
  }
}

export { itemTitle, rootOf };
export type { Win };
