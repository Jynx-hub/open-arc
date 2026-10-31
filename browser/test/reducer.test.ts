import { describe, expect, it } from 'vitest';
import { fresh, run, tab } from './helpers';
import { isPersistent, sectionOf } from '../src/shared/tree';
import { migrate } from '../src/shared/migrate';
import { STATE_VERSION } from '../src/shared/model';

describe('pinned and Today', () => {
  it('moves a tab across the divider and keeps order', () => {
    let s = run(fresh(), tab('a', 'T1'), tab('b', 'T1'), tab('c', 'T1'));
    s = run(s, { type: 'item.move', id: 'b', parentId: 'P1', index: 0 });
    expect(s.items.T1!.children).toEqual(['a', 'c']);
    expect(s.items.P1!.children).toEqual(['b']);
    expect(sectionOf(s, 'b')).toBe('pinned');
    s = run(s, { type: 'item.move', id: 'a', parentId: 'T1', index: 2 });
    expect(s.items.T1!.children).toEqual(['c', 'a']);
  });

  it('a pinned tab keeps its home URL while navigating; a Today tab follows', () => {
    let s = run(fresh(), tab('p', 'P1', 'https://home.test/'), tab('t', 'T1', 'https://one.test/'));
    s = run(s, { type: 'tab.navigated', id: 'p', url: 'https://elsewhere.test/', title: 'Else' }, { type: 'tab.navigated', id: 't', url: 'https://two.test/', title: 'Two' });
    expect(s.items.p!.tab!.savedURL).toBe('https://home.test/');
    expect(s.items.t!.tab!.savedURL).toBe('https://two.test/');
    s = run(s, { type: 'tab.setHome', id: 'p', url: 'https://elsewhere.test/', title: 'Else' });
    expect(s.items.p!.tab!.savedURL).toBe('https://elsewhere.test/');
    expect(isPersistent(s, 'p')).toBe(true);
    expect(isPersistent(s, 't')).toBe(false);
  });

  it('rename overrides the title and an empty rename clears it', () => {
    let s = run(fresh(), tab('p', 'P1'), { type: 'item.rename', id: 'p', title: '  Mail ' });
    expect(s.items.p!.title).toBe('Mail');
    s = run(s, { type: 'item.rename', id: 'p', title: '' });
    expect(s.items.p!.title).toBeNull();
  });

  it('clear archives every Today item except the kept ones', () => {
    let s = run(fresh(), tab('a', 'T1'), tab('b', 'T1'), tab('c', 'T1'), tab('p', 'P1'));
    s = run(s, { type: 'space.clearToday', spaceId: 'S1', keepIds: ['b'], now: 5000 });
    expect(s.items.T1!.children).toEqual(['b']);
    expect(s.archive.map((e) => e.items[0]!.id).sort()).toEqual(['a', 'c']);
    expect(s.archive.every((e) => e.reason === 'clearButton')).toBe(true);
    expect(s.items.P1!.children).toEqual(['p']);
  });
});

describe('folders, groups, Favorites', () => {
  it('creates a folder around selected items at the first one’s position', () => {
    let s = run(fresh(), tab('a', 'P1'), tab('b', 'P1'), tab('c', 'P1'));
    s = run(s, { type: 'folder.create', id: 'f', parentId: 'P1', childIds: ['b', 'c'], now: 1 });
    expect(s.items.P1!.children).toEqual(['a', 'f']);
    expect(s.items.f!.children).toEqual(['b', 'c']);
  });

  it('refuses to move a folder into its own descendant', () => {
    let s = run(fresh(), { type: 'folder.create', id: 'f', parentId: 'P1', now: 1 }, { type: 'folder.create', id: 'g', parentId: 'f', now: 1 });
    s = run(s, { type: 'item.move', id: 'f', parentId: 'g', index: 0 });
    expect(s.items.f!.parentId).toBe('P1');
  });

  it('Favorites accept tabs only and are shared per Profile', () => {
    let s = run(fresh(), tab('a', 'T1'), { type: 'folder.create', id: 'f', parentId: 'P1', now: 1 });
    s = run(s, { type: 'item.move', id: 'a', parentId: 'F-default', index: 0 }, { type: 'item.move', id: 'f', parentId: 'F-default', index: 0 });
    expect(s.items['F-default']!.children).toEqual(['a']);
    expect(isPersistent(s, 'a')).toBe(true);
  });

  it('an emptied tab group disappears', () => {
    let s = run(fresh(), tab('a', 'T1'), { type: 'group.create', id: 'g', parentId: 'T1', title: 'G', childIds: ['a'], now: 1 });
    expect(s.items.g!.children).toEqual(['a']);
    s = run(s, { type: 'item.move', id: 'a', parentId: 'T1', index: 0 });
    expect(s.items.g).toBeUndefined();
  });
});

describe('Spaces and Profiles', () => {
  it('deleting a Space archives its tabs; the last Space survives', () => {
    let s = run(fresh(), { type: 'space.create', id: 'S2', pinnedRootId: 'P2', todayRootId: 'T2', title: 'Work', icon: null, color: '#000', profileId: 'default', now: 1 }, tab('a', 'P2'), tab('b', 'T2'));
    s = run(s, { type: 'space.delete', id: 'S2', now: 9 });
    expect(s.spaces.map((x) => x.id)).toEqual(['S1']);
    expect(s.archive).toHaveLength(2);
    expect(s.items.P2).toBeUndefined();
    s = run(s, { type: 'space.delete', id: 'S1', now: 9 });
    expect(s.spaces).toHaveLength(1);
  });

  it('a Profile in use or the Default Profile cannot be deleted', () => {
    let s = run(fresh(), { type: 'profile.create', id: 'work', name: 'Work', favoritesRootId: 'F-work', now: 1 });
    s = run(s, { type: 'space.update', id: 'S1', patch: { profileId: 'work' } }, { type: 'profile.delete', id: 'work' }, { type: 'profile.delete', id: 'default' });
    expect(s.profiles.map((p) => p.id)).toEqual(['default', 'work']);
    s = run(s, { type: 'space.update', id: 'S1', patch: { profileId: 'default' } }, { type: 'profile.delete', id: 'work' });
    expect(s.profiles.map((p) => p.id)).toEqual(['default']);
    expect(s.items['F-work']).toBeUndefined();
  });

  it('folder → Space and Space → folder round-trip the items', () => {
    let s = run(fresh(), tab('a', 'P1'), { type: 'folder.create', id: 'f', parentId: 'P1', title: 'Proj', childIds: ['a'], now: 1 });
    s = run(s, { type: 'folder.toSpace', id: 'f', spaceId: 'S2', pinnedRootId: 'P2', todayRootId: 'T2', now: 2 });
    expect(s.spaces.find((x) => x.id === 'S2')!.title).toBe('Proj');
    expect(s.items.P2!.children).toEqual(['a']);
    s = run(s, { type: 'space.toFolder', id: 'S2', targetSpaceId: 'S1', folderId: 'f2', now: 3 });
    expect(s.items.P1!.children).toEqual(['f2']);
    expect(s.items.f2!.children).toEqual(['a']);
  });
});

describe('Split View', () => {
  it('creates, separates one pane, and dissolves below two panes', () => {
    let s = run(fresh(), tab('a', 'T1'), tab('b', 'T1'), tab('c', 'T1'));
    s = run(s, { type: 'split.create', id: 'sp', parentId: 'T1', childIds: ['a', 'b', 'c'], orientation: 'row', now: 1 });
    expect(s.items.T1!.children).toEqual(['sp']);
    expect(s.items.sp!.split!.sizes).toHaveLength(3);
    s = run(s, { type: 'split.separate', id: 'sp', childId: 'c' });
    expect(s.items.T1!.children).toEqual(['sp', 'c']);
    expect(s.items.sp!.split!.sizes).toEqual([0.5, 0.5]);
    s = run(s, { type: 'item.archive', ids: ['b'], reason: 'manual', now: 2 });
    expect(s.items.sp).toBeUndefined();
    expect(s.items.T1!.children).toEqual(['a', 'c']);
  });
});

describe('Archive', () => {
  it('restores a folder with its children into its Space', () => {
    let s = run(fresh(), tab('a', 'T1'), { type: 'folder.create', id: 'f', parentId: 'T1', childIds: ['a'], now: 1 });
    s = run(s, { type: 'item.archive', ids: ['f'], reason: 'manual', now: 7 });
    expect(s.items.f).toBeUndefined();
    expect(s.items.a).toBeUndefined();
    s = run(s, { type: 'archive.restore', entryId: s.archive[0]!.id });
    expect(s.items.T1!.children).toEqual(['f']);
    expect(s.items.f!.children).toEqual(['a']);
    expect(s.archive).toHaveLength(0);
  });
});

describe('review regressions', () => {
  it('a pane joining a Split View resizes every pane equally', () => {
    let s = run(fresh(), tab('a', 'T1'), tab('b', 'T1'), tab('c', 'T1'));
    s = run(s, { type: 'split.create', id: 'sp', parentId: 'T1', childIds: ['a', 'b'], orientation: 'row', now: 1 });
    s = run(s, { type: 'item.move', id: 'c', parentId: 'sp', index: 2 });
    expect(s.items.sp!.split!.sizes.map((x) => +x.toFixed(3))).toEqual([0.333, 0.333, 0.333]);
  });

  it('no-op page events return the same state; untouched slices keep identity', () => {
    const s = run(fresh(), tab('a', 'T1', 'https://a.test/'), { type: 'tab.navigated', id: 'a', url: 'https://a.test/', title: 'A' });
    expect(run(s, { type: 'tab.navigated', id: 'a', url: 'https://a.test/', title: 'A' })).toBe(s);
    const next = run(s, { type: 'history.visit', url: 'https://a.test/', title: 'A', now: 1 });
    expect(next.items).toBe(s.items);
    expect(next.archive).toBe(s.archive);
    expect(next.history).not.toBe(s.history);
  });

  it('clear then restoring entries in Archive order puts Today back as it was', () => {
    let s = run(fresh(), tab('a', 'T1'), tab('b', 'T1'), tab('c', 'T1'));
    s = run(s, { type: 'item.move', id: 'a', parentId: 'T1', index: 0 }, { type: 'item.move', id: 'c', parentId: 'T1', index: 2 });
    const before = [...s.items.T1!.children];
    s = run(s, { type: 'space.clearToday', spaceId: 'S1', keepIds: [], now: 9 });
    for (const e of s.archive.filter((x) => x.archivedAt === 9)) s = run(s, { type: 'archive.restore', entryId: e.id });
    expect(s.items.T1!.children).toEqual(before);
  });
});

describe('state migrations', () => {
  it('v1 → v2 gives every Easel a scene, including archived ones', () => {
    const s = fresh();
    const v1 = structuredClone(s) as any;
    v1.version = 1;
    v1.items.e1 = { id: 'e1', parentId: null, children: [], title: null, createdAt: 0, kind: 'easel', easel: { scene: null } };
    v1.archive.push({ id: 'a', archivedAt: 0, reason: 'manual', source: { kind: 'unknown' }, items: [{ id: 'e2', parentId: null, children: [], title: null, createdAt: 0, kind: 'easel', easel: { scene: null } }] });
    const out = migrate(v1);
    expect(out.version).toBe(STATE_VERSION);
    expect(out.items.e1!.easel).toEqual({ scene: { shapes: [] } });
    expect(out.archive[0]!.items[0]!.easel).toEqual({ scene: { shapes: [] } });
  });
});

