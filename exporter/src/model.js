// @ts-check
// Turns raw Arc files into a plain, browser-agnostic model. See spec/formats/sidebar.md.
import { appleTimeToDate, enumCase, enumPayload, pairs } from './read.js';

/**
 * @typedef {{ type: 'tab', title: string, url: string, createdAt: Date | null, lastActiveAt: Date | null, renamed?: boolean }} TabNode `renamed`: `title` is the user's rename, not the page title.
 * @typedef {{ orientation: 'sideBySide' | 'stacked', sizes: number[] }} SplitLayout `sizes` are fractions aligned with `children`.
 * @typedef {{ type: 'folder' | 'tabGroup' | 'splitView', title: string, createdAt: Date | null, children: Node[], layout?: SplitLayout }} ContainerNode
 * @typedef {{ type: 'other', kind: string, title: string, createdAt: Date | null, ref?: string }} OtherNode `ref`: an Easel's or Note's cloud document ID.
 * @typedef {TabNode | ContainerNode | OtherNode} Node
 * @typedef {{ id: string, title: string, profile: string, icon: string | null, iconKind: 'emoji' | 'symbol' | null, color: string | null, pinned: Node[], today: Node[] }} Space
 *   `icon` is an emoji, or an SF Symbol name when `iconKind` is 'symbol'. `color` is the theme's main color as `#rrggbb`.
 * @typedef {{ profile: string, items: Node[] }} Favorites
 * @typedef {{ archivedAt: Date | null, reason: string, source: string, spaceId: string | null, spaceTitle: string | null, item: Node }} ArchiveEntry
 * @typedef {{ pattern: string, operator: string | null, destination: string }} LinkRoute
 * @typedef {{ spaces: Space[], favorites: Favorites[], archive: ArchiveEntry[], linkRoutes: LinkRoute[] }} ArcModel
 */

const CONTAINER_TYPES = /** @type {const} */ ({ list: 'folder', tabGroup: 'tabGroup', splitView: 'splitView' });

/** `{"default": {}}` / `{"default": true}` → `"default"`; custom profiles → their directory name when present. */
function profileName(profile) {
  const name = enumCase(profile) ?? 'default';
  if (name === 'default') return 'default';
  const payload = enumPayload(profile);
  return (payload && typeof payload === 'object' && payload.directoryBasename) || name;
}

/** @returns {{ icon: string | null, iconKind: 'emoji' | 'symbol' | null }} */
function spaceIcon(iconType) {
  if (!iconType || typeof iconType !== 'object') return { icon: null, iconKind: null };
  if (typeof iconType.emoji_v2 === 'string' && iconType.emoji_v2) return { icon: iconType.emoji_v2, iconKind: 'emoji' };
  if (typeof iconType.emoji === 'number') {
    try {
      return { icon: String.fromCodePoint(iconType.emoji), iconKind: 'emoji' };
    } catch {}
  }
  if (typeof iconType.icon === 'string') return { icon: iconType.icon, iconKind: 'symbol' };
  return { icon: null, iconKind: null };
}

/** The first color in the theme's background (single color or gradient), else its mid-tone. `#rrggbb` or null. */
function themeColor(theme) {
  /** @returns {any} */
  const firstColor = (o, depth = 0) => {
    if (!o || typeof o !== 'object' || depth > 12) return null;
    if (typeof o.red === 'number' && typeof o.green === 'number' && typeof o.blue === 'number') return o;
    for (const v of Object.values(o)) {
      const c = firstColor(v, depth + 1);
      if (c) return c;
    }
    return null;
  };
  const c = firstColor(theme?.background) ?? theme?.primaryColorPalette?.midTone;
  if (!c || typeof c.red !== 'number') return null;
  const hex = (v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0');
  return `#${hex(c.red)}${hex(c.green)}${hex(c.blue)}`;
}

/** The data container that follows the `{"global": {}}` key. Order of containers is not stable. */
function globalContainer(sidebarFile) {
  const containers = sidebarFile?.sidebar?.containers;
  for (const [key, data] of pairs(containers)) {
    if (enumCase(key) === 'global') return data;
  }
  // Very old files: a single unkeyed data container.
  return Array.isArray(containers) ? containers.find((c) => c && Array.isArray(c.items)) ?? null : null;
}

/**
 * Root container IDs of a Space. Prefers `newContainerIDs` (enum keys) over legacy `containerIDs` (string keys).
 * @returns {{ pinned?: string, unpinned?: string }}
 */
function spaceRoots(space) {
  /** @type {Record<string, string>} */
  const roots = {};
  for (const [key, id] of pairs(space.newContainerIDs ?? space.containerIDs)) {
    const name = enumCase(key);
    if (name && typeof id === 'string') roots[name] = id;
  }
  return roots;
}

/**
 * @param {Map<string, any>} items
 * @param {string} id
 * @param {Set<string>} seen guards against cycles in damaged files
 * @returns {Node | null}
 */
function toNode(items, id, seen) {
  const item = items.get(id);
  if (!item || seen.has(id)) return null;
  seen.add(id);
  const kind = enumCase(item.data) ?? 'unknown';
  const createdAt = appleTimeToDate(item.createdAt);

  if (kind === 'tab') {
    const tab = item.data.tab ?? {};
    const url = tab.savedURL ?? '';
    /** @type {TabNode} */
    const node = {
      type: 'tab',
      title: item.title || tab.savedTitle || url,
      url,
      createdAt,
      lastActiveAt: appleTimeToDate(tab.timeLastActiveAt),
    };
    if (item.title) node.renamed = true;
    return node;
  }
  if (kind in CONTAINER_TYPES) {
    const fallback = kind === 'tabGroup' ? item.data.tabGroup?.title : null;
    /** @type {ContainerNode} */
    const node = {
      type: CONTAINER_TYPES[/** @type {keyof typeof CONTAINER_TYPES} */ (kind)],
      title: item.title || fallback || (kind === 'list' ? 'Untitled folder' : kind === 'splitView' ? 'Split View' : 'Tab group'),
      createdAt,
      children: [],
    };
    /** @type {string[]} */
    const kept = [];
    for (const childId of item.childrenIds ?? []) {
      const child = toNode(items, childId, seen);
      if (child) {
        node.children.push(child);
        kept.push(childId);
      }
    }
    if (kind === 'splitView') node.layout = splitLayout(item.data.splitView ?? {}, kept);
    return node;
  }
  /** @type {OtherNode} */
  const other = { type: 'other', kind, title: item.title || item.data?.easel?.title || kind, createdAt };
  const ref = item.data?.easel?.easelID ?? item.data?.arcDocument?.arcDocumentID;
  if (typeof ref === 'string') other.ref = ref;
  return other;
}

/** @returns {Node[]} */
function children(items, item, seen) {
  return (item?.childrenIds ?? [])
    .map((/** @type {string} */ id) => toNode(items, id, seen))
    .filter((/** @type {Node | null} */ n) => n !== null);
}

/**
 * `layoutOrientation` names the axis panes run along: `horizontal` = side by side.
 * `itemWidthFactors` is a keyed array `[childID, fraction, …]`; children it leaves out share what remains.
 * @param {any} split
 * @param {string[]} childIds
 * @returns {SplitLayout}
 */
function splitLayout(split, childIds) {
  const orientation = split.layoutOrientation === 'vertical' ? 'stacked' : 'sideBySide';
  /** @type {Map<string, number>} */
  const factors = new Map();
  for (const [id, f] of pairs(split.itemWidthFactors)) {
    if (typeof id === 'string' && typeof f === 'number' && f > 0) factors.set(id, f);
  }
  const listed = childIds.filter((id) => factors.has(id));
  const rest = Math.max(0, 1 - listed.reduce((sum, id) => sum + /** @type {number} */ (factors.get(id)), 0));
  const unlisted = childIds.length - listed.length;
  // When the listed panes already fill the width, unlisted ones still get an even share before normalizing.
  const share = rest > 0 ? rest / unlisted : 1 / childIds.length;
  const raw = childIds.map((id) => factors.get(id) ?? share);
  const total = raw.reduce((a, b) => a + b, 0);
  const sizes = total > 0 ? raw.map((x) => x / total) : childIds.map(() => 1 / childIds.length);
  return { orientation, sizes };
}

/**
 * @param {{ sidebar: any, archive?: any, linkRouting?: any }} files
 * @returns {ArcModel}
 */
export function buildModel({ sidebar, archive, linkRouting }) {
  const container = globalContainer(sidebar);
  if (!container) throw new Error('StorableSidebar.json has no global sidebar container');

  const items = new Map(pairs(container.items));
  const seen = new Set();

  /** @type {Space[]} */
  const spaces = pairs(container.spaces)
    .map(([, space]) => space)
    .filter((space) => space && typeof space === 'object')
    .map((space) => {
      const roots = spaceRoots(space);
      return {
        id: space.id,
        title: space.title || 'Untitled Space',
        profile: profileName(space.profile),
        ...spaceIcon(space.customInfo?.iconType),
        color: themeColor(space.customInfo?.windowTheme),
        pinned: roots.pinned ? children(items, items.get(roots.pinned), seen) : [],
        today: roots.unpinned ? children(items, items.get(roots.unpinned), seen) : [],
      };
    });

  const order = sidebar?.sidebarSyncState?.container?.value?.orderedSpaceIDs;
  if (Array.isArray(order)) {
    const rank = new Map(order.map((id, i) => [id, i]));
    spaces.sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity));
  }

  /** @type {Favorites[]} */
  const favorites = pairs(container.topAppsContainerIDs).map(([profile, id]) => ({
    profile: profileName(profile),
    items: children(items, items.get(id), seen),
  }));

  const spaceTitles = new Map(spaces.map((s) => [s.id, s.title]));
  /** @type {ArchiveEntry[]} */
  const archiveEntries = pairs(archive?.items)
    .map(([, entry]) => entry)
    .filter((entry) => entry?.sidebarItem)
    .map((entry) => {
      const spaceId = enumCase(entry.source) === 'space' ? enumPayload(entry.source) ?? null : null;
      const single = new Map([[entry.sidebarItem.id, entry.sidebarItem]]);
      return {
        archivedAt: appleTimeToDate(entry.archivedAt),
        reason: entry.reason ?? 'unknown',
        source: enumCase(entry.source) ?? 'unknown',
        spaceId,
        spaceTitle: spaceId ? spaceTitles.get(spaceId) ?? null : null,
        item: /** @type {Node} */ (toNode(single, entry.sidebarItem.id, new Set())),
      };
    })
    .sort((a, b) => (b.archivedAt?.getTime() ?? 0) - (a.archivedAt?.getTime() ?? 0));

  /** @type {LinkRoute[]} */
  const linkRoutes = (linkRouting?.rules ?? []).flatMap((rule) =>
    (rule.sourceComponents ?? [])
      .filter((c) => enumCase(c.componentType) === 'urlMatch')
      .map((c) => {
        const match = c.componentType.urlMatch;
        const dest = rule.destination;
        const destPayload = enumPayload(dest);
        const destSpace = typeof destPayload === 'string' ? spaceTitles.get(destPayload) ?? destPayload : null;
        return {
          pattern: match._1 ?? '',
          operator: enumCase(match._0),
          destination: enumCase(dest) === 'space' ? destSpace ?? 'most recent Space' : enumCase(dest) ?? 'unknown',
        };
      }),
  );

  return { spaces, favorites, archive: archiveEntries, linkRoutes };
}

/** @param {Node[]} nodes */
export function countTabs(nodes) {
  let n = 0;
  for (const node of nodes) n += node.type === 'tab' ? 1 : 'children' in node ? countTabs(node.children) : 0;
  return n;
}
