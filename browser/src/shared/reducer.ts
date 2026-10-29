// The only way state changes. Pure: ids and timestamps come in on the action, so tests are deterministic.
import {
  DEFAULT_PROFILE_ID,
  DOWNLOADS_LIMIT,
  STATE_VERSION,
  defaultSettings,
  type ArchiveEntry,
  type ArchiveReason,
  type ArchiveSource,
  type Boost,
  type DownloadEntry,
  type EaselScene,
  type Item,
  type LinkRule,
  type PermissionDecision,
  type Settings,
  type Space,
  type SplitOrientation,
  type State,
} from './model';
import { isAncestor, isPersistent, rootOf, sectionOf, spaceOf, subtree } from './tree';

export const HISTORY_LIMIT = 5000;
const VISITS_PER_KEY = 20;

export type Action =
  | { type: 'state.replace'; state: State }
  | { type: 'space.create'; id: string; pinnedRootId: string; todayRootId: string; title: string; icon: string | null; color: string; profileId: string; now: number }
  | { type: 'space.update'; id: string; patch: Partial<Pick<Space, 'title' | 'icon' | 'color' | 'profileId' | 'pinnedCollapsed'>> }
  | { type: 'space.move'; id: string; index: number }
  | { type: 'space.delete'; id: string; now: number }
  | { type: 'space.toFolder'; id: string; targetSpaceId: string; folderId: string; now: number }
  | { type: 'folder.toSpace'; id: string; spaceId: string; pinnedRootId: string; todayRootId: string; now: number }
  | { type: 'profile.create'; id: string; name: string; favoritesRootId: string; now: number }
  | { type: 'profile.rename'; id: string; name: string }
  | { type: 'profile.delete'; id: string }
  | { type: 'tab.create'; id: string; parentId: string; index?: number; url: string; title?: string; now: number }
  | { type: 'tab.navigated'; id: string; url: string; title: string; faviconURL?: string | null }
  | { type: 'tab.setHome'; id: string; url: string; title: string }
  | { type: 'tab.touch'; id: string; now: number }
  | { type: 'item.move'; id: string; parentId: string; index: number }
  | { type: 'item.rename'; id: string; title: string | null }
  | { type: 'item.toggleCollapsed'; id: string }
  | { type: 'item.markRead'; id: string }
  | { type: 'folder.create'; id: string; parentId: string; index?: number; title?: string; childIds?: string[]; now: number }
  | { type: 'group.create'; id: string; parentId: string; index?: number; title: string; childIds: string[]; now: number }
  | { type: 'split.create'; id: string; parentId: string; index?: number; childIds: string[]; orientation: SplitOrientation; now: number }
  | { type: 'split.update'; id: string; orientation?: SplitOrientation; sizes?: number[] }
  | { type: 'split.separate'; id: string; childId?: string }
  | { type: 'note.create'; id: string; parentId: string; index?: number; now: number }
  | { type: 'note.update'; id: string; markdown: string }
  | { type: 'easel.create'; id: string; parentId: string; index?: number; now: number }
  | { type: 'easel.update'; id: string; scene: EaselScene }
  | { type: 'item.archive'; ids: string[]; reason: ArchiveReason; now: number; source?: ArchiveSource }
  | { type: 'space.clearToday'; spaceId: string; keepIds: string[]; now: number }
  | { type: 'archive.restore'; entryId: string }
  | { type: 'archive.delete'; entryId: string }
  | { type: 'archive.clear' }
  | { type: 'settings.update'; patch: Partial<Settings> }
  /** `decision: null` forgets the saved answer, so the site asks again. */
  | { type: 'sitePermission.set'; origin: string; permission: string; decision: PermissionDecision | null }
  | { type: 'download.upsert'; entry: DownloadEntry }
  | { type: 'download.remove'; id: string }
  /** Clear finished downloads: a private window's (`privateId` = its partition), else the normal ones. */
  | { type: 'download.clear'; privateId?: string }
  | { type: 'linkRule.upsert'; rule: LinkRule }
  | { type: 'linkRule.remove'; id: string }
  | { type: 'linkRule.move'; id: string; index: number }
  | { type: 'boost.upsert'; boost: Boost }
  | { type: 'boost.remove'; id: string }
  | { type: 'ranking.pick'; query: string; key: string; now: number }
  | { type: 'history.visit'; url: string; title: string; now: number }
  | { type: 'liveFolder.set'; id: string; feed: string; kind: 'rss' | 'github' }
  | { type: 'liveFolder.sync'; id: string; entries: { id: string; url: string; title: string }[]; now: number };

export function initialState(now: number, ids: { space: string; pinned: string; today: string; favorites: string }): State {
  const state: State = {
    version: STATE_VERSION,
    profiles: [{ id: DEFAULT_PROFILE_ID, name: 'Default' }],
    spaces: [],
    items: {},
    favorites: {},
    archive: [],
    linkRules: [],
    boosts: [],
    settings: defaultSettings(),
    ranking: { picks: {}, visits: {} },
    history: [],
    downloads: [],
  };
  state.items[ids.favorites] = rootItem(ids.favorites, now, { kind: 'favorites', profileId: DEFAULT_PROFILE_ID });
  state.favorites[DEFAULT_PROFILE_ID] = ids.favorites;
  createSpace(state, { id: ids.space, pinnedRootId: ids.pinned, todayRootId: ids.today, title: 'Personal', icon: null, color: '#5b6cff', profileId: DEFAULT_PROFILE_ID, now });
  return state;
}

/** Which top-level slices an action may change. Only those are copied, so the big ones (history,
 * archive) aren't cloned on every tab event, and unchanged slices keep their identity. */
function touches(a: Action): (keyof State)[] {
  switch (a.type) {
    case 'history.visit': return ['history'];
    case 'ranking.pick': return ['ranking'];
    case 'settings.update': case 'sitePermission.set': return ['settings'];
    case 'download.upsert': case 'download.remove': case 'download.clear': return ['downloads'];
    case 'linkRule.upsert': case 'linkRule.remove': case 'linkRule.move': return ['linkRules'];
    case 'boost.upsert': case 'boost.remove': return ['boosts'];
    case 'archive.delete': case 'archive.clear': return ['archive'];
    case 'item.archive': case 'space.clearToday': case 'archive.restore': return ['items', 'archive'];
    case 'space.delete': return ['items', 'archive', 'spaces', 'linkRules'];
    case 'space.update': case 'space.move': return ['spaces'];
    case 'space.create': case 'space.toFolder': case 'folder.toSpace': return ['items', 'spaces'];
    case 'profile.create': case 'profile.delete': return ['profiles', 'items', 'favorites', 'settings'];
    case 'profile.rename': return ['profiles'];
    default: return ['items'];
  }
}

export function reduce(prev: State, action: Action): State {
  if (action.type === 'state.replace') return action.state;
  if (isNoop(prev, action)) return prev;
  const s: State = { ...prev };
  for (const key of touches(action)) (s as unknown as Record<string, unknown>)[key] = structuredClone(prev[key]);
  apply(s, action);
  return s;
}

/** Frequent page events that often change nothing; skipping them avoids a state broadcast and a save. */
function isNoop(s: State, a: Action): boolean {
  if (a.type === 'tab.navigated') {
    const tab = s.items[a.id]?.tab;
    if (!tab) return true;
    if (a.faviconURL !== undefined && a.faviconURL !== (tab.faviconURL ?? null)) return false;
    return isPersistent(s, a.id) ? !!tab.savedTitle || a.url !== tab.savedURL : tab.savedURL === a.url && tab.savedTitle === a.title;
  }
  if (a.type === 'item.markRead') return !s.items[a.id]?.isUnread;
  if (a.type === 'tab.touch' || a.type === 'tab.setHome') return !s.items[a.id];
  return false;
}

function apply(s: State, a: Action): void {
  switch (a.type) {
    case 'state.replace':
      return;

    case 'space.create':
      createSpace(s, a);
      return;
    case 'space.update': {
      const space = s.spaces.find((x) => x.id === a.id);
      if (!space) return;
      if (a.patch.profileId && !s.profiles.some((p) => p.id === a.patch.profileId)) return;
      Object.assign(space, a.patch);
      return;
    }
    case 'space.move': {
      const from = s.spaces.findIndex((x) => x.id === a.id);
      if (from < 0) return;
      const [space] = s.spaces.splice(from, 1);
      s.spaces.splice(clamp(a.index, 0, s.spaces.length), 0, space!);
      return;
    }
    case 'space.delete': {
      // The last Space can't be deleted. Its tabs go to the Archive.
      if (s.spaces.length <= 1) return;
      const space = s.spaces.find((x) => x.id === a.id);
      if (!space) return;
      const top = [...childrenOf(s, space.pinnedRootId), ...childrenOf(s, space.todayRootId)];
      archive(s, top, 'manual', a.now, { kind: 'space', spaceId: space.id });
      removeSubtree(s, space.pinnedRootId);
      removeSubtree(s, space.todayRootId);
      s.spaces = s.spaces.filter((x) => x.id !== a.id);
      s.linkRules = s.linkRules.filter((r) => !(r.destination.kind === 'space' && r.destination.spaceId === a.id));
      return;
    }
    case 'space.toFolder': {
      if (a.id === a.targetSpaceId || s.spaces.length <= 1) return;
      const space = s.spaces.find((x) => x.id === a.id);
      const target = s.spaces.find((x) => x.id === a.targetSpaceId);
      if (!space || !target) return;
      const kids = [...childrenOf(s, space.pinnedRootId), ...childrenOf(s, space.todayRootId)];
      s.items[a.folderId] = newItem(a.folderId, 'folder', target.pinnedRootId, a.now, space.title);
      s.items[target.pinnedRootId]!.children.push(a.folderId);
      for (const id of kids) moveItem(s, id, a.folderId, Infinity);
      delete s.items[space.pinnedRootId];
      delete s.items[space.todayRootId];
      s.spaces = s.spaces.filter((x) => x.id !== a.id);
      return;
    }
    case 'folder.toSpace': {
      const folder = s.items[a.id];
      const from = spaceOf(s, a.id);
      if (!folder || folder.kind !== 'folder' || !from) return;
      createSpace(s, { id: a.spaceId, pinnedRootId: a.pinnedRootId, todayRootId: a.todayRootId, title: folder.title || 'New Space', icon: null, color: from.color, profileId: from.profileId, now: a.now });
      for (const id of [...folder.children]) moveItem(s, id, a.pinnedRootId, Infinity);
      detach(s, a.id);
      delete s.items[a.id];
      return;
    }

    case 'profile.create':
      if (s.profiles.some((p) => p.id === a.id)) return;
      s.profiles.push({ id: a.id, name: a.name });
      s.items[a.favoritesRootId] = rootItem(a.favoritesRootId, a.now, { kind: 'favorites', profileId: a.id });
      s.favorites[a.id] = a.favoritesRootId;
      s.settings.autoArchive[a.id] = s.settings.autoArchive[DEFAULT_PROFILE_ID] ?? 'twentyFourHours';
      return;
    case 'profile.rename': {
      const p = s.profiles.find((x) => x.id === a.id);
      if (p && a.name.trim()) p.name = a.name.trim();
      return;
    }
    case 'profile.delete': {
      // The Default Profile always exists; a Profile still assigned to a Space can't be deleted.
      if (a.id === DEFAULT_PROFILE_ID || s.spaces.some((x) => x.profileId === a.id)) return;
      const fav = s.favorites[a.id];
      if (fav) removeSubtree(s, fav);
      delete s.favorites[a.id];
      delete s.settings.autoArchive[a.id];
      s.profiles = s.profiles.filter((p) => p.id !== a.id);
      return;
    }

    case 'tab.create': {
      if (!s.items[a.parentId] || s.items[a.id]) return;
      const item = newItem(a.id, 'tab', a.parentId, a.now, null);
      item.tab = { savedURL: a.url, savedTitle: a.title ?? '', lastActiveAt: a.now };
      s.items[a.id] = item;
      insertChild(s, a.parentId, a.id, a.index ?? Infinity);
      return;
    }
    case 'tab.navigated': {
      const tab = s.items[a.id]?.tab;
      if (!tab) return;
      if (a.faviconURL !== undefined) tab.faviconURL = a.faviconURL;
      if (isPersistent(s, a.id)) {
        // The home URL stays; only fill in a title the import didn't have.
        if (!tab.savedTitle && a.url === tab.savedURL) tab.savedTitle = a.title;
      } else {
        tab.savedURL = a.url;
        tab.savedTitle = a.title;
      }
      return;
    }
    case 'tab.setHome': {
      const tab = s.items[a.id]?.tab;
      if (!tab) return;
      tab.savedURL = a.url;
      tab.savedTitle = a.title;
      return;
    }
    case 'tab.touch': {
      const item = s.items[a.id];
      if (item?.tab) item.tab.lastActiveAt = a.now;
      else if (item) item.lastActiveAt = a.now;
      return;
    }

    case 'item.move':
      moveItem(s, a.id, a.parentId, a.index);
      return;
    case 'item.rename': {
      const item = s.items[a.id];
      if (item && item.kind !== 'root') item.title = a.title?.trim() || null;
      return;
    }
    case 'item.toggleCollapsed': {
      const item = s.items[a.id];
      if (item) item.collapsed = !item.collapsed;
      return;
    }

    case 'item.markRead': {
      const item = s.items[a.id];
      if (item) delete item.isUnread;
      return;
    }

    case 'folder.create':
      createContainer(s, newItem(a.id, 'folder', a.parentId, a.now, a.title ?? null), a.index, a.childIds ?? []);
      return;
    case 'group.create': {
      const item = newItem(a.id, 'group', a.parentId, a.now, a.title);
      createContainer(s, item, a.index, a.childIds);
      return;
    }
    case 'split.create': {
      const tabs = a.childIds.filter((id) => s.items[id]?.kind === 'tab');
      if (tabs.length < 2) return;
      const item = newItem(a.id, 'split', a.parentId, a.now, null);
      item.split = { orientation: a.orientation, sizes: tabs.map(() => 1 / tabs.length) };
      createContainer(s, item, a.index, tabs);
      return;
    }
    case 'split.update': {
      const split = s.items[a.id]?.split;
      if (!split) return;
      if (a.orientation) split.orientation = a.orientation;
      if (a.sizes) split.sizes = normalizeSizes(a.sizes);
      return;
    }
    case 'split.separate': {
      const split = s.items[a.id];
      if (!split || split.kind !== 'split' || !split.parentId) return;
      const parent = split.parentId;
      const at = s.items[parent]!.children.indexOf(split.id) + 1;
      const out = a.childId ? [a.childId] : [...split.children];
      out.forEach((id, i) => moveItem(s, id, parent, at + i));
      return;
    }

    case 'note.create': {
      const item = newItem(a.id, 'note', a.parentId, a.now, null);
      item.note = { markdown: '' };
      createContainer(s, item, a.index, []);
      return;
    }
    case 'note.update': {
      const item = s.items[a.id];
      if (item?.note) item.note.markdown = a.markdown;
      return;
    }
    case 'easel.create': {
      const item = newItem(a.id, 'easel', a.parentId, a.now, null);
      item.easel = { scene: { shapes: [] } };
      createContainer(s, item, a.index, []);
      return;
    }
    case 'easel.update': {
      const item = s.items[a.id];
      if (item?.easel) item.easel.scene = a.scene;
      return;
    }

    case 'item.archive':
      archive(s, a.ids, a.reason, a.now, a.source);
      return;
    case 'space.clearToday': {
      const space = s.spaces.find((x) => x.id === a.spaceId);
      if (!space) return;
      const ids = childrenOf(s, space.todayRootId).filter((id) => !a.keepIds.some((k) => k === id || isAncestor(s, id, k)));
      archive(s, ids, 'clearButton', a.now, { kind: 'space', spaceId: space.id });
      return;
    }
    case 'archive.restore': {
      const entry = s.archive.find((e) => e.id === a.entryId);
      if (!entry || !entry.items[0]) return;
      const space = (entry.source.kind === 'space' && s.spaces.find((x) => x.id === (entry.source as { spaceId: string }).spaceId)) || s.spaces[0];
      if (!space) return;
      for (const item of entry.items) if (!s.items[item.id]) s.items[item.id] = structuredClone(item);
      const root = s.items[entry.items[0].id]!;
      root.parentId = space.todayRootId;
      s.items[space.todayRootId]!.children.unshift(root.id);
      s.archive = s.archive.filter((e) => e.id !== a.entryId);
      return;
    }
    case 'archive.delete':
      s.archive = s.archive.filter((e) => e.id !== a.entryId);
      return;
    case 'archive.clear':
      s.archive = [];
      return;

    case 'settings.update':
      Object.assign(s.settings, a.patch);
      return;
    case 'sitePermission.set': {
      const site = { ...s.settings.sitePermissions[a.origin] };
      if (a.decision) site[a.permission] = a.decision;
      else delete site[a.permission];
      if (Object.keys(site).length) s.settings.sitePermissions[a.origin] = site;
      else delete s.settings.sitePermissions[a.origin];
      return;
    }
    case 'download.upsert': {
      const i = s.downloads.findIndex((d) => d.id === a.entry.id);
      if (i >= 0) s.downloads[i] = a.entry;
      else {
        s.downloads.unshift(a.entry);
        // Over the cap, the oldest finished entries go first; a running download is never dropped.
        for (let j = s.downloads.length - 1; j >= 0 && s.downloads.length > DOWNLOADS_LIMIT; j--) {
          if (s.downloads[j]!.state !== 'progressing') s.downloads.splice(j, 1);
        }
      }
      return;
    }
    case 'download.remove':
      s.downloads = s.downloads.filter((d) => d.id !== a.id);
      return;
    case 'download.clear':
      s.downloads = s.downloads.filter((d) => d.state === 'progressing' || (a.privateId ? d.profileId !== a.privateId : !!d.private));
      return;
    case 'linkRule.upsert': {
      const i = s.linkRules.findIndex((r) => r.id === a.rule.id);
      if (i >= 0) s.linkRules[i] = a.rule;
      else s.linkRules.push(a.rule);
      return;
    }
    case 'linkRule.remove':
      s.linkRules = s.linkRules.filter((r) => r.id !== a.id);
      return;
    case 'linkRule.move': {
      const from = s.linkRules.findIndex((r) => r.id === a.id);
      if (from < 0) return;
      const [rule] = s.linkRules.splice(from, 1);
      s.linkRules.splice(clamp(a.index, 0, s.linkRules.length), 0, rule!);
      return;
    }
    case 'boost.upsert': {
      const i = s.boosts.findIndex((b) => b.id === a.boost.id);
      if (i >= 0) s.boosts[i] = a.boost;
      else s.boosts.push(a.boost);
      return;
    }
    case 'boost.remove':
      s.boosts = s.boosts.filter((b) => b.id !== a.id);
      return;

    case 'ranking.pick': {
      const q = a.query.trim().toLowerCase();
      if (q) {
        const forQuery = (s.ranking.picks[q] ??= {});
        forQuery[a.key] = (forQuery[a.key] ?? 0) + 1;
      }
      const visits = (s.ranking.visits[a.key] ??= []);
      visits.push(a.now);
      if (visits.length > VISITS_PER_KEY) visits.splice(0, visits.length - VISITS_PER_KEY);
      return;
    }
    case 'history.visit': {
      if (!/^https?:/.test(a.url)) return;
      const existing = s.history.find((h) => h.url === a.url);
      if (existing) {
        existing.visits += 1;
        existing.lastVisitAt = a.now;
        if (a.title) existing.title = a.title;
      } else {
        s.history.push({ url: a.url, title: a.title, lastVisitAt: a.now, visits: 1 });
        if (s.history.length > HISTORY_LIMIT) {
          s.history.sort((x, y) => y.lastVisitAt - x.lastVisitAt);
          s.history.length = HISTORY_LIMIT;
        }
      }
      return;
    }

    case 'liveFolder.set': {
      const item = s.items[a.id];
      if (item?.kind === 'folder') item.live = { feed: a.feed, kind: a.kind, lastFetchedAt: null };
      return;
    }
    case 'liveFolder.sync': {
      // Keep tabs whose URL is still in the feed (and their place); add new ones on top; drop the rest.
      const folder = s.items[a.id];
      if (!folder?.live) return;
      const byUrl = new Map(folder.children.map((id) => [s.items[id]?.tab?.savedURL, id]));
      const keep = new Set<string>();
      const order: string[] = [];
      for (const e of a.entries) {
        const existing = byUrl.get(e.url);
        if (existing) {
          keep.add(existing);
          order.push(existing);
        } else if (!s.items[e.id]) {
          const item = newItem(e.id, 'tab', folder.id, a.now, null);
          item.tab = { savedURL: e.url, savedTitle: e.title, lastActiveAt: a.now };
          item.isUnread = true;
          s.items[e.id] = item;
          order.push(e.id);
        }
      }
      for (const id of folder.children) if (!keep.has(id)) for (const i of subtree(s, id)) delete s.items[i.id];
      folder.children = order;
      folder.live.lastFetchedAt = a.now;
      return;
    }
  }
}

// ── helpers (mutate the draft) ──────────────────────────────────────────────

function newItem(id: string, kind: Item['kind'], parentId: string | null, now: number, title: string | null): Item {
  return { id, parentId, children: [], title, createdAt: now, kind };
}

function rootItem(id: string, now: number, root: NonNullable<Item['root']>): Item {
  return { ...newItem(id, 'root', null, now, null), root };
}

function createSpace(s: State, a: { id: string; pinnedRootId: string; todayRootId: string; title: string; icon: string | null; color: string; profileId: string; now: number }) {
  if (s.spaces.some((x) => x.id === a.id) || !s.profiles.some((p) => p.id === a.profileId)) return;
  s.items[a.pinnedRootId] = rootItem(a.pinnedRootId, a.now, { kind: 'pinned', spaceId: a.id });
  s.items[a.todayRootId] = rootItem(a.todayRootId, a.now, { kind: 'today', spaceId: a.id });
  s.spaces.push({ id: a.id, title: a.title, icon: a.icon, color: a.color, profileId: a.profileId, pinnedRootId: a.pinnedRootId, todayRootId: a.todayRootId });
}

function childrenOf(s: State, id: string): string[] {
  return [...(s.items[id]?.children ?? [])];
}

function insertChild(s: State, parentId: string, id: string, index: number) {
  const parent = s.items[parentId]!;
  parent.children.splice(clamp(index, 0, parent.children.length), 0, id);
  // A pane joining a Split View gets an equal share.
  if (parent.split) parent.split.sizes = normalizeSizes(parent.children.map(() => 1));
}

function detach(s: State, id: string) {
  const item = s.items[id];
  if (!item?.parentId) return;
  const parent = s.items[item.parentId];
  if (parent) parent.children = parent.children.filter((c) => c !== id);
  item.parentId = null;
}

/** Container kinds that can hold a given child. Favorites hold tabs only; a Split holds tabs only. */
function accepts(s: State, parent: Item, child: Item): boolean {
  if (child.kind === 'root') return false;
  if (parent.kind === 'split' || sectionOf(s, parent.id) === 'favorites') return child.kind === 'tab';
  if (parent.kind === 'group') return child.kind === 'tab' || child.kind === 'split';
  return parent.kind === 'root' || parent.kind === 'folder';
}

function moveItem(s: State, id: string, parentId: string, index: number) {
  const item = s.items[id];
  const parent = s.items[parentId];
  if (!item || !parent || id === parentId || isAncestor(s, id, parentId) || !accepts(s, parent, item)) return;
  const oldParent = item.parentId;
  if (oldParent === parentId) {
    const from = parent.children.indexOf(id);
    if (from >= 0 && from < index) index -= 1;
  }
  detach(s, id);
  item.parentId = parentId;
  insertChild(s, parentId, id, index);
  if (oldParent) cleanupContainer(s, oldParent);
}

function createContainer(s: State, item: Item, index: number | undefined, childIds: string[]) {
  const parent = s.items[item.parentId!];
  if (!parent || s.items[item.id] || !accepts(s, parent, item)) return;
  // A new container goes where its first selected child was.
  const firstChild = childIds.map((id) => s.items[id]).find((c) => c?.parentId === item.parentId);
  const at = index ?? (firstChild ? parent.children.indexOf(firstChild.id) : Infinity);
  s.items[item.id] = item;
  insertChild(s, parent.id, item.id, at);
  childIds.forEach((cid, i) => moveItem(s, cid, item.id, i));
}

/** Splits dissolve when fewer than two panes remain (the spec's "zombie" cleanup); empty groups go away. */
function cleanupContainer(s: State, id: string) {
  const item = s.items[id];
  if (!item) return;
  if (item.kind === 'split') {
    if (item.split) item.split.sizes = normalizeSizes(item.children.map(() => 1));
    if (item.children.length < 2 && item.parentId) {
      const parent = item.parentId;
      const at = s.items[parent]!.children.indexOf(id);
      for (const child of [...item.children]) moveItem(s, child, parent, at);
      detach(s, id);
      delete s.items[id];
    }
  } else if (item.kind === 'group' && item.children.length === 0) {
    detach(s, id);
    delete s.items[id];
  }
}

function removeSubtree(s: State, id: string) {
  const parent = s.items[id]?.parentId;
  for (const item of subtree(s, id)) delete s.items[item.id];
  if (parent && s.items[parent]) {
    s.items[parent]!.children = s.items[parent]!.children.filter((c) => c !== id);
    cleanupContainer(s, parent);
  }
}

function archive(s: State, ids: string[], reason: ArchiveReason, now: number, source?: ArchiveSource) {
  for (const id of ids) {
    const item = s.items[id];
    if (!item || item.kind === 'root' || !rootOf(s, id)) continue;
    const space = spaceOf(s, id);
    const entry: ArchiveEntry = {
      id: `${id}@${now}`,
      archivedAt: now,
      reason,
      source: source ?? (space ? { kind: 'space', spaceId: space.id } : { kind: 'unknown' }),
      items: subtree(s, id).map((i) => structuredClone(i)),
    };
    entry.items[0]!.parentId = null;
    s.archive.unshift(entry);
    removeSubtree(s, id);
  }
}

function normalizeSizes(sizes: number[]): number[] {
  const clean = sizes.map((x) => (Number.isFinite(x) && x > 0 ? x : 0.0001));
  const total = clean.reduce((a, b) => a + b, 0);
  return clean.map((x) => x / total);
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}
