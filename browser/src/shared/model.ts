// App state. Our own model, shaped by the rebuild notes in ../../spec/features/*.md.
// Every change goes through `reduce` in ./reducer.ts; the main process owns the only copy.

export const STATE_VERSION = 4;
export const DEFAULT_PROFILE_ID = 'default';

/** Auto-archive thresholds (spec/features/auto-archive-and-archive.md), in ms. `never` = no auto-archive. */
export const ARCHIVE_THRESHOLDS = {
  twentySeconds: 20_000,
  oneHour: 3_600_000,
  sixHours: 6 * 3_600_000,
  twelveHours: 12 * 3_600_000,
  twentyFourHours: 24 * 3_600_000,
  sevenDays: 7 * 24 * 3_600_000,
  thirtyDays: 30 * 24 * 3_600_000,
  never: Infinity,
} as const;
export type ArchiveThreshold = keyof typeof ARCHIVE_THRESHOLDS;

export interface Profile {
  id: string;
  name: string;
}

export interface Space {
  id: string;
  title: string;
  /** An emoji or a short glyph we draw ourselves. */
  icon: string | null;
  /** Theme accent as a CSS color. */
  color: string;
  profileId: string;
  pinnedRootId: string;
  todayRootId: string;
  pinnedCollapsed?: boolean;
}

export type RootKind = 'pinned' | 'today' | 'favorites';

export interface TabData {
  /** Home URL. For pinned tabs and Favorites it stays put while the live page navigates. */
  savedURL: string;
  savedTitle: string;
  lastActiveAt: number;
  faviconURL?: string | null;
}

export type SplitOrientation = 'row' | 'column';

export interface Item {
  id: string;
  parentId: string | null;
  children: string[];
  /** User rename; overrides the page title when set. */
  title: string | null;
  createdAt: number;
  kind: 'root' | 'tab' | 'folder' | 'group' | 'split' | 'note' | 'easel';
  root?: { kind: RootKind; spaceId?: string; profileId?: string };
  tab?: TabData;
  collapsed?: boolean;
  split?: { orientation: SplitOrientation; sizes: number[] };
  /** Notes are local Markdown; Easels are a scene JSON. Stored inline. */
  note?: { markdown: string };
  easel?: { scene: EaselScene };
  live?: { feed: string; kind: 'rss' | 'github'; lastFetchedAt: number | null };
  /** Notes and Easels: last time the user was in them (tabs keep theirs in `tab`). */
  lastActiveAt?: number;
  /** Live Folder entries the user hasn't opened yet. */
  isUnread?: boolean;
}

export type ArchiveReason = 'auto' | 'manual' | 'clearButton' | 'clearTabGroup';
export type ArchiveSource = { kind: 'space'; spaceId: string } | { kind: 'littleArc' } | { kind: 'unknown' };

export interface ArchiveEntry {
  id: string;
  archivedAt: number;
  reason: ArchiveReason;
  source: ArchiveSource;
  /** The archived item and its descendants, detached from the tree. `items[0]` is the root. */
  items: Item[];
}

export interface LinkRule {
  id: string;
  /** Substring match against the full URL (the `contains` operator). */
  pattern: string;
  destination: { kind: 'space'; spaceId: string } | { kind: 'recentSpace' } | { kind: 'littleArc' };
}

export interface SiteSearch {
  keyword: string;
  name: string;
  /** `%s` is replaced with the encoded query. */
  template: string;
}

/** A local Easel canvas. Text `y` is the baseline; `w` wraps text, `size`/`font` default to 18px system-ui. */
export type EaselShape =
  | { kind: 'stroke'; color: string; width: number; points: [number, number][] }
  | { kind: 'text'; x: number; y: number; text: string; color: string; w?: number; size?: number; font?: string }
  | { kind: 'image'; x: number; y: number; w: number; h: number; src: string };

export interface EaselScene {
  shapes: EaselShape[];
}

/** Color-wheel recolor settings (imported from Arc Boosts; see spec/formats/cloud-cache.md). */
export interface BoostColorScheme {
  hue: number;
  /** 0–1 */
  saturation: number;
  secondaryHueOffset: number;
  invertLightness: boolean;
}

export interface Boost {
  id: string;
  name: string;
  host: string;
  enabled: boolean;
  css: string;
  js: string;
  /** CSS selectors hidden with `display:none` ("zap"). */
  zapped: string[];
  font: string | null;
  color: string | null;
  colorScheme?: BoostColorScheme | null;
}

export interface Settings {
  autoArchive: Record<string, ArchiveThreshold>;
  littleArcArchive: ArchiveThreshold;
  searchTemplate: string;
  siteSearches: SiteSearch[];
  peekFromPinned: boolean;
  peekOnShiftClick: boolean;
  defaultLinkDestination: LinkRule['destination'];
  showSpaceHeader: boolean;
  /** action id → accelerator; overrides of the default keymap. `null` = unset. */
  keyOverrides: Record<string, string | null>;
  seenArchiveEducation: boolean;
  /** origin → permission → saved answer. "Allow once" is never saved. */
  sitePermissions: Record<string, Record<string, PermissionDecision>>;
  /** A playing video moves into a floating Picture in Picture window when you switch away from its tab. */
  autoPictureInPicture: boolean;
}

export type PermissionDecision = 'allow' | 'deny';

export const DOWNLOADS_LIMIT = 200;

export interface DownloadEntry {
  id: string;
  url: string;
  filename: string;
  /** Where the file is (or will be) saved. Empty until the user picks a place in a save dialog. */
  path: string;
  mime: string;
  totalBytes: number;
  receivedBytes: number;
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted';
  paused?: boolean;
  startedAt: number;
  endedAt: number | null;
  profileId: string;
  /** From a private window: never written to disk, and dropped when that window closes. */
  private?: boolean;
}

/** Command Bar learning (spec/features/command-bar.md › Ranking). */
export interface Ranking {
  /** normalized query → result key → times picked */
  picks: Record<string, Record<string, number>>;
  /** result key → visit timestamps (most recent last, capped) */
  visits: Record<string, number[]>;
}

export interface HistoryEntry {
  url: string;
  title: string;
  lastVisitAt: number;
  visits: number;
}

export interface State {
  version: number;
  profiles: Profile[];
  spaces: Space[];
  items: Record<string, Item>;
  /** profileId → Favorites root item id. Favorites belong to the Profile, not the Space. */
  favorites: Record<string, string>;
  archive: ArchiveEntry[];
  linkRules: LinkRule[];
  boosts: Boost[];
  settings: Settings;
  ranking: Ranking;
  history: HistoryEntry[];
  /** Newest first, capped at DOWNLOADS_LIMIT. */
  downloads: DownloadEntry[];
}

export const DEFAULT_SITE_SEARCHES: SiteSearch[] = [
  { keyword: 'wiki', name: 'Wikipedia', template: 'https://en.wikipedia.org/w/index.php?search=%s' },
  { keyword: 'yt', name: 'YouTube', template: 'https://www.youtube.com/results?search_query=%s' },
  { keyword: 'gh', name: 'GitHub', template: 'https://github.com/search?q=%s' },
  { keyword: 'maps', name: 'Google Maps', template: 'https://www.google.com/maps/search/%s' },
  { keyword: 'mdn', name: 'MDN', template: 'https://developer.mozilla.org/en-US/search?q=%s' },
  { keyword: 'npm', name: 'npm', template: 'https://www.npmjs.com/search?q=%s' },
];

export function defaultSettings(): Settings {
  return {
    autoArchive: { [DEFAULT_PROFILE_ID]: 'twentyFourHours' },
    littleArcArchive: 'twelveHours',
    searchTemplate: 'https://www.google.com/search?q=%s',
    siteSearches: DEFAULT_SITE_SEARCHES.map((s) => ({ ...s })),
    peekFromPinned: true,
    peekOnShiftClick: true,
    defaultLinkDestination: { kind: 'littleArc' },
    showSpaceHeader: true,
    keyOverrides: {},
    seenArchiveEducation: false,
    sitePermissions: {},
    autoPictureInPicture: true,
  };
}

/** Display title: the user's rename wins, then the saved page title, then the URL. */
export function itemTitle(item: Item): string {
  if (item.title) return item.title;
  if (item.tab) return item.tab.savedTitle || item.tab.savedURL;
  switch (item.kind) {
    case 'folder': return 'New Folder';
    case 'group': return 'Tab Group';
    case 'split': return 'Split';
    case 'note': return 'Untitled Note';
    case 'easel': return 'Untitled Easel';
    default: return '';
  }
}
