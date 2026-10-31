// One WebContentsView per loaded tab item. The sidebar item (and its saved URL) outlives the view:
// unloading a pinned tab destroys the view but keeps the item (spec: pinned-and-today-tabs.md).
import { WebContentsView, type ContextMenuParams, type Session, type WebContents } from 'electron';
import type { LiveTab } from '../shared/ipc';
import type { State } from '../shared/model';
import { QUIET, partitionFor, profileOfItem, sessionFor } from './profiles';
import type { Store } from './store';

export interface TabHooks {
  /** A page asked for a new window/tab (target=_blank, window.open, ⌘-click). */
  openFrom(itemId: string, url: string, disposition: string): void;
  /** A link click in a page; return true to cancel the navigation (used by Peek). */
  willNavigate(itemId: string, url: string, wc: WebContents): boolean;
  /** Called on every `dom-ready` so Boosts can inject. */
  domReady(itemId: string, wc: WebContents): void;
  /** Right-click in the page. */
  contextMenu(itemId: string, wc: WebContents, params: ContextMenuParams): void;
  /** The page entered or left fullscreen (a video's fullscreen button, `requestFullscreen()`). */
  fullscreen(wc: WebContents, on: boolean): void;
  /** A tab's page view was just made (it may not be on screen yet). */
  created(itemId: string, wc: WebContents): void;
  liveChanged(): void;
}

/** A page view as every tab gets it, sidebar or private. */
export function pageView(ses: Session): WebContentsView {
  const view = new WebContentsView({
    webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false, disableHtmlFullscreenWindowResize: QUIET },
  });
  view.setBorderRadius(8);
  view.setBackgroundColor('#ffffff');
  return view;
}

interface Entry {
  view: WebContentsView;
  partition: string;
}

export class TabViews {
  private entries = new Map<string, Entry>();
  readonly live = new Map<string, LiveTab>();

  constructor(private store: Store, private hooks: TabHooks) {
    store.subscribe((state) => this.reconcile(state));
  }

  has(itemId: string) {
    return this.entries.has(itemId);
  }

  get(itemId: string): WebContentsView | null {
    return this.entries.get(itemId)?.view ?? null;
  }

  /** The item whose view owns `wc`, if any. */
  itemFor(wc: WebContents): string | null {
    for (const [id, e] of this.entries) if (e.view.webContents === wc) return id;
    return null;
  }

  ensure(itemId: string): WebContentsView | null {
    const existing = this.entries.get(itemId);
    if (existing) return existing.view;
    const state = this.store.state;
    const item = state.items[itemId];
    const profileId = profileOfItem(state, itemId);
    if (!item?.tab || !profileId) return null;

    const view = pageView(sessionFor(profileId));
    this.entries.set(itemId, { view, partition: partitionFor(profileId) });
    this.wire(itemId, view.webContents);
    this.hooks.created(itemId, view.webContents);
    if (item.tab.savedURL) void view.webContents.loadURL(item.tab.savedURL).catch(() => {});
    return view;
  }

  unload(itemId: string) {
    const entry = this.entries.get(itemId);
    if (!entry) return;
    this.entries.delete(itemId);
    this.live.delete(itemId);
    entry.view.removeAllListeners();
    const parent = (entry.view as unknown as { getParentView?: () => { removeChildView(v: WebContentsView): void } | null }).getParentView?.();
    parent?.removeChildView(entry.view);
    if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close();
    this.hooks.liveChanged();
  }

  /** Camera/microphone in use, shown until the page navigates. */
  setCapturing(itemId: string, keys: string[]) {
    const live = this.live.get(itemId);
    if (!live) return;
    this.live.set(itemId, { ...live, capturing: [...new Set([...(live.capturing ?? []), ...keys])] });
    this.hooks.liveChanged();
  }

  /** Re-read a tab's live fields (after we changed something the page doesn't announce, like muting). */
  refresh(itemId: string) {
    const live = this.live.get(itemId);
    const wc = this.entries.get(itemId)?.view.webContents;
    if (!live || !wc || wc.isDestroyed()) return;
    this.live.set(itemId, { ...live, audible: wc.isCurrentlyAudible(), muted: wc.isAudioMuted() });
    this.hooks.liveChanged();
  }

  loadedIds(): string[] {
    return [...this.entries.keys()];
  }

  /** Drop views whose item is gone; reload into the new session when an item changes Profile. */
  private reconcile(state: State) {
    for (const [id, entry] of [...this.entries]) {
      if (!state.items[id]) {
        this.unload(id);
        continue;
      }
      const profileId = profileOfItem(state, id);
      if (profileId && partitionFor(profileId) !== entry.partition) {
        const url = entry.view.webContents.getURL();
        this.unload(id);
        const view = this.ensure(id);
        if (url) void view?.webContents.loadURL(url).catch(() => {});
      }
    }
  }

  private wire(itemId: string, wc: WebContents) {
    const update = (patch: Partial<LiveTab> = {}) => {
      if (wc.isDestroyed()) return;
      const prev = this.live.get(itemId);
      this.live.set(itemId, {
        url: wc.getURL(),
        title: wc.getTitle(),
        favicon: prev?.favicon ?? null,
        loading: wc.isLoading(),
        canGoBack: wc.navigationHistory.canGoBack(),
        canGoForward: wc.navigationHistory.canGoForward(),
        audible: wc.isCurrentlyAudible(),
        muted: wc.isAudioMuted(),
        playing: prev?.playing,
        capturing: prev?.capturing,
        ...patch,
      });
      this.hooks.liveChanged();
    };
    const navigated = (patch: Partial<LiveTab> = {}) => {
      update(patch);
      const url = wc.getURL();
      this.store.dispatch({ type: 'tab.navigated', id: itemId, url, title: wc.getTitle() || url });
      this.store.dispatch({ type: 'history.visit', url, title: wc.getTitle(), now: Date.now() });
    };

    wc.on('did-start-loading', () => update());
    wc.on('did-stop-loading', () => update());
    wc.on('did-navigate', () => navigated({ capturing: undefined, playing: false }));
    wc.on('did-navigate-in-page', (_e, _url, isMainFrame) => isMainFrame && navigated());
    wc.on('page-title-updated', (_e, title) => {
      update({ title });
      this.store.dispatch({ type: 'tab.navigated', id: itemId, url: wc.getURL(), title });
    });
    wc.on('page-favicon-updated', (_e, favicons) => {
      const favicon = favicons[0] ?? null;
      update({ favicon });
      this.store.dispatch({ type: 'tab.navigated', id: itemId, url: wc.getURL(), title: wc.getTitle(), faviconURL: favicon });
    });
    wc.on('audio-state-changed', () => update());
    // One event per media element, so count them: one of several pausing doesn't stop the tab "playing".
    let players = 0;
    wc.on('media-started-playing', () => update({ playing: ++players > 0 }));
    wc.on('media-paused', () => update({ playing: (players = Math.max(0, players - 1)) > 0 }));
    wc.on('did-navigate', () => (players = 0));
    wc.on('dom-ready', () => this.hooks.domReady(itemId, wc));
    wc.on('context-menu', (_e, params) => this.hooks.contextMenu(itemId, wc, params));
    wc.on('enter-html-full-screen', () => this.hooks.fullscreen(wc, true));
    wc.on('leave-html-full-screen', () => this.hooks.fullscreen(wc, false));
    wc.on('will-navigate', (e) => {
      if (this.hooks.willNavigate(itemId, e.url, wc)) e.preventDefault();
    });
    wc.setWindowOpenHandler(({ url, disposition }) => {
      this.hooks.openFrom(itemId, url, disposition);
      return { action: 'deny' };
    });
    update();
  }
}
