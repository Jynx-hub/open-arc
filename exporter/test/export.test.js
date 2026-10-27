import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { appleTimeToDate, readArcFile } from '../src/read.js';
import { buildModel, countTabs } from '../src/model.js';
import { toArchiveCsv, toBookmarksHtml, toMarkdown } from '../src/formats.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, 'fixtures', 'arc');
const CLI = path.join(here, '..', 'bin', 'arc-export.js');

const model = buildModel({
  sidebar: readArcFile(FIXTURE, 'sidebar'),
  archive: readArcFile(FIXTURE, 'archive'),
  linkRouting: readArcFile(FIXTURE, 'linkRouting'),
});

test('apple epoch converts to unix time', () => {
  assert.equal(appleTimeToDate(0)?.toISOString(), '2001-01-01T00:00:00.000Z');
});

test('uses the global container even when Little Arc comes first', () => {
  assert.deepEqual(model.spaces.map((s) => s.title), ['Home', 'Work']);
});

test('spaces follow orderedSpaceIDs', () => {
  assert.equal(model.spaces[0].id, 'SPACE-HOME');
});

test('builds the pinned tree with folders and tab groups, skipping missing children', () => {
  const work = model.spaces.find((s) => s.title === 'Work');
  assert.ok(work);
  const [folder, docs] = work.pinned;
  assert.equal(work.pinned.length, 2, 'MISSING-CHILD is dropped');
  assert.equal(folder.type, 'folder');
  assert.equal(folder.title, 'Projects');
  assert.equal(docs.type, 'tab');
  assert.ok('children' in folder);
  const [repo, group] = folder.children;
  assert.equal(repo.title, 'My repo', 'user rename wins over savedTitle');
  assert.equal(group.type, 'tabGroup');
  assert.equal(group.title, 'Research');
  assert.equal(countTabs(work.pinned), 3);
});

test('today holds split views and keeps non-tab items as "other"', () => {
  const work = model.spaces.find((s) => s.title === 'Work');
  const [split, note] = work.today;
  assert.equal(split.type, 'splitView');
  assert.equal(countTabs([split]), 2);
  assert.deepEqual(note, { type: 'other', kind: 'arcDocument', title: 'Meeting notes', createdAt: note.createdAt });
});

test('survives cycles in damaged files', () => {
  const home = model.spaces.find((s) => s.title === 'Home');
  assert.equal(home.pinned[0].title, 'Loop');
  assert.equal(home.pinned[0].children[0].title, 'Back');
  assert.equal(home.pinned[0].children[0].children.length, 0);
});

test('favorites, archive and link routes', () => {
  assert.equal(model.favorites[0].profile, 'default');
  assert.equal(model.favorites[0].items[0].url, 'https://mail.example.com/');
  assert.deepEqual(model.archive.map((a) => a.reason), ['manual', 'auto'], 'newest first');
  assert.equal(model.archive[1].spaceTitle, 'Work');
  assert.equal(model.archive[0].source, 'littleArc');
  assert.deepEqual(model.linkRoutes, [{ pattern: 'music.example.com', operator: 'contains', destination: 'Home' }]);
});

test('bookmarks html escapes and nests', () => {
  const html = toBookmarksHtml(model);
  assert.match(html, /^<!DOCTYPE NETSCAPE-Bookmark-file-1>/);
  assert.match(html, /HREF="https:\/\/example\.org\/a\?x=1&amp;y=&lt;2&gt;"/);
  assert.match(html, />A &amp; &quot;B&quot;<\/A>/);
  assert.match(html, /<H3>Favorites<\/H3>/);
  assert.equal((html.match(/<DL><p>/g) ?? []).length, (html.match(/<\/DL><p>/g) ?? []).length, 'balanced lists');
  assert.doesNotMatch(toBookmarksHtml(model, { includeToday: false }), /<H3>Today<\/H3>/);
});

test('markdown and csv', () => {
  const md = toMarkdown(model);
  assert.match(md, /## Work/);
  assert.match(md, /- \[Docs\]\(https:\/\/docs\.example\.com\/\)/);
  assert.match(md, /Meeting notes _\(arcDocument, content not stored locally\)_/);
  const csv = toArchiveCsv(model).trim().split('\n');
  assert.equal(csv[0], 'archived_at,reason,source,space,title,url');
  assert.equal(csv.length, 3);
  assert.match(csv[2], /"Old, ""quoted"" tab"/);
});

test('cli writes every format and never reads secrets', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-export-'));
  // The fixture dir contains a StorableAuthState.json marker; it must not leak into any output.
  execFileSync(process.execPath, [CLI, '--arc-dir', FIXTURE, '--out', out], { stdio: 'pipe' });
  const files = fs.readdirSync(out).sort();
  assert.deepEqual(files, ['arc-archive.csv', 'arc-bookmarks.html', 'arc-export.json', 'arc-spaces.md']);
  for (const f of files) assert.doesNotMatch(fs.readFileSync(path.join(out, f), 'utf8'), /THIS_FILE_MUST_NEVER_BE_READ/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'arc-export.json'), 'utf8')).format, 'open-arc-export');
  fs.rmSync(out, { recursive: true });
});
