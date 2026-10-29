import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { boostsFromCloud, historyFromRows, readArcModel, stateFromArc, type CloudModel } from '../src/shared/importArc';
import { boostCss } from '../src/main/boosts';
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

  it('merges history across sources: newest visit wins, capped', () => {
    const h = historyFromRows(
      [
        { url: 'https://a.example/', title: 'A old', visits: 3, lastVisitAt: 100 },
        { url: 'https://a.example/', title: 'A new', visits: 1, lastVisitAt: 300 },
        { url: 'https://b.example/', title: '', visits: 2, lastVisitAt: 200 },
        { url: 'https://c.example/', title: 'C', visits: 1, lastVisitAt: 50 },
      ],
      2,
    );
    expect(h).toEqual([
      { url: 'https://a.example/', title: 'A new', visits: 3, lastVisitAt: 300 },
      { url: 'https://b.example/', title: 'https://b.example/', visits: 2, lastVisitAt: 200 },
    ]);
  });

  it('imports Space icons and theme colors', () => {
    let n = 0;
    const { state } = stateFromArc(readArcModel(FIXTURES), () => `id${n++}`, 0);
    const by = (title: string) => state.spaces.find((s) => s.title === title)!;
    expect([by('Work').icon, by('Home').icon, by('Home').color]).toEqual(['💼', '🏡', '#4e3a5a']);
  });

  it('keeps Split View orientation and pane widths', () => {
    let n = 0;
    const { state } = stateFromArc(readArcModel(FIXTURES), () => `id${n++}`, 0);
    const split = Object.values(state.items).find((i) => i.kind === 'split');
    expect(split?.children).toHaveLength(2);
    expect(split?.split?.orientation).toBe('row');
    expect(split?.split?.sizes.map((s) => Math.round(s * 100) / 100)).toEqual([0.3, 0.7]);
  });

  const cloud: CloudModel = {
    boosts: [{ id: 'B1', host: 'docs.example.com', enabled: true, name: '', colorScheme: { hue: 270, saturation: 1, secondaryHueOffset: 45, invertLightness: false }, zaps: ['.ad', { unknown: 1 }] }],
    easels: [
      { id: 'E1', title: 'Plan', objects: [{ kind: 'text', text: 'Hello', rect: { x: 0.2, y: 0.035, width: 0.6, height: 0.07 }, style: { paragraphStyle: 'h2', fontFamily: 'clean' } }, { kind: 'image', rect: { x: 0, y: 0, width: 0.1, height: 0.1 } }] },
      { id: 'E2', title: 'Old', objects: [] },
    ],
  };

  it('imports cached Easels into the sidebar and archives the rest', () => {
    const model = readArcModel(FIXTURES);
    model.spaces[0]!.pinned.push({ type: 'other', kind: 'easel', title: 'easel', createdAt: null, ref: 'E1' });
    let n = 0;
    const { state, summary } = stateFromArc(model, () => `id${n++}`, 0, cloud);
    const easel = Object.values(state.items).find((i) => i.kind === 'easel')!;
    expect(easel.parentId).toBe(state.spaces[0]!.pinnedRootId);
    expect(easel.title).toBe('Plan');
    expect(easel.easel?.scene.shapes).toEqual([{ kind: 'text', x: 200, y: 65, w: 600, text: 'Hello', color: '#222222', size: 30, font: 'system-ui, sans-serif' }]);
    expect(summary.skipped).toContain('easel:image');
    const archived = state.archive.flatMap((e) => e.items).filter((i) => i.kind === 'easel');
    expect(archived.map((i) => i.title)).toEqual(['Old']);
    expect(summary.easels).toBe(2);
    expect(summary.boosts).toBe(1);
  });

  it('maps Arc Boosts with stable ids and a color-wheel recolor', () => {
    const [b] = boostsFromCloud(cloud);
    expect(b).toMatchObject({ id: 'arc-B1', host: 'docs.example.com', enabled: true, zapped: ['.ad'] });
    const css = boostCss(b!);
    expect(css).toContain('mix-blend-mode: color');
    expect(css).toContain('hsl(270 100% 50%), hsl(315 100% 50%)');
    expect(css).toContain('.ad { display: none !important; }');
    expect(css).not.toContain('invert(1)');
  });
});
