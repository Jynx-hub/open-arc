// Read-only helpers over the flat item tree (parentId + ordered children).
import type { Item, RootKind, Space, State } from './model';

export function rootOf(state: State, id: string): Item | null {
  let item = state.items[id];
  const seen = new Set<string>();
  while (item && item.parentId && !seen.has(item.id)) {
    seen.add(item.id);
    item = state.items[item.parentId];
  }
  return item?.kind === 'root' ? item : null;
}

export function sectionOf(state: State, id: string): RootKind | null {
  return rootOf(state, id)?.root?.kind ?? null;
}

/** Pinned tabs and Favorites keep their home URL and unload instead of closing. */
export function isPersistent(state: State, id: string): boolean {
  const section = sectionOf(state, id);
  return section === 'pinned' || section === 'favorites';
}

export function spaceOf(state: State, id: string): Space | null {
  const root = rootOf(state, id);
  const spaceId = root?.root?.spaceId;
  return spaceId ? state.spaces.find((s) => s.id === spaceId) ?? null : null;
}

/** `id` followed by all its descendants, depth first, in display order. */
export function subtree(state: State, id: string): Item[] {
  const out: Item[] = [];
  const walk = (itemId: string) => {
    const item = state.items[itemId];
    if (!item || out.includes(item)) return;
    out.push(item);
    item.children.forEach(walk);
  };
  walk(id);
  return out;
}

export function tabsIn(state: State, id: string): Item[] {
  return subtree(state, id).filter((i) => i.kind === 'tab');
}

export function isAncestor(state: State, ancestorId: string, id: string): boolean {
  let cur = state.items[id];
  const seen = new Set<string>();
  while (cur?.parentId && !seen.has(cur.id)) {
    if (cur.parentId === ancestorId) return true;
    seen.add(cur.id);
    cur = state.items[cur.parentId];
  }
  return false;
}

/** Every tab in every Space plus Favorites, for the Command Bar and the archiver. */
export function allTabs(state: State): Item[] {
  return Object.values(state.items).filter((i) => i.kind === 'tab' && rootOf(state, i.id) !== null);
}

export function countTabs(state: State, rootId: string): number {
  return tabsIn(state, rootId).length;
}
