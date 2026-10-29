import { describe, expect, it } from 'vitest';
import { fresh, run } from './helpers';
import { contextMenuTemplate, searchURL, type PageMenuParams } from '../src/shared/contextMenu';
import { decide, originOf, permissionKeys } from '../src/shared/permissions';
import { uniqueFilename } from '../src/shared/files';
import { migrate } from '../src/shared/migrate';
import { DOWNLOADS_LIMIT, STATE_VERSION, type DownloadEntry } from '../src/shared/model';

const params = (p: Partial<PageMenuParams> = {}): PageMenuParams => ({
  linkURL: '', srcURL: '', mediaType: 'none', selectionText: '', isEditable: false, misspelledWord: '', dictionarySuggestions: [],
  editFlags: { canCut: false, canCopy: false, canPaste: false, canSelectAll: true },
  ...p,
});
const caps = { canGoBack: true, canGoForward: false, canSplit: true };
const ids = (p: Partial<PageMenuParams>, c = caps) => contextMenuTemplate(params(p), c).map((e) => e.id);

describe('page context menu', () => {
  it('plain page: navigation and inspect', () => {
    expect(ids({})).toEqual(['back', 'forward', 'reload', 'separator', 'inspect']);
    const fwd = contextMenuTemplate(params(), caps).find((e) => e.id === 'forward');
    expect(fwd).toMatchObject({ enabled: false });
  });

  it('link: open in tab, split, mini window, copy, save — no navigation', () => {
    expect(ids({ linkURL: 'https://a.test/' })).toEqual(['openLinkNewTab', 'openLinkSplit', 'openLinkLittle', 'copyLink', 'saveLinkAs', 'separator', 'inspect']);
    // Peek and mini windows have no tab to split with.
    expect(ids({ linkURL: 'https://a.test/' }, { ...caps, canSplit: false })).not.toContain('openLinkSplit');
  });

  it('image inside a link gets both groups', () => {
    const out = ids({ linkURL: 'https://a.test/', mediaType: 'image', srcURL: 'https://a.test/i.png' });
    expect(out).toContain('openLinkNewTab');
    expect(out).toEqual(expect.arrayContaining(['openImageNewTab', 'copyImage', 'copyImageAddress', 'saveImageAs']));
  });

  it('selection: copy and a web search labelled with the (shortened) text', () => {
    const out = contextMenuTemplate(params({ selectionText: '  the quick brown fox jumps over the lazy dog ' }), caps);
    expect(out.map((e) => e.id)).toEqual(['copy', 'separator', 'searchSelection', 'separator', 'inspect']);
    const label = (out.find((e) => e.id === 'searchSelection') as { label: string }).label;
    expect(label).toContain('“the quick brown fox jum…”');
    expect(searchURL('https://s.test/?q=%s', ' a&b ')).toBe('https://s.test/?q=a%26b');
  });

  it('editable field: spelling first, then edit commands following editFlags', () => {
    const out = contextMenuTemplate(
      params({ isEditable: true, misspelledWord: 'teh', dictionarySuggestions: ['the', 'ten'], editFlags: { canCut: false, canCopy: false, canPaste: true, canSelectAll: true } }),
      caps,
    );
    expect(out.map((e) => e.id)).toEqual(['replaceMisspelling', 'replaceMisspelling', 'addToDictionary', 'separator', 'cut', 'copy', 'paste', 'selectAll', 'separator', 'inspect']);
    expect(out[0]).toMatchObject({ word: 'the' });
    expect(out.find((e) => e.id === 'cut')).toMatchObject({ enabled: false });
    expect(out.find((e) => e.id === 'paste')).toMatchObject({ enabled: true });
    // A misspelling with no suggestions shows a disabled placeholder.
    const none = contextMenuTemplate(params({ isEditable: true, misspelledWord: 'qzx' }), caps);
    expect(none[0]).toMatchObject({ id: 'replaceMisspelling', word: '' });
  });
});

describe('site permissions', () => {
  const o = 'https://maps.test';
  it('auto-allows harmless ones, denies unknown ones, asks for the rest', () => {
    expect(decide({}, o, ['fullscreen'])).toBe('allow');
    expect(decide({}, o, ['clipboard-sanitized-write'])).toBe('allow');
    // Gated by a user action already (file picker, fullscreen), as in Chromium.
    expect(decide({}, o, ['fileSystem'])).toBe('allow');
    expect(decide({}, o, ['keyboardLock'])).toBe('allow');
    expect(decide({}, o, ['usb'])).toBe('deny');
    expect(decide({}, o, ['window-management'])).toBe('deny');
    expect(decide({}, o, ['geolocation'])).toBe('ask');
    expect(decide({}, o, [])).toBe('deny');
  });

  it('saved answers apply to their origin only', () => {
    const saved = { [o]: { geolocation: 'deny' as const, notifications: 'allow' as const } };
    expect(decide(saved, o, ['geolocation'])).toBe('deny');
    expect(decide(saved, o, ['notifications'])).toBe('allow');
    expect(decide(saved, 'https://other.test', ['notifications'])).toBe('ask');
  });

  it('camera + microphone need both allowed; one block blocks the request', () => {
    expect(permissionKeys('media', ['video', 'audio'])).toEqual(['camera', 'microphone']);
    expect(permissionKeys('media', ['audio'])).toEqual(['microphone']);
    expect(permissionKeys('media')).toEqual(['camera', 'microphone']);
    expect(permissionKeys('geolocation-approximate')).toEqual(['geolocation']);
    expect(decide({ [o]: { camera: 'allow' } }, o, ['camera', 'microphone'])).toBe('ask');
    expect(decide({ [o]: { camera: 'allow', microphone: 'deny' } }, o, ['camera', 'microphone'])).toBe('deny');
    expect(decide({ [o]: { camera: 'allow', microphone: 'allow' } }, o, ['camera', 'microphone'])).toBe('allow');
  });

  it('opaque pages have no origin', () => {
    expect(originOf('https://a.test/x?y')).toBe('https://a.test');
    expect(originOf('about:blank')).toBeNull();
    expect(originOf('data:text/html,hi')).toBeNull();
  });

  it('sitePermission.set saves, changes and forgets answers', () => {
    let s = run(fresh(), { type: 'sitePermission.set', origin: o, permission: 'camera', decision: 'allow' });
    expect(s.settings.sitePermissions).toEqual({ [o]: { camera: 'allow' } });
    s = run(s, { type: 'sitePermission.set', origin: o, permission: 'camera', decision: 'deny' });
    expect(s.settings.sitePermissions[o]).toEqual({ camera: 'deny' });
    s = run(s, { type: 'sitePermission.set', origin: o, permission: 'camera', decision: null });
    expect(s.settings.sitePermissions).toEqual({});
  });
});

describe('downloads', () => {
  it('numbers clashing names before the extension', () => {
    const taken = (names: string[]) => (n: string) => names.includes(n);
    expect(uniqueFilename('a.pdf', taken([]))).toBe('a.pdf');
    expect(uniqueFilename('a.pdf', taken(['a.pdf']))).toBe('a (1).pdf');
    expect(uniqueFilename('a.pdf', taken(['a.pdf', 'a (1).pdf']))).toBe('a (2).pdf');
    expect(uniqueFilename('x.tar.gz', taken(['x.tar.gz']))).toBe('x (1).tar.gz');
    expect(uniqueFilename('my.notes.txt', taken(['my.notes.txt']))).toBe('my.notes (1).txt');
    expect(uniqueFilename('.env', taken(['.env']))).toBe('.env (1)');
    expect(uniqueFilename('README', taken(['README']))).toBe('README (1)');
    expect(uniqueFilename('  ', taken([]))).toBe('download');
  });

  const entry = (id: string, state: DownloadEntry['state'] = 'completed'): DownloadEntry => ({
    id, url: `https://d.test/${id}`, filename: id, path: `/tmp/${id}`, mime: 'text/plain', totalBytes: 1, receivedBytes: 1, state, startedAt: 0, endedAt: 0, profileId: 'default',
  });

  it('upsert adds newest first and updates in place; the cap drops old finished entries, never running ones', () => {
    let s = run(fresh(), { type: 'download.upsert', entry: entry('a', 'progressing') });
    s = run(s, { type: 'download.upsert', entry: entry('b') });
    expect(s.downloads.map((d) => d.id)).toEqual(['b', 'a']);
    s = run(s, { type: 'download.upsert', entry: { ...entry('a'), receivedBytes: 1 } });
    expect(s.downloads.map((d) => [d.id, d.state])).toEqual([['b', 'completed'], ['a', 'completed']]);

    s = run(fresh(), { type: 'download.upsert', entry: entry('oldest-running', 'progressing') });
    for (let i = 0; i < DOWNLOADS_LIMIT + 5; i++) s = run(s, { type: 'download.upsert', entry: entry(`d${i}`) });
    expect(s.downloads).toHaveLength(DOWNLOADS_LIMIT);
    expect(s.downloads.some((d) => d.id === 'oldest-running')).toBe(true);
    expect(s.downloads[0]!.id).toBe(`d${DOWNLOADS_LIMIT + 4}`);
  });

  it('clear keeps running downloads; remove drops one', () => {
    let s = run(fresh(), { type: 'download.upsert', entry: entry('a', 'progressing') }, { type: 'download.upsert', entry: entry('b') }, { type: 'download.upsert', entry: entry('c', 'cancelled') });
    s = run(s, { type: 'download.clear' });
    expect(s.downloads.map((d) => d.id)).toEqual(['a']);
    s = run(s, { type: 'download.remove', id: 'a' });
    expect(s.downloads).toEqual([]);
  });

  it('only the downloads slice changes on a download action', () => {
    const s0 = fresh();
    const s1 = run(s0, { type: 'download.upsert', entry: entry('a') });
    expect(s1.items).toBe(s0.items);
    expect(s1.settings).toBe(s0.settings);
    expect(s1.downloads).not.toBe(s0.downloads);
  });
});

describe('state migration v2 → v3', () => {
  it('adds an empty downloads list and site permissions, keeping other settings', () => {
    const v2 = structuredClone(fresh()) as any;
    v2.version = 2;
    delete v2.downloads;
    delete v2.settings.sitePermissions;
    v2.settings.peekFromPinned = false;
    const out = migrate(v2);
    expect(out.version).toBe(STATE_VERSION);
    expect(out.downloads).toEqual([]);
    expect(out.settings.sitePermissions).toEqual({});
    expect(out.settings.peekFromPinned).toBe(false);
  });
});
