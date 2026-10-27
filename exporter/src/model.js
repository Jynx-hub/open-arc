// @ts-check
// Turns raw Arc files into a plain, browser-agnostic model. See spec/formats/sidebar.md.
import { appleTimeToDate, enumCase, enumPayload, pairs } from './read.js';

/**
 * @typedef {{ type: 'tab', title: string, url: string, createdAt: Date | null, lastActiveAt: Date | null }} TabNode
 * @typedef {{ type: 'folder' | 'tabGroup' | 'splitView', title: string, createdAt: Date | null, children: Node[] }} ContainerNode
 * @typedef {{ type: 'other', kind: string, title: string, createdAt: Date | null }} OtherNode
 * @typedef {TabNode | ContainerNode | OtherNode} Node
 * @typedef {{ id: string, title: string, profile: string, icon: string | null, pinned: Node[], today: Node[] }} Space
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
    return {
      type: 'tab',
      title: item.title || tab.savedTitle || url,
      url,
      createdAt,
      lastActiveAt: appleTimeToDate(tab.timeLastActiveAt),
    };
  }
  if (kind in CONTAINER_TYPES) {
    const fallback = kind === 'tabGroup' ? item.data.tabGroup?.title : null;
    return {
      type: CONTAINER_TYPES[/** @type {keyof typeof CONTAINER_TYPES} */ (kind)],
      title: item.title || fallback || (kind === 'list' ? 'Untitled folder' : kind === 'splitView' ? 'Split View' : 'Tab group'),
      createdAt,
      children: children(items, item, seen),
    };
  }
  return { type: 'other', kind, title: item.title || kind, createdAt };
}

/** @returns {Node[]} */
function children(items, item, seen) {
  return (item?.childrenIds ?? [])
    .map((/** @type {string} */ id) => toNode(items, id, seen))
    .filter((/** @type {Node | null} */ n) => n !== null);
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
        icon: space.customInfo?.iconType?.icon ?? space.customInfo?.iconType?.emoji ?? null,
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
