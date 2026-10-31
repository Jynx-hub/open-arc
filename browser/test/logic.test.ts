import { describe, expect, it } from 'vitest';
import { fresh, run, tab } from './helpers';
import { search, looksLikeURL, matchScore } from '../src/shared/search';
import { routeExternalUrl } from '../src/shared/routing';
import { dueForArchive } from '../src/shared/archiver';
import { acceleratorFor, arcChordToAccelerator } from '../src/shared/keymap';
import { parseFeed } from '../src/main/liveFolders';

describe('Command Bar search', () => {
  it('recognizes addresses but not phrases', () => {
    expect(looksLikeURL('example.com')).toBe('https://example.com');
    expect(looksLikeURL('localhost:3000/x')).toBe('http://localhost:3000/x');
    expect(looksLikeURL('how to cook')).toBeNull();
    expect(looksLikeURL('notes.txt is')).toBeNull();
  });

  it('ranks prefix over word-prefix over substring', () => {
    expect(matchScore('GitHub', 'git')).toBeGreaterThan(matchScore('My GitHub', 'git'));
    expect(matchScore('My GitHub', 'git')).toBeGreaterThan(matchScore('legit', 'git'));
  });

  it('offers open tabs, site search and a web search, and learns from picks', () => {
    let s = run(fresh(), tab('a', 'T1', 'https://docs.example.com/'), tab('b', 'T1', 'https://dogs.example.org/'));
    s = run(s, { type: 'item.rename', id: 'a', title: 'Docs' }, { type: 'item.rename', id: 'b', title: 'Dogs' });
    let r = search(s, {}, 'do', 'S1', 0);
    expect(r[0]!.kind).toBe('tab');
    expect(r.some((x) => x.kind === 'search')).toBe(true);
    const dogsFirst = r[0]!.key === 'tab:b';
    const pickKey = dogsFirst ? 'tab:a' : 'tab:b';
    for (let i = 0; i < 3; i++) s = run(s, { type: 'ranking.pick', query: 'do', key: pickKey, now: 0 });
    r = search(s, {}, 'do', 'S1', 0);
    expect(r[0]!.key).toBe(pickKey);
    const site = search(s, {}, 'wiki electron', 'S1', 0)[0]!;
    expect(site.kind).toBe('siteSearch');
    expect(site.run).toMatchObject({ type: 'open', url: 'https://en.wikipedia.org/w/index.php?search=electron' });
  });
});

describe('Air Traffic Control', () => {
  it('first matching rule wins; rules to deleted Spaces are skipped; default is the mini window', () => {
    let s = run(fresh(), { type: 'linkRule.upsert', rule: { id: 'r1', pattern: 'zoom.us', destination: { kind: 'space', spaceId: 'gone' } } });
    s = run(s, { type: 'linkRule.upsert', rule: { id: 'r2', pattern: 'zoom', destination: { kind: 'recentSpace' } } });
    s = run(s, { type: 'linkRule.upsert', rule: { id: 'r3', pattern: 'zoom', destination: { kind: 'space', spaceId: 'S1' } } });
    expect(routeExternalUrl(s, 'https://ZOOM.us/j/1')).toEqual({ kind: 'recentSpace' });
    expect(routeExternalUrl(s, 'https://example.com')).toEqual({ kind: 'littleArc' });
  });
});

describe('auto-archive selection', () => {
  it('archives idle Today items only, never selected or pinned, honoring "never"', () => {
    let s = run(fresh(), tab('old', 'T1', undefined, 0), tab('sel', 'T1', undefined, 0), tab('new', 'T1', undefined, 90_000_000), tab('pin', 'P1', undefined, 0));
    const now = 100_000_000;
    expect(dueForArchive(s, now, new Set(['sel']))).toEqual(['old']);
    s = run(s, { type: 'settings.update', patch: { autoArchive: { default: 'never' } } });
    expect(dueForArchive(s, now, new Set())).toEqual([]);
  });

  it('a folder is archived only when every tab inside is idle', () => {
    let s = run(fresh(), tab('x', 'T1', undefined, 0), tab('y', 'T1', undefined, 99_000_000));
    s = run(s, { type: 'folder.create', id: 'f', parentId: 'T1', childIds: ['x', 'y'], now: 0 });
    expect(dueForArchive(s, 100_000_000, new Set())).toEqual([]);
  });
});

describe('keymap', () => {
  it('applies overrides, including unset', () => {
    expect(acceleratorFor('togglePin', {})).toBe('CmdOrCtrl+D');
    expect(acceleratorFor('togglePin', { togglePin: null })).toBeNull();
    expect(acceleratorFor('duplicate', { duplicate: 'CmdOrCtrl+D' })).toBe('CmdOrCtrl+D');
  });
  it('converts Arc override chords', () => {
    expect(arcChordToAccelerator('d', 1048576)).toBe('Cmd+D');
    expect(arcChordToAccelerator('n', 1048576 + 131072 + 262144)).toBe('Ctrl+Shift+Cmd+N');
  });
});

describe('Live Folders', () => {
  it('parses RSS and Atom', () => {
    expect(parseFeed('<rss><item><title>A &amp; B</title><link>https://a.test/1</link></item></rss>')).toEqual([{ url: 'https://a.test/1', title: 'A & B' }]);
    expect(parseFeed('<feed><entry><title><![CDATA[Hi]]></title><link href="https://b.test/2"/></entry></feed>')).toEqual([{ url: 'https://b.test/2', title: 'Hi' }]);
  });
  it('sync keeps known entries, adds new ones unread, drops stale', () => {
    let s = run(fresh(), { type: 'folder.create', id: 'f', parentId: 'P1', now: 0 }, { type: 'liveFolder.set', id: 'f', feed: 'x', kind: 'rss' });
    s = run(s, { type: 'liveFolder.sync', id: 'f', entries: [{ id: 'e1', url: 'u1', title: '1' }, { id: 'e2', url: 'u2', title: '2' }], now: 1 });
    s = run(s, { type: 'liveFolder.sync', id: 'f', entries: [{ id: 'e3', url: 'u3', title: '3' }, { id: 'e9', url: 'u2', title: '2' }], now: 2 });
    expect(s.items.f!.children).toEqual(['e3', 'e2']);
    expect(s.items.e1).toBeUndefined();
    expect(s.items.e3!.isUnread).toBe(true);
  });
});

describe('auto-archive for Notes', () => {
  it('a Note touched recently is kept', () => {
    let s = run(fresh(), { type: 'note.create', id: 'n', parentId: 'T1', now: 0 });
    expect(dueForArchive(s, 100_000_000, new Set())).toEqual(['n']);
    s = run(s, { type: 'tab.touch', id: 'n', now: 99_000_000 });
    expect(dueForArchive(s, 100_000_000, new Set())).toEqual([]);
  });
});
