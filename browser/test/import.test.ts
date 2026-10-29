import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { readArcModel, stateFromArc } from '../src/shared/importArc';
import { tabsIn } from '../src/shared/tree';

const FIXTURES = path.resolve(__dirname, '../../exporter/test/fixtures/arc');

describe('Arc import', () => {
  it('maps the arc-export model into Spaces, Favorites, Archive and link rules', () => {
    let n = 0;
    const { state, summary } = stateFromArc(readArcModel(FIXTURES), () => `id${n++}`, 0);
    expect(summary.spaces).toBe(state.spaces.length);
    expect(summary.spaces).toBeGreaterThan(0);
    const tabCount = state.spaces.reduce((acc, sp) => acc + tabsIn(state, sp.pinnedRootId).length + tabsIn(state, sp.todayRootId).length, 0);
    expect(tabCount).toBe(summary.tabs);
    for (const sp of state.spaces) {
      expect(state.profiles.some((p) => p.id === sp.profileId)).toBe(true);
      expect(state.favorites[sp.profileId]).toBeDefined();
    }
    for (const item of Object.values(state.items)) {
      for (const c of item.children) expect(state.items[c]!.parentId).toBe(item.id);
    }
    expect(state.archive.length).toBe(summary.archived);
  });
});
