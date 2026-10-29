// The contract between the main process and the sidebar UI (exposed as `window.openArc` by the preload).
import type { Action } from './reducer';
import type { State } from './model';

export interface LiveTab {
  url: string;
  title: string;
  favicon: string | null;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  audible: boolean;
  muted: boolean;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Snapshot {
  rect: Rect;
  dataURL: string;
}

export interface WindowInfo {
  id: number;
  kind: 'main' | 'little';
  spaceId: string;
  selectedId: string | null;
  sidebarHidden: boolean;
  /** Pictures of the page while an overlay hides the live views. */
  snapshots: Snapshot[] | null;
  peek: { url: string; title: string } | null;
  /** Little Arc: the page shown in this window (not part of any Space). */
  little: { url: string; title: string } | null;
  zoom: number;
}

export type OpenWhere = 'newTab' | 'current' | 'split' | 'peek' | 'littleArc';

export type Command =
  | { type: 'ready' }
  | { type: 'select'; id: string }
  | { type: 'switchSpace'; spaceId: string }
  | { type: 'open'; url: string; where: OpenWhere; parentId?: string }
  | { type: 'navigate'; op: 'back' | 'forward' | 'reload' | 'stop' }
  | { type: 'close'; id: string }
  | { type: 'unload'; id: string }
  | { type: 'goHome'; id: string }
  | { type: 'setHomeToCurrent'; id: string }
  | { type: 'overlay'; open: boolean }
  | { type: 'contextMenu'; target: ContextTarget }
  | { type: 'runAction'; id: string }
  | { type: 'search'; query: string }
  | { type: 'pickResult'; query: string; key: string }
  | { type: 'importArc'; dir?: string }
  | { type: 'peek'; op: 'close' | 'expand' }
  | { type: 'little'; op: 'moveToSpace'; spaceId: string }
  | { type: 'splitWith'; id: string; url?: string; withId?: string; side?: 'before' | 'after' }
  | { type: 'capture'; rect?: Rect }
  | { type: 'exportBoost'; id: string }
  | { type: 'setDefaultBrowser' }
  | { type: 'liveFolderRefresh'; id: string };

export type ContextTarget =
  | { kind: 'item'; id: string }
  | { kind: 'space'; id: string }
  | { kind: 'section'; spaceId: string; section: 'pinned' | 'today' }
  | { kind: 'favorites' };

export interface SearchResult {
  key: string;
  kind: 'tab' | 'history' | 'archive' | 'search' | 'url' | 'action' | 'siteSearch' | 'space';
  title: string;
  subtitle: string;
  /** What picking it does. */
  run: Command | { type: 'renderer'; action: string };
  favicon?: string | null;
}

/** Events the main process pushes to a window's UI. */
export interface UiEvents {
  /** Only the top-level slices that changed. */
  state: Partial<State>;
  window: WindowInfo;
  live: Record<string, LiveTab>;
  /** A menu or shortcut action the UI handles (open Command Bar, start rename, …). */
  action: { id: string; arg?: string };
  toast: { message: string; actionLabel?: string; command?: Command };
}

export interface Api {
  getState(): Promise<State>;
  getWindow(): Promise<WindowInfo>;
  getLive(): Promise<Record<string, LiveTab>>;
  dispatch(action: Action): void;
  command<T = unknown>(command: Command): Promise<T>;
  setContentBounds(rect: Rect): void;
  find(text: string, opts?: { forward?: boolean; findNext?: boolean }): Promise<void>;
  captures(): Promise<{ name: string; path: string; createdAt: number }[]>;
  on<K extends keyof UiEvents>(event: K, cb: (payload: UiEvents[K]) => void): () => void;
}
