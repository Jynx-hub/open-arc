// Window controller: which Space and tab each window shows, how live views are laid out, and every
// command the UI or a shortcut can run.
import { BrowserWindow, ClipboardItem, Menu, MenuItem, WebContentsView, app, clipboard, dialog, shell, type ContextMenuParams, type MenuItemConstructorOptions, type WebContents } from 'electron';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Command, ContextTarget, LiveTab, PasswordOp, Rect, Snapshot, UiEvents, WindowInfo } from '../shared/ipc';
import { itemTitle, type Item, type Space, type State } from '../shared/model';
import type { Action } from '../shared/reducer';
import { isPersistent, rootOf, sectionOf, spaceOf, subtree } from '../shared/tree';
import { KEY_ACTIONS, acceleratorFor } from '../shared/keymap';
import { QUIET, clearProfileData, partitionFor, sessionFor, setSessionSetup } from './profiles';
import type { Store } from './store';
import { TabViews } from './tabs';
import { search } from '../shared/search';
import { applyBoosts, exportBoostCss } from './boosts';
import { routeExternalUrl } from '../shared/routing';
import { contextMenuTemplate, searchURL, type PageMenuEntry } from '../shared/contextMenu';
import { Downloads } from './downloads';
import { Permissions } from './permissions';
import { PrivateTabs } from './incognito';
import { Extensions } from './extensions';
import { Passwords } from './passwords';
import { ARC_DATA_DIR } from './importer';
import { listArcExtensions } from './arcExtensions';
import { describeExtensionPermissions, isExtensionId } from '../shared/extensions';
import { arcProfileId } from '../shared/importArc';

const SPLIT_GAP = 6;
const PEEK_INSET = 48;

// Run in pages as a user gesture (Picture in Picture and play() need one).
const PIP_ENTER = `(() => {
  const v = [...document.querySelectorAll('video')].find((x) => !x.paused && x.readyState > 1 && !x.disablePictureInPicture);
  return v && document.pictureInPictureElement !== v ? v.requestPictureInPicture().then(() => true, () => false) : false;
})()`;
const PIP_EXIT = `document.pictureInPictureElement ? document.exitPictureInPicture().then(() => true, () => false) : false`;
const MEDIA_PAUSE = `(() => {
  const playing = [...document.querySelectorAll('video, audio')].filter((x) => !x.paused);
  playing.forEach((x) => x.pause());
  return playing.length > 0;
})()`;
const MEDIA_PLAY = `(() => {
  const m = document.querySelector('video, audio');
  if (m) void m.play().catch(() => {});
  return !!m;
})()`;

/** Actions that make sense in a private window; the rest act on Spaces and sidebar items, which it has none of. */
const PRIVATE_ACTIONS = new Set([
  'commandBar', 'focusURL', 'newWindow', 'newIncognitoWindow', 'littleArc', 'closeTab', 'copyURL', 'copyMarkdownLink', 'reload', 'back', 'forward',
  'zoomIn', 'zoomOut', 'zoomReset', 'devTools', 'toggleSidebar', 'find', 'savePageAs', 'print', 'nextTab', 'prevTab', 'settings',
]);

interface Win {
  win: BrowserWindow;
  kind: 'main' | 'little' | 'incognito';
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
  /** Private window: its tabs and throwaway session. */
  priv: PrivateTabs | null;
  /**
   * The page that is fullscreen in this window. `leaving`: the page has left, but the window is still
   * animating out of macOS fullscreen; the page keeps the whole window until that finishes.
   */
  htmlFullscreen: { wc: WebContents; windowFollows: boolean; leaving: boolean; exitAsked?: boolean } | null;
  /** UI actions queued until the window's UI says it is listening. */
  pending: UiEvents['action'][] | null;
  overlaySeq: number;
  peekSeq: number;
}

export class Browser {
  readonly tabs: TabViews;
  readonly downloads: Downloads;
  readonly permissions: Permissions;
  readonly extensions: Extensions;
  readonly passwords: Passwords;
  private wins = new Map<number, Win>();
  private lastFocused: number | null = null;
  private liveTimer: NodeJS.Timeout | null = null;
  /** Tabs whose video we floated into Picture in Picture; coming back to one puts the video back. */
  private pipped = new Map<string, string>(); // tab id → the page URL it was floated from
  private progressTimer: NodeJS.Timeout | null = null;
  private extensionsTimer: NodeJS.Timeout | null = null;

  constructor(private store: Store, private rendererURL: string) {
    this.tabs = new TabViews(store, {
      openFrom: (itemId, url, disposition) => this.openFromPage(itemId, url, disposition),
      willNavigate: (itemId, url, wc) => this.maybePeek(itemId, url, wc),
      domReady: (_itemId, wc) => applyBoosts(this.store.state, wc),
      contextMenu: (itemId, wc, params) => this.pageContextMenu(wc, params, itemId),
      fullscreen: (wc, on) => this.pageFullscreen(wc, on),
      created: (itemId, wc) => {
        // Known to extensions from the start, even while loading in the background.
        const space = spaceOf(this.store.state, itemId);
        const w = [...this.wins.values()].find((x) => x.kind === 'main' && x.spaceId === space?.id) ?? [...this.wins.values()].find((x) => x.kind === 'main');
        if (w) this.extensions.track(wc, w.win);
      },
      liveChanged: () => this.scheduleLive(),
    });
    this.downloads = new Downloads(store, {
      completed: (entry) => {
        // A private download is announced only in its own window.
        const w = entry.private ? [...this.wins.values()].find((x) => x.priv?.partition === entry.profileId) : this.focused();
        if (w) this.toast(w, `Downloaded ${entry.filename}`, 'Show', { type: 'download', op: 'show', id: entry.id });
      },
      progress: () => this.scheduleProgress(),
    });
    this.permissions = new Permissions(store, {
      changed: () => this.wins.forEach((w) => this.pushWindow(w)),
      capturing: (wc, keys) => {
        const id = this.tabs.itemFor(wc);
        if (id) this.tabs.setCapturing(id, keys);
      },
    });
    this.extensions = new Extensions({
      createTab: async (profileId, details) => {
        const w = this.windowForProfile(profileId, details.windowId);
        const space = this.currentSpace(w).profileId === profileId ? this.currentSpace(w) : this.store.state.spaces.find((s) => s.profileId === profileId);
        if (!space) throw new Error('No Space uses this Profile');
        const id = this.backgroundTab(space, details.url ?? 'about:blank');
        if (details.active !== false) this.select(w, id);
        return [this.tabs.get(id)!.webContents, w.win];
      },
      selectTab: (wc) => {
        const id = this.tabs.itemFor(wc);
        const w = this.winOf(wc) ?? (id ? this.windowForProfile(this.spaceOfItem(id).profileId) : null);
        if (id && w && w.selectedId !== id) this.select(w, id);
      },
      activeTab: (win) => {
        const w = this.wins.get(win.id);
        return w ? this.activeTab(w) : null;
      },
      closeTab: (wc) => {
        const id = this.tabs.itemFor(wc);
        const w = this.winOf(wc);
        if (id) this.close(w ?? this.mainWindow(this.focused()), id);
        else if (w?.little?.webContents === wc) w.win.close();
      },
      createWindow: async (profileId, details) => {
        const space = this.store.state.spaces.find((s) => s.profileId === profileId);
        const nw = this.createWindow({ spaceId: space?.id });
        const urls = Array.isArray(details.url) ? details.url : details.url ? [details.url] : [];
        // Like a window full of new tabs: the first one ends up selected, at the top of Today.
        for (const url of [...urls].reverse()) this.newTab(nw, url);
        return nw.win;
      },
      closeWindow: (win) => win.close(),
      confirmInstall: (name, permissions, wc) => this.confirmInstall(name, permissions, this.winOf(wc) ?? this.focused()),
      changed: () => this.scheduleExtensions(),
    });
    this.passwords = new Passwords(app.getPath('userData'), {
      promptChanged: () => this.wins.forEach((w) => this.pushWindow(w)),
      listChanged: (profileId) => {
        for (const w of this.wins.values()) if (!w.priv && this.currentSpace(w).profileId === profileId) this.sendUi(w, 'passwords', null);
      },
      showMenu: (wc, items, at) => {
        const w = this.winOf(wc);
        const view = w && [w.little, w.peek?.view, ...w.attached].find((v) => v?.webContents === wc);
        if (!w || !view) return;
        const b = view.getBounds();
        Menu.buildFromTemplate(items).popup({ window: w.win, x: Math.round(b.x + at.x), y: Math.round(b.y + at.y) });
      },
    });
    setSessionSetup((ses, { profileId, private: isPrivate }) => {
      if (isPrivate) this.permissions.markPrivate(ses);
      else {
        this.extensions.setup(ses, profileId);
        this.passwords.setup(ses, profileId);
      }
      ses.on('will-download', (_e, item) => this.downloads.track(item, profileId, isPrivate));
      ses.setPermissionRequestHandler((wc, permission, callback, details) => this.permissions.request(wc, permission, callback, details));
      ses.setPermissionCheckHandler((_wc, permission, origin, details) => this.permissions.check(ses, permission, origin, details));
    });
    store.subscribe((state, prev) => this.onState(state, prev));
  }

  // ── windows ──────────────────────────────────────────────────────────────

  createWindow(opts: { kind?: Win['kind']; spaceId?: string; url?: string } = {}): Win {
    const kind = opts.kind ?? 'main';
    const state = this.store.state;
    const win = new BrowserWindow({
      width: kind === 'little' ? 760 : 1400,
      height: kind === 'little' ? 620 : 900,
      minWidth: 480,
      minHeight: 320,
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 14, y: 14 },
      backgroundColor: kind === 'incognito' ? '#1e1d24' : '#e9e7f5',
      show: false,
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true },
    });
    const spaceId = opts.spaceId ?? this.focused()?.spaceId ?? state.spaces[0]!.id;
    const w: Win = {
      win, kind, spaceId, selectedId: null, previousId: null, lastSelected: new Map(), bounds: { x: 0, y: 0, width: 0, height: 0 },
      sidebarHidden: false, overlay: false, snapshots: null, attached: [], peek: null, peekBackdrop: null, little: null, priv: null, htmlFullscreen: null, pending: [], overlaySeq: 0, peekSeq: 0,
    };
    this.wins.set(win.id, w);
    win.on('focus', () => (this.lastFocused = win.id));
    win.on('closed', () => this.onWindowClosed(w));
    win.on('resize', () => {
      if (w.htmlFullscreen?.leaving && !win.isFullScreen()) this.finishFullscreen(w);
      else if (w.htmlFullscreen) this.layout(w);
    });
    win.on('leave-full-screen', () => this.finishFullscreen(w));
    win.once('ready-to-show', () => {
      if (!QUIET) return win.show();
      win.setOpacity(0);
      win.setIgnoreMouseEvents(true);
      win.showInactive();
    });
    void win.loadURL(`${this.rendererURL}#${kind}`);

    if (kind === 'little') {
      const view = new WebContentsView({ webPreferences: { session: sessionFor(this.store.state.spaces.find((s) => s.id === spaceId)?.profileId ?? 'default'), sandbox: true } });
      view.setBorderRadius(8);
      w.little = view;
      view.webContents.on('page-title-updated', () => this.pushWindow(w));
      view.webContents.on('did-navigate', () => this.pushWindow(w));
      view.webContents.on('context-menu', (_e, params) => this.pageContextMenu(view.webContents, params, null));
      view.webContents.setWindowOpenHandler(({ url }) => {
        void view.webContents.loadURL(url);
        return { action: 'deny' };
      });
      if (opts.url) void view.webContents.loadURL(opts.url);
      this.layout(w);
    } else if (kind === 'incognito') {
      w.priv = new PrivateTabs({
        changed: () => {
          this.layout(w);
          this.pushWindow(w);
        },
        contextMenu: (wc, params) => this.pageContextMenu(wc, params, null),
        domReady: (wc) => applyBoosts(this.store.state, wc),
        fullscreen: (wc, on) => this.pageFullscreen(wc, on),
      });
      if (opts.url) w.priv.create(opts.url);
      else this.sendUi(w, 'action', { id: 'commandBar' });
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
    return {
      id: w.win.id,
      kind: w.kind,
      spaceId: w.spaceId,
      selectedId: w.selectedId,
      sidebarHidden: w.sidebarHidden,
      snapshots: w.snapshots ?? w.peekBackdrop,
      peek: peekWc ? { url: peekWc.getURL(), title: peekWc.getTitle() } : null,
      little: littleWc ? { url: littleWc.getURL(), title: littleWc.getTitle() } : null,
      zoom: this.activeContents(w)?.getZoomFactor() ?? 1,
      permissionPrompt: this.permissions.promptFor(this.promptOrder(w)),
      passwordPrompt: w.priv ? null : this.passwords.promptFor(this.promptOrder(w)),
      private: w.priv ? { tabs: w.priv.tabs(), selectedId: w.priv.selectedId, partition: w.priv.partition } : null,
      extensionPartition: w.priv ? null : partitionFor(this.currentSpace(w).profileId),
      activeTabId: this.activeTab(w)?.id ?? null,
    };
  }

  /** Pages whose prompts a window shows: the focused page first, then the other Split View panes, so no visible page waits on a hidden prompt. */
  private promptOrder(w: Win): WebContents[] {
    return [this.activeContents(w), ...w.attached.map((v) => v.webContents)].filter((x): x is WebContents => !!x);
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
    this.scheduleLive();
    if (w.priv) {
      this.downloads.forgetPrivate(w.priv.partition);
      void w.priv.destroy();
    }
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
    this.pictureInPicture(w, left, item?.id ?? null);
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
    const wc = item?.kind === 'tab' ? this.tabs.get(item.id)?.webContents : null;
    if (wc) this.extensions.selected(wc);
    if (focus && wc) wc.focus();
  }

  /** Leaving a tab with a playing video floats it in Picture in Picture; returning to it docks it again. */
  private pictureInPicture(w: Win, left: string | null, arrived: string | null) {
    const back = arrived ? this.tabs.get(arrived)?.webContents : null;
    // Only the page we floated: a tab that has since navigated keeps whatever PiP its new page chose.
    if (arrived && back && this.pipped.get(arrived) === back.getURL()) void inFrames(back, PIP_EXIT);
    if (arrived) this.pipped.delete(arrived);
    if (!left || !this.store.state.settings.autoPictureInPicture || !this.tabs.live.get(left)?.playing) return;
    if (this.visibleIds(w).includes(left)) return; // still on screen as another Split View pane
    const wc = this.tabs.get(left)?.webContents;
    if (!wc) return;
    const url = wc.getURL();
    void inFrames(wc, PIP_ENTER).then((ok) => ok && this.pipped.set(left, url));
  }

  /**
   * A page went fullscreen or came back: lay it out over the whole window, or back in its place.
   * Electron itself takes the window into macOS fullscreen and out again (calling setFullScreen here
   * too toggles it twice mid-animation, and the page never finishes leaving fullscreen).
   */
  private pageFullscreen(wc: WebContents, on: boolean) {
    const w = this.winOf(wc);
    if (!w || w.win.isDestroyed()) return;
    if (on) {
      // Electron takes the window fullscreen for the page unless it already was (then it stays after).
      w.htmlFullscreen = { wc, windowFollows: w.htmlFullscreen?.windowFollows ?? !w.win.isFullScreen(), leaving: false };
    } else if (w.htmlFullscreen?.wc === wc) {
      if (w.htmlFullscreen.windowFollows && w.win.isFullScreen()) w.htmlFullscreen.leaving = true;
      else w.htmlFullscreen = null;
    }
    this.layout(w);
  }

  /**
   * The window is out of macOS fullscreen: put the page back in its place. A page only finishes leaving
   * fullscreen when it sees its new size while attached, and Escape pressed during the animation into
   * fullscreen can leave it stuck; asking it to exit (a no-op when it already has) settles both.
   */
  private finishFullscreen(w: Win) {
    const left = w.htmlFullscreen;
    if (left && !left.leaving && w.win.isFullScreen()) return;
    w.htmlFullscreen = null;
    for (const wc of new Set([...w.attached.map((v) => v.webContents), ...(left ? [left.wc] : [])])) {
      if (!wc.isDestroyed()) void wc.executeJavaScript('document.fullscreenElement && document.exitFullscreen()', true).catch(() => {});
    }
    this.layout(w);
  }

  /** The sidebar mini player's buttons. */
  private media(id: string, op: 'playPause' | 'mute') {
    const wc = this.tabs.get(id)?.webContents;
    if (!wc || wc.isDestroyed()) return;
    if (op === 'mute') {
      wc.setAudioMuted(!wc.isAudioMuted());
      return this.tabs.refresh(id);
    }
    if (this.tabs.live.get(id)?.playing) return Promise.all(wc.mainFrame.framesInSubtree.map((f) => f.executeJavaScript(MEDIA_PAUSE, true).catch(() => false)));
    return inFrames(wc, MEDIA_PLAY);
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
    } else if (w.priv) {
      const view = w.overlay ? null : w.priv.selected();
      if (view) {
        want.push(view);
        rects.push(b);
      }
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
    // A fullscreen page fills the whole window, over the sidebar, as the only view.
    const fsWc = w.htmlFullscreen && !w.overlay && !w.htmlFullscreen.wc.isDestroyed() ? w.htmlFullscreen.wc : null;
    const fsView = fsWc ? want.find((v) => v.webContents === fsWc) ?? w.attached.find((v) => v.webContents === fsWc) : undefined;
    if (fsView) {
      // Switched away from it: the page leaves fullscreen first, still attached (Electron ignores the exit
      // of a detached page). Its leave event lays out the new selection.
      if (!want.includes(fsView) && !w.htmlFullscreen!.leaving && !w.htmlFullscreen!.exitAsked) {
        w.htmlFullscreen!.exitAsked = true;
        void fsWc!.executeJavaScript('document.fullscreenElement && document.exitFullscreen()', true).catch(() => {});
      }
      const [width, height] = w.win.getContentSize();
      want.splice(0, want.length, fsView);
      rects.splice(0, rects.length, { x: 0, y: 0, width: width!, height: height! });
    }
    const before = w.attached.length;
    let moved = false;
    for (const v of w.attached) if (!want.includes(v)) this.detach(w, v);
    want.forEach((v, i) => {
      if (!w.attached.includes(v)) {
        moved = true;
        // A view lives in one window at a time; take it from whichever window has it.
        for (const other of this.wins.values()) if (other !== w && other.attached.includes(v)) this.detach(other, v);
        w.win.contentView.addChildView(v);
        w.attached.push(v);
        this.extensions.track(v.webContents, w.win);
      }
      v.setBounds(rects[i]!);
      v.setBorderRadius(fsView ? 0 : 8);
    });
    // The mini player hides tabs that are on screen anywhere.
    if (moved || w.attached.length !== before) this.scheduleLive();
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
    // A private window keeps everything it opens to itself, as private tabs.
    if (w.priv) {
      const view = where === 'current' ? w.priv.selected() : null;
      if (view) void view.webContents.loadURL(url);
      else w.priv.create(url);
      return;
    }
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
    view.webContents.on('context-menu', (_e, params) => this.pageContextMenu(view.webContents, params, null));
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
    const w = [...this.wins.values()].find((x) => x.attached.some((v) => v === this.tabs.get(itemId))) ?? this.mainWindow(this.focused());
    const state = this.store.state;
    const space = spaceOf(state, itemId) ?? this.currentSpace(w);
    if (disposition === 'new-window') {
      const nw = this.createWindow({ spaceId: space.id });
      this.newTab(nw, url);
      return;
    }
    // New tabs from a page open in Today, at the top. Background dispositions don't steal focus.
    const id = this.backgroundTab(space, url);
    if (disposition !== 'background-tab') this.select(w, id);
  }

  /** A new Today tab that loads without being selected. */
  private backgroundTab(space: Space, url: string): string {
    const id = randomUUID();
    this.store.dispatch({ type: 'tab.create', id, parentId: space.todayRootId, index: 0, url, now: Date.now() });
    this.tabs.ensure(id);
    return id;
  }

  /** A main window to open tabs in: `w` itself, else the first one, else a new one. */
  private mainWindow(w: Win | null): Win {
    if (w?.kind === 'main') return w;
    return [...this.wins.values()].find((x) => x.kind === 'main') ?? this.createWindow({ spaceId: w?.spaceId });
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
    if (!QUIET) {
      w.win.show();
      w.win.focus();
    }
  }

  littleToSpace(w: Win, spaceId: string) {
    const url = w.little?.webContents.getURL();
    if (!url) return;
    const target = this.mainWindow(null);
    this.switchSpace(target, spaceId);
    this.newTab(target, url);
    w.little?.webContents.close();
    w.little = null;
    w.win.close();
    if (!QUIET) target.win.focus();
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
      case 'select': return w.priv ? w.priv.select(c.id) : this.select(w, c.id);
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
      case 'close': return w.priv ? w.priv.close(c.id) : this.close(w, c.id);
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
      case 'search': {
        const results = search(this.store.state, this.tabs.live, c.query, w.spaceId);
        // A private window offers addresses and searches only: no tabs, history or actions from the normal Spaces.
        return w.priv ? results.filter((r) => r.kind === 'url' || r.kind === 'search' || r.kind === 'siteSearch') : results;
      }
      case 'pickResult':
        if (w.priv) return;
        return this.store.dispatch({ type: 'ranking.pick', query: c.query, key: c.key, now: Date.now() });
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
      case 'download': return this.downloads.run(c.op, c.id);
      case 'permission': return this.permissions.respond(c.id, c.answer);
      case 'passwordPrompt':
        try {
          return this.passwords.respond(c.id, c.answer);
        } catch (err) {
          return this.toast(w, (err as Error).message);
        }
      case 'passwords':
        return this.passwordOp(w, c).catch((err: Error) => {
          this.toast(w, err.message);
          return { error: err.message };
        });
      case 'media': return this.media(c.id, c.op);
      case 'extensions': return this.extensionList(w);
      case 'extension': return this.extensionOp(w, c.op, c.id);
      case 'arcExtensions': return this.arcExtensions(w, c.dir ?? ARC_DATA_DIR);
    }
  }

  /** The page extension buttons act on: the selected tab, or the mini window's page (never Peek). */
  private activeTab(w: Win): WebContents | null {
    return w.little?.webContents ?? (w.selectedId ? this.tabs.get(w.selectedId)?.webContents : null) ?? null;
  }

  private activeContents(w: Win): WebContents | null {
    if (w.peek) return w.peek.view.webContents;
    if (w.little) return w.little.webContents;
    if (w.priv) return w.priv.selected()?.webContents ?? null;
    return w.selectedId ? this.tabs.get(w.selectedId)?.webContents ?? null : null;
  }

  /** Menu and shortcut actions. Those that need UI are forwarded to the window's sidebar. */
  runAction(w: Win | null, id: string) {
    if (!w) {
      if (id === 'newWindow' || id === 'commandBar') this.createWindow();
      if (id === 'littleArc') this.createWindow({ kind: 'little' });
      if (id === 'newIncognitoWindow') this.createWindow({ kind: 'incognito' });
      return;
    }
    if (w.priv) {
      if (!PRIVATE_ACTIONS.has(id)) return;
      const ids = w.priv.ids();
      const at = w.priv.selectedId ? ids.indexOf(w.priv.selectedId) : -1;
      if (id === 'closeTab') return w.priv.selectedId ? w.priv.close(w.priv.selectedId) : w.win.close();
      if (id === 'nextTab' || id === 'prevTab') {
        const next = ids[(at + (id === 'nextTab' ? 1 : -1) + ids.length) % ids.length];
        return next ? w.priv.select(next) : undefined;
      }
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
      case 'newIncognitoWindow': return void this.createWindow({ kind: 'incognito' });
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
      case 'savePageAs': return void this.savePageAs(w);
      case 'print':
        return wc?.print({}, (ok, reason) => {
          if (!ok && !/cancel/i.test(reason)) this.toast(w, 'Could not print the page');
        });
      case 'toggleAutoPip': {
        const on = !state.settings.autoPictureInPicture;
        this.store.dispatch({ type: 'settings.update', patch: { autoPictureInPicture: on } });
        return this.toast(w, on ? 'Automatic Picture in Picture is on' : 'Automatic Picture in Picture is off');
      }
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

  private async savePageAs(w: Win) {
    const wc = this.activeContents(w);
    if (!wc || !/^https?:|^file:/.test(wc.getURL())) return;
    const name = (wc.getTitle() || 'page').replace(/[/\\:*?"<>|]+/g, '-').slice(0, 100);
    const res = await dialog.showSaveDialog(w.win, { defaultPath: path.join(this.downloads.dir(), `${name}.html`), filters: [{ name: 'Web Page', extensions: ['html'] }] });
    if (!res.filePath || wc.isDestroyed()) return;
    try {
      await wc.savePage(res.filePath, 'HTMLComplete');
      this.toast(w, `Saved ${path.basename(res.filePath)}`);
    } catch {
      this.toast(w, 'Could not save the page');
    }
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
    const summary = await importFromArc(this.store, dir, process.env.OPEN_ARC_FIRESTORE_DIR || undefined);
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

  /** Right-click inside a page (a tab, Peek, or a mini window). `itemId` is the tab, when there is one. */
  private pageContextMenu(wc: WebContents, params: ContextMenuParams, itemId: string | null) {
    const w = this.winOf(wc) ?? this.focused();
    if (!w) return;
    const entries = contextMenuTemplate(params, {
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
      canSplit: !!itemId && this.store.state.items[itemId]?.kind === 'tab',
      isPrivate: !!w.priv,
    });
    const template = entries.map((e): MenuItemConstructorOptions => {
      if (e.id === 'separator') return { type: 'separator' };
      const enabled = 'word' in e ? !!e.word : e.enabled !== false;
      return { label: e.label, enabled, click: () => this.runPageMenu(w, wc, itemId, params, e) };
    });
    const menu = Menu.buildFromTemplate(template);
    // Items extensions added with chrome.contextMenus go last.
    const extra = this.extensions.contextMenuItems(wc, params);
    if (extra.length) [new MenuItem({ type: 'separator' }), ...extra].forEach((i) => menu.append(i));
    menu.popup({ window: w.win });
  }

  private runPageMenu(w: Win, wc: WebContents, itemId: string | null, p: ContextMenuParams, e: PageMenuEntry) {
    if (wc.isDestroyed()) return;
    if (w.priv) {
      // Whatever a private page opens stays in its private window.
      if (e.id === 'openLinkNewTab' || e.id === 'openImageNewTab') return void w.priv.create(e.id === 'openLinkNewTab' ? p.linkURL : p.srcURL, { select: false });
      if (e.id === 'searchSelection') return void w.priv.create(searchURL(this.store.state.settings.searchTemplate, p.selectionText));
    }
    switch (e.id) {
      // From Peek or a mini window the new tab still lands in a main window's sidebar, where it can be seen.
      case 'openLinkNewTab': return void this.backgroundTab(this.currentSpace(this.mainWindow(w)), p.linkURL);
      case 'openLinkSplit': return itemId ? this.splitWith(w, itemId, { url: p.linkURL }) : undefined;
      case 'openLinkLittle': return void this.createWindow({ kind: 'little', url: p.linkURL, spaceId: w.spaceId });
      case 'copyLink': return clipboard.writeText(p.linkURL);
      case 'saveLinkAs': return this.downloads.saveAs(wc, p.linkURL);
      case 'openImageNewTab': return void this.backgroundTab(this.currentSpace(this.mainWindow(w)), p.srcURL);
      case 'copyImage': return wc.copyImageAt(p.x, p.y);
      case 'copyImageAddress': return clipboard.writeText(p.srcURL);
      case 'saveImageAs': return this.downloads.saveAs(wc, p.srcURL);
      case 'cut': return wc.cut();
      case 'copy': return wc.copy();
      case 'paste': return wc.paste();
      case 'selectAll': return wc.selectAll();
      case 'searchSelection': return void this.newTab(this.mainWindow(w), searchURL(this.store.state.settings.searchTemplate, p.selectionText));
      case 'replaceMisspelling': return e.word ? wc.replaceMisspelling(e.word) : undefined;
      case 'addToDictionary': return void wc.session.addWordToSpellCheckerDictionary(p.misspelledWord);
      case 'back': return wc.navigationHistory.goBack();
      case 'forward': return wc.navigationHistory.goForward();
      case 'reload': return wc.reload();
      case 'inspect': return wc.inspectElement(p.x, p.y);
    }
  }

  /** The window showing `wc` (as a tab pane, Peek, or mini window page). */
  private winOf(wc: WebContents): Win | null {
    for (const w of this.wins.values()) {
      if (w.little?.webContents === wc || w.peek?.view.webContents === wc || w.attached.some((v) => v.webContents === wc)) return w;
    }
    return null;
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

  // ── extensions ───────────────────────────────────────────────────────────

  /** A main window to open a Profile's tab in: the given one, else one already showing that Profile, else any. */
  private windowForProfile(profileId: string, windowId?: number): Win {
    const mains = [...this.wins.values()].filter((x) => x.kind === 'main');
    return (
      mains.find((x) => x.win.id === windowId) ??
      mains.find((x) => x.win.id === this.lastFocused && this.currentSpace(x).profileId === profileId) ??
      mains.find((x) => this.currentSpace(x).profileId === profileId) ??
      this.mainWindow(this.focused())
    );
  }

  private spaceOfItem(id: string): Space {
    return spaceOf(this.store.state, id) ?? this.store.state.spaces[0]!;
  }

  private extensionList(w: Win) {
    if (w.priv) return [];
    const profileId = this.currentSpace(w).profileId;
    return this.extensions.list(sessionFor(profileId), profileId);
  }

  /** Arc's extensions to offer this window's Profile: from the Arc profile it was imported from, else from all of them. */
  private arcExtensions(w: Win, dir: string) {
    const all = listArcExtensions(dir);
    const profileId = this.currentSpace(w).profileId;
    const matching = all.filter((a) => arcProfileId(a.profileDir) === profileId);
    return [...new Map((matching.length ? matching : all).map((a) => [a.id, a])).values()];
  }

  private async extensionOp(w: Win, op: 'install' | 'remove' | 'enable' | 'disable', id: string): Promise<boolean> {
    if (w.priv || !isExtensionId(id)) return false;
    const profileId = this.currentSpace(w).profileId;
    const ses = sessionFor(profileId);
    try {
      if (op === 'install') {
        const name = await this.extensions.install(ses, profileId, id, (n, permissions) => this.confirmInstall(n, permissions, w));
        if (!name) return false;
        this.toast(w, `Added ${name}`);
      } else if (op === 'remove') {
        await this.extensions.remove(ses, profileId, id);
        const pinned = this.store.state.settings.pinnedExtensions;
        this.store.dispatch({ type: 'settings.update', patch: { pinnedExtensions: { ...pinned, [profileId]: (pinned[profileId] ?? []).filter((x) => x !== id) } } });
      } else await this.extensions.setEnabled(ses, profileId, id, op === 'enable');
      return true;
    } catch (err) {
      console.error(`extension ${op} failed`, err);
      this.toast(w, op === 'install' ? 'Could not install that extension from the Chrome Web Store' : 'Could not change that extension');
      return false;
    }
  }

  /** Library › Passwords, on the window's Profile. Private windows have no saved passwords. */
  private async passwordOp(w: Win, c: PasswordOp): Promise<unknown> {
    if (w.priv) return null;
    const profileId = this.currentSpace(w).profileId;
    const p = this.passwords;
    switch (c.op) {
      case 'list': return p.list(profileId);
      case 'reveal': return p.reveal(profileId, c.id);
      case 'copy': {
        const ok = await p.copy(profileId, c.id);
        if (ok) this.toast(w, 'Password copied');
        return ok;
      }
      case 'update': return p.update(profileId, c.id, c);
      case 'remove': return p.remove(profileId, c.id);
      case 'unblock': return p.unblock(profileId, c.origin);
      case 'import': {
        // A path from the UI is for tests; a packaged app only imports what the user picked.
        let file = app.isPackaged ? undefined : c.file;
        if (!file) {
          const res = await dialog.showOpenDialog(w.win, { title: 'Choose a passwords CSV file', properties: ['openFile'], filters: [{ name: 'CSV', extensions: ['csv'] }] });
          file = res.filePaths[0];
          if (res.canceled || !file) return null;
        }
        return p.importCsv(profileId, file);
      }
      case 'deleteImported': return p.deleteImported(profileId);
      case 'export': {
        const res = await dialog.showSaveDialog(w.win, { defaultPath: path.join(app.getPath('documents'), 'Open Arc Passwords.csv'), filters: [{ name: 'CSV', extensions: ['csv'] }] });
        if (res.canceled || !res.filePath) return false;
        return p.exportCsv(profileId, res.filePath);
      }
    }
  }

  /** The Web Store's Add button: confirm, listing what the extension asks to do. */
  private async confirmInstall(name: string, permissions: string[], w: Win | null): Promise<boolean> {
    const lines = describeExtensionPermissions(permissions);
    const opts = {
      type: 'question' as const,
      buttons: ['Add Extension', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      message: `Add “${name}” to Open Arc?`,
      detail: lines.length ? `It will be able to:\n${lines.map((l) => `• ${l}`).join('\n')}` : 'It doesn’t ask for any special access.',
    };
    const { response } = w ? await dialog.showMessageBox(w.win, opts) : await dialog.showMessageBox(opts);
    return response === 0;
  }

  private scheduleExtensions() {
    if (this.extensionsTimer) return;
    this.extensionsTimer = setTimeout(() => {
      this.extensionsTimer = null;
      // One list per Profile, however many windows show it (building one reads every icon).
      const lists = new Map<string, ReturnType<Browser['extensionList']>>();
      for (const w of this.wins.values()) {
        if (w.priv) continue;
        const profileId = this.currentSpace(w).profileId;
        if (!lists.has(profileId)) lists.set(profileId, this.extensionList(w));
        this.sendUi(w, 'extensions', lists.get(profileId)!);
      }
    }, 100);
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
    if (state.items !== prev.items) for (const id of this.pipped.keys()) if (!state.items[id]) this.pipped.delete(id);
    if (state.settings.keyOverrides !== prev.settings.keyOverrides) this.buildMenu();
    // Deleting a Profile deletes its browsing data, as the confirmation says.
    for (const p of prev.profiles) {
      if (state.profiles.some((x) => x.id === p.id)) continue;
      void clearProfileData(p.id);
      this.passwords.forget(p.id);
    }
    // Answers changed in Settings or the site panel settle prompts that are already waiting.
    if (state.settings.sitePermissions !== prev.settings.sitePermissions) setImmediate(() => this.permissions.recheck());
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
      const live = this.liveSnapshot();
      for (const w of this.wins.values()) this.sendUi(w, 'live', live);
    }, 50);
  }

  /** Live tab fields for the UI, with which tabs are on screen in some window. */
  liveSnapshot(): Record<string, LiveTab> {
    const shown = new Set([...this.wins.values()].flatMap((w) => w.attached.map((v) => this.tabs.itemFor(v.webContents))));
    return Object.fromEntries([...this.tabs.live].map(([id, l]) => [id, { ...l, onScreen: shown.has(id) }]));
  }

  private scheduleProgress() {
    if (this.progressTimer) return;
    // At most 4 progress updates a second per window.
    this.progressTimer = setTimeout(() => {
      this.progressTimer = null;
      const progress = Object.fromEntries(this.downloads.progress);
      for (const w of this.wins.values()) this.sendUi(w, 'downloadProgress', progress);
    }, 250);
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

/** Run `js` in the page's frames, top first, as a user gesture, until one returns true (media is often in an iframe). */
async function inFrames(wc: WebContents, js: string): Promise<boolean> {
  if (wc.isDestroyed()) return false;
  for (const frame of wc.mainFrame.framesInSubtree) {
    if (await frame.executeJavaScript(js, true).catch(() => false)) return true;
  }
  return false;
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
