// First-launch import: Arc's on-disk files → our State, via the arc-export model (../../../exporter).
// Only arc-export's ALLOWED_FILES are ever read.
// @ts-ignore: plain JS module with JSDoc types
import { buildModel } from '../../../exporter/src/model.js';
// @ts-ignore: plain JS module with JSDoc types
import { readArcFile } from '../../../exporter/src/read.js';
import { DEFAULT_PROFILE_ID, STATE_VERSION, defaultSettings, type ArchiveEntry, type ArchiveReason, type Item, type LinkRule, type State } from './model';

type Node =
  | { type: 'tab'; title: string; url: string; createdAt: Date | null; lastActiveAt: Date | null }
  | { type: 'folder' | 'tabGroup' | 'splitView'; title: string; createdAt: Date | null; children: Node[] }
  | { type: 'other'; kind: string; title: string; createdAt: Date | null };
interface ArcModel {
  spaces: { id: string; title: string; profile: string; icon: string | null; pinned: Node[]; today: Node[] }[];
  favorites: { profile: string; items: Node[] }[];
  archive: { archivedAt: Date | null; reason: string; source: string; spaceId: string | null; item: Node | null }[];
  linkRoutes: { pattern: string; operator: string | null; destination: string }[];
}

export interface ImportSummary {
  spaces: number;
  tabs: number;
  favorites: number;
  archived: number;
  linkRules: number;
  skipped: string[];
}

const SPACE_COLORS = ['#5b6cff', '#e8590c', '#2f9e44', '#c2255c', '#1098ad', '#7048e8', '#f08c00'];
const ARCHIVE_REASONS: ArchiveReason[] = ['auto', 'manual', 'clearButton', 'clearTabGroup'];

export function readArcModel(arcDir: string): ArcModel {
  const sidebar = readArcFile(arcDir, 'sidebar');
  if (!sidebar) throw new Error(`No StorableSidebar.json in ${arcDir}`);
  return buildModel({ sidebar, archive: readArcFile(arcDir, 'archive'), linkRouting: readArcFile(arcDir, 'linkRouting') });
}

/** Builds a fresh State from an Arc model. `newId` is injected so tests are deterministic. */
export function stateFromArc(model: ArcModel, newId: () => string, now: number): { state: State; summary: ImportSummary } {
  const summary: ImportSummary = { spaces: 0, tabs: 0, favorites: 0, archived: 0, linkRules: 0, skipped: [] };
  const state: State = {
    version: STATE_VERSION,
    profiles: [],
    spaces: [],
    items: {},
    favorites: {},
    archive: [],
    linkRules: [],
    boosts: [],
    settings: defaultSettings(),
    ranking: { picks: {}, visits: {} },
    history: [],
  };
  const t = (d: Date | null) => d?.getTime() ?? now;

  const ensureProfile = (name: string) => {
    const id = name === 'default' ? DEFAULT_PROFILE_ID : `p-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    if (!state.profiles.some((p) => p.id === id)) {
      state.profiles.push({ id, name: name === 'default' ? 'Default' : name });
      const fav = newId();
      state.items[fav] = { id: fav, parentId: null, children: [], title: null, createdAt: now, kind: 'root', root: { kind: 'favorites', profileId: id } };
      state.favorites[id] = fav;
      state.settings.autoArchive[id] = 'twentyFourHours';
    }
    return id;
  };

  /** Adds `node` (and its children) to state under `parentId`; returns the new id or null if skipped. */
  const add = (node: Node, parentId: string | null, store: Record<string, Item>, counts = true): string | null => {
    const id = newId();
    const base = { id, parentId, children: [] as string[], title: null as string | null, createdAt: t(node.createdAt) };
    if (node.type === 'tab') {
      store[id] = { ...base, kind: 'tab', tab: { savedURL: node.url, savedTitle: node.title, lastActiveAt: t(node.lastActiveAt) } };
      if (counts) summary.tabs += 1;
      return id;
    }
    if (node.type === 'other') {
      summary.skipped.push(node.kind);
      return null;
    }
    const kind = node.type === 'folder' ? 'folder' : node.type === 'tabGroup' ? 'group' : 'split';
    const item: Item = { ...base, kind, title: node.title };
    store[id] = item;
    item.children = node.children.map((c) => add(c, id, store, counts)).filter((c): c is string => c !== null);
    if (kind === 'split') {
      item.title = null;
      item.split = { orientation: 'row', sizes: item.children.map(() => 1 / Math.max(1, item.children.length)) };
    }
    return id;
  };

  ensureProfile('default');
  model.spaces.forEach((sp, i) => {
    const profileId = ensureProfile(sp.profile);
    const pinnedRootId = newId();
    const todayRootId = newId();
    state.items[pinnedRootId] = { id: pinnedRootId, parentId: null, children: [], title: null, createdAt: now, kind: 'root', root: { kind: 'pinned', spaceId: sp.id } };
    state.items[todayRootId] = { id: todayRootId, parentId: null, children: [], title: null, createdAt: now, kind: 'root', root: { kind: 'today', spaceId: sp.id } };
    state.items[pinnedRootId]!.children = sp.pinned.map((n) => add(n, pinnedRootId, state.items)).filter((x): x is string => !!x);
    state.items[todayRootId]!.children = sp.today.map((n) => add(n, todayRootId, state.items)).filter((x): x is string => !!x);
    state.spaces.push({ id: sp.id, title: sp.title, icon: null, color: SPACE_COLORS[i % SPACE_COLORS.length]!, profileId, pinnedRootId, todayRootId });
    summary.spaces += 1;
  });

  for (const fav of model.favorites) {
    const root = state.items[state.favorites[ensureProfile(fav.profile)]!]!;
    for (const node of fav.items) {
      // Favorites hold tabs only; folders there are flattened.
      for (const tab of flattenTabs(node)) {
        const id = add(tab, root.id, state.items, false);
        if (id) {
          root.children.push(id);
          summary.favorites += 1;
        }
      }
    }
  }

  for (const entry of model.archive) {
    if (!entry.item) continue;
    const store: Record<string, Item> = {};
    const rootId = add(entry.item, null, store, false);
    if (!rootId) continue;
    const items = orderSubtree(store, rootId);
    const reason = (ARCHIVE_REASONS as string[]).includes(entry.reason) ? (entry.reason as ArchiveReason) : 'manual';
    const archivedAt = t(entry.archivedAt);
    const source: ArchiveEntry['source'] =
      entry.source === 'space' && entry.spaceId ? { kind: 'space', spaceId: entry.spaceId } : entry.source === 'littleArc' ? { kind: 'littleArc' } : { kind: 'unknown' };
    state.archive.push({ id: `${rootId}@${archivedAt}`, archivedAt, reason, source, items });
    summary.archived += 1;
  }

  for (const route of model.linkRoutes) {
    if (!route.pattern) continue;
    const space = state.spaces.find((s) => s.title === route.destination || s.id === route.destination);
    const destination: LinkRule['destination'] = space
      ? { kind: 'space', spaceId: space.id }
      : route.destination === 'littleArc'
        ? { kind: 'littleArc' }
        : { kind: 'recentSpace' };
    state.linkRules.push({ id: newId(), pattern: route.pattern, destination });
    summary.linkRules += 1;
  }

  if (state.spaces.length === 0) throw new Error('The Arc sidebar has no Spaces to import');
  return { state, summary };
}

function flattenTabs(node: Node): Node[] {
  if (node.type === 'tab') return [node];
  if (node.type === 'other') return [];
  return node.children.flatMap(flattenTabs);
}

function orderSubtree(store: Record<string, Item>, rootId: string): Item[] {
  const out: Item[] = [];
  const walk = (id: string) => {
    const item = store[id];
    if (!item) return;
    out.push(item);
    item.children.forEach(walk);
  };
  walk(rootId);
  return out;
}
