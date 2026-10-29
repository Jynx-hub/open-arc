// First-launch import: Arc's on-disk files → our State, via the arc-export model (../../../exporter).
// Only arc-export's ALLOWED_FILES are ever read.
// @ts-ignore: plain JS module with JSDoc types
import { buildModel } from '../../../exporter/src/model.js';
// @ts-ignore: plain JS module with JSDoc types
import { readArcFile } from '../../../exporter/src/read.js';
// @ts-ignore: plain JS module with JSDoc types
import { EASEL_WIDTH as EASEL_WIDTH_JS, HEADING_SIZES as HEADING_SIZES_JS } from '../../../exporter/src/cloudFormats.js';

/** Arc stores Easel rects as fractions of the canvas width; laid out on the same canvas as arc-export's SVGs. */
const EASEL_WIDTH: number = EASEL_WIDTH_JS;
const HEADING_SIZES: Record<string, number> = HEADING_SIZES_JS;
import { DEFAULT_PROFILE_ID, STATE_VERSION, defaultSettings, type ArchiveEntry, type ArchiveReason, type Boost, type EaselScene, type HistoryEntry, type Item, type LinkRule, type State } from './model';

type Node =
  | { type: 'tab'; title: string; url: string; createdAt: Date | null; lastActiveAt: Date | null; renamed?: boolean }
  | { type: 'folder' | 'tabGroup' | 'splitView'; title: string; createdAt: Date | null; children: Node[]; layout?: { orientation: 'sideBySide' | 'stacked'; sizes: number[] } }
  | { type: 'other'; kind: string; title: string; createdAt: Date | null; ref?: string };
interface ArcModel {
  spaces: { id: string; title: string; profile: string; icon: string | null; iconKind?: 'emoji' | 'symbol' | null; color?: string | null; pinned: Node[]; today: Node[] }[];
  favorites: { profile: string; items: Node[] }[];
  archive: { archivedAt: Date | null; reason: string; source: string; spaceId: string | null; item: Node | null }[];
  linkRoutes: { pattern: string; operator: string | null; destination: string }[];
}

/** arc-export's Firestore cache model (exporter/src/firestore.js). */
export interface CloudModel {
  boosts: {
    id: string;
    host: string;
    enabled: boolean;
    name: string;
    colorScheme: { hue: number; saturation: number; secondaryHueOffset: number; invertLightness: boolean } | null;
    zaps: unknown[];
  }[];
  easels: {
    id: string;
    title: string;
    objects: { rect: { x: number; y: number; width: number; height: number }; kind: string; text?: string; style?: Record<string, unknown> }[];
  }[];
}

export interface ImportSummary {
  spaces: number;
  tabs: number;
  favorites: number;
  archived: number;
  linkRules: number;
  boosts: number;
  easels: number;
  history: number;
  skipped: string[];
}


const SPACE_COLORS = ['#5b6cff', '#e8590c', '#2f9e44', '#c2255c', '#1098ad', '#7048e8', '#f08c00'];
/** Space icons that are SF Symbol names in Arc; we draw emoji. Unknown symbols fall back to no icon. */
const SYMBOL_EMOJI: Record<string, string> = {
  planet: '🪐', globe: '🌐', house: '🏠', briefcase: '💼', book: '📖', star: '⭐', heart: '❤️', bolt: '⚡️', flame: '🔥',
  leaf: '🍃', moon: '🌙', sun: '☀️', cloud: '☁️', music: '🎵', gamecontroller: '🎮', cart: '🛒', bag: '👜', camera: '📷',
  paintbrush: '🖌️', pencil: '✏️', hammer: '🔨', wrench: '🔧', graduationcap: '🎓', building: '🏢', airplane: '✈️', car: '🚗',
  flag: '🚩', bell: '🔔', person: '👤', terminal: '💻', laptopcomputer: '💻', desktopcomputer: '🖥️', chart: '📈', dollarsign: '💲',
};
const ARCHIVE_REASONS: ArchiveReason[] = ['auto', 'manual', 'clearButton', 'clearTabGroup'];

export function readArcModel(arcDir: string): ArcModel {
  const sidebar = readArcFile(arcDir, 'sidebar');
  if (!sidebar) throw new Error(`No StorableSidebar.json in ${arcDir}`);
  return buildModel({ sidebar, archive: readArcFile(arcDir, 'archive'), linkRouting: readArcFile(arcDir, 'linkRouting') });
}

/** Builds a fresh State from an Arc model. `newId` is injected so tests are deterministic. */
export interface HistoryRow {
  url: string;
  title: string | null;
  visits: number;
  lastVisitAt: number;
}

/** One entry per URL (newest visit, highest count across sources), newest first, capped at `limit`. */
export function historyFromRows(rows: HistoryRow[], limit: number): HistoryEntry[] {
  const byUrl = new Map<string, HistoryEntry>();
  for (const r of rows) {
    const prev = byUrl.get(r.url);
    const lastVisitAt = Number(r.lastVisitAt);
    if (!prev) byUrl.set(r.url, { url: r.url, title: r.title || r.url, lastVisitAt, visits: Number(r.visits) });
    else {
      if (lastVisitAt > prev.lastVisitAt) Object.assign(prev, { lastVisitAt, title: r.title || prev.title });
      prev.visits = Math.max(prev.visits, Number(r.visits));
    }
  }
  return [...byUrl.values()].sort((a, b) => b.lastVisitAt - a.lastVisitAt).slice(0, limit);
}

/** Arc Boosts keep their id (prefixed) so re-importing replaces them instead of duplicating. */
export function boostsFromCloud(cloud: CloudModel): Boost[] {
  return cloud.boosts.map((b) => ({
    id: `arc-${b.id}`,
    name: b.name,
    host: b.host,
    enabled: b.enabled,
    css: '',
    js: '',
    // Zap entries haven't been sampled yet; keep only ones that are plain selectors.
    zapped: b.zaps.filter((z): z is string => typeof z === 'string'),
    font: null,
    color: null,
    colorScheme: b.colorScheme && { hue: b.colorScheme.hue, saturation: b.colorScheme.saturation, secondaryHueOffset: b.colorScheme.secondaryHueOffset, invertLightness: b.colorScheme.invertLightness },
  }));
}

/** Text objects become text shapes in z order (the cloud model is already sorted); other kinds are reported in `skipped`. */
export function easelScene(easel: CloudModel['easels'][number], skipped: string[]): EaselScene {
  const scene: EaselScene = { shapes: [] };
  for (const o of easel.objects) {
    if (o.kind !== 'text' || !o.text) {
      if (o.kind !== 'text') skipped.push(`easel:${o.kind}`);
      continue;
    }
    const style = o.style ?? {};
    const size = HEADING_SIZES[String(style.paragraphStyle)] ?? 18;
    const family = String(style.fontFamily ?? '');
    scene.shapes.push({
      kind: 'text',
      x: o.rect.x * EASEL_WIDTH,
      y: o.rect.y * EASEL_WIDTH + size,
      w: o.rect.width * EASEL_WIDTH,
      text: o.text,
      color: '#222222',
      size,
      font: /mono|code/.test(family) ? 'ui-monospace, monospace' : /serif|classic/.test(family) ? 'Georgia, serif' : 'system-ui, sans-serif',
    });
  }
  return scene;
}

export function stateFromArc(model: ArcModel, newId: () => string, now: number, cloud: CloudModel = { boosts: [], easels: [] }): { state: State; summary: ImportSummary } {
  const summary: ImportSummary = { spaces: 0, tabs: 0, favorites: 0, archived: 0, linkRules: 0, boosts: 0, easels: 0, history: 0, skipped: [] };
  const easels = new Map(cloud.easels.map((e) => [e.id, e]));
  const placedEasels = new Set<string>();
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
      store[id] = { ...base, kind: 'tab', title: node.renamed ? node.title : null, tab: { savedURL: node.url, savedTitle: node.title, lastActiveAt: t(node.lastActiveAt) } };
      if (counts) summary.tabs += 1;
      return id;
    }
    if (node.type === 'other' && node.kind === 'easel') {
      const cached = node.ref ? easels.get(node.ref) : undefined;
      if (node.ref) placedEasels.add(node.ref);
      store[id] = { ...base, kind: 'easel', title: cached?.title || node.title, easel: { scene: cached ? easelScene(cached, summary.skipped) : { shapes: [] } }, lastActiveAt: base.createdAt };
      if (counts) summary.easels += 1;
      return id;
    }
    if (node.type === 'other') {
      summary.skipped.push(node.kind);
      return null;
    }
    const kind = node.type === 'folder' ? 'folder' : node.type === 'tabGroup' ? 'group' : 'split';
    const item: Item = { ...base, kind, title: node.title };
    store[id] = item;
    const sizes: number[] = [];
    node.children.forEach((c, i) => {
      const childId = add(c, id, store, counts);
      if (childId === null) return;
      item.children.push(childId);
      sizes.push(node.layout?.sizes[i] ?? 1);
    });
    if (kind === 'split') {
      item.title = null;
      const total = sizes.reduce((a, b) => a + b, 0) || 1;
      item.split = { orientation: node.layout?.orientation === 'stacked' ? 'column' : 'row', sizes: sizes.map((s) => s / total) };
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
    const icon = sp.iconKind === 'symbol' ? (SYMBOL_EMOJI[(sp.icon ?? '').split('.')[0]!] ?? null) : sp.icon;
    state.spaces.push({ id: sp.id, title: sp.title, icon, color: sp.color ?? SPACE_COLORS[i % SPACE_COLORS.length]!, profileId, pinnedRootId, todayRootId });
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

  // Cached Easels the sidebar no longer shows: keep them, archived, so they appear in Library.
  for (const easel of cloud.easels) {
    if (placedEasels.has(easel.id)) continue;
    const id = newId();
    const item: Item = { id, parentId: null, children: [], title: easel.title || null, createdAt: now, kind: 'easel', easel: { scene: easelScene(easel, summary.skipped) }, lastActiveAt: now };
    state.archive.push({ id: `${id}@${now}`, archivedAt: now, reason: 'manual', source: { kind: 'unknown' }, items: [item] });
    summary.easels += 1;
  }

  state.boosts = boostsFromCloud(cloud);
  summary.boosts = state.boosts.length;

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
