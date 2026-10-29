// A private (incognito) window's tabs. They live only in memory, in a session of their own, and never
// reach State: no sidebar items, no history, no Archive. Closing the window throws all of it away.
import { WebContentsView, type ContextMenuParams, type Session, type WebContents } from 'electron';
import { randomUUID } from 'node:crypto';
import type { PrivateTab } from '../shared/ipc';
import { QUIET, privateSession } from './profiles';

export interface PrivateHooks {
  /** Tabs, the selection, or a tab's title/URL/loading state changed. */
  changed(): void;
  contextMenu(wc: WebContents, params: ContextMenuParams): void;
  domReady(wc: WebContents): void;
  fullscreen(wc: WebContents, on: boolean): void;
}

interface Entry {
  id: string;
  view: WebContentsView;
}

export class PrivateTabs {
  readonly ses: Session;
  readonly partition: string;
  private entries: Entry[] = [];
  selectedId: string | null = null;

  constructor(private hooks: PrivateHooks) {
    ({ ses: this.ses, partition: this.partition } = privateSession());
  }

  create(url: string, { select = true } = {}): string {
    const id = randomUUID();
    const view = new WebContentsView({ webPreferences: { session: this.ses, sandbox: true, contextIsolation: true, nodeIntegration: false, disableHtmlFullscreenWindowResize: QUIET } });
    view.setBorderRadius(8);
    view.setBackgroundColor('#ffffff');
    this.entries.unshift({ id, view });
    this.wire(view.webContents);
    void view.webContents.loadURL(url).catch(() => {});
    if (select) this.selectedId = id;
    this.hooks.changed();
    return id;
  }

  has(id: string) {
    return this.entries.some((e) => e.id === id);
  }

  select(id: string) {
    if (!this.has(id)) return;
    this.selectedId = id;
    this.hooks.changed();
  }

  selected(): WebContentsView | null {
    return this.entries.find((e) => e.id === this.selectedId)?.view ?? null;
  }

  ids(): string[] {
    return this.entries.map((e) => e.id);
  }

  close(id: string) {
    const i = this.entries.findIndex((e) => e.id === id);
    if (i < 0) return;
    const [entry] = this.entries.splice(i, 1);
    if (this.selectedId === id) this.selectedId = (this.entries[i] ?? this.entries[i - 1])?.id ?? null;
    entry!.view.webContents.close();
    this.hooks.changed();
  }

  tabs(): PrivateTab[] {
    return this.entries.map(({ id, view }) => {
      const wc = view.webContents;
      return {
        id,
        url: wc.getURL(),
        title: wc.getTitle(),
        loading: wc.isLoading(),
        canGoBack: wc.navigationHistory.canGoBack(),
        canGoForward: wc.navigationHistory.canGoForward(),
      };
    });
  }

  /** Close every page and wipe the session (it is in memory only, but cookies would last until quit). */
  async destroy() {
    for (const { view } of this.entries.splice(0)) if (!view.webContents.isDestroyed()) view.webContents.close();
    this.selectedId = null;
    await this.ses.clearStorageData().catch(() => {});
    await this.ses.clearCache().catch(() => {});
  }

  private wire(wc: WebContents) {
    const changed = () => !wc.isDestroyed() && this.hooks.changed();
    for (const event of ['did-start-loading', 'did-stop-loading', 'did-navigate', 'did-navigate-in-page', 'page-title-updated'] as const) {
      wc.on(event as 'did-start-loading', changed);
    }
    wc.on('dom-ready', () => this.hooks.domReady(wc));
    wc.on('context-menu', (_e, params) => this.hooks.contextMenu(wc, params));
    wc.on('enter-html-full-screen', () => this.hooks.fullscreen(wc, true));
    wc.on('leave-html-full-screen', () => this.hooks.fullscreen(wc, false));
    // Links that ask for a new tab or window open as another private tab here, never in a normal window.
    wc.setWindowOpenHandler(({ url, disposition }) => {
      this.create(url, { select: disposition !== 'background-tab' });
      return { action: 'deny' };
    });
  }
}
