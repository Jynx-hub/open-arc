#!/usr/bin/env node
// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_ARC_DIR, readArcFile } from '../src/read.js';
import { buildModel, countTabs } from '../src/model.js';
import { toArchiveCsv, toBookmarksHtml, toJson, toMarkdown } from '../src/formats.js';

const FORMATS = {
  bookmarks: { file: 'arc-bookmarks.html', render: toBookmarksHtml },
  markdown: { file: 'arc-spaces.md', render: toMarkdown },
  json: { file: 'arc-export.json', render: toJson },
  archive: { file: 'arc-archive.csv', render: toArchiveCsv },
};

const HELP = `arc-export: get your Spaces, pinned tabs, Favorites and Archive out of Arc.

Usage: arc-export [options]

Options:
  --arc-dir <dir>    Arc data folder (default: ${DEFAULT_ARC_DIR})
  --out <dir>        Output folder (default: ./arc-export-YYYY-MM-DD)
  --format <list>    Comma list of: ${Object.keys(FORMATS).join(', ')} (default: all)
  --no-today         Leave Today (unpinned) tabs out of the bookmarks file
  --summary          Print counts only, write nothing
  -h, --help         Show this help

Reads only StorableSidebar.json, StorableArchiveItems.json and StorableLinkRouting.json.
Never reads account secrets. Never touches the network. Never modifies Arc's files.`;

function main() {
  const { values } = parseArgs({
    options: {
      'arc-dir': { type: 'string', default: DEFAULT_ARC_DIR },
      out: { type: 'string' },
      format: { type: 'string', default: Object.keys(FORMATS).join(',') },
      'no-today': { type: 'boolean', default: false },
      summary: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) return console.log(HELP);

  const arcDir = /** @type {string} */ (values['arc-dir']);
  const sidebar = readArcFile(arcDir, 'sidebar');
  if (!sidebar) {
    console.error(`No StorableSidebar.json in ${arcDir}. Is Arc installed, or pass --arc-dir.`);
    process.exitCode = 1;
    return;
  }
  const model = buildModel({
    sidebar,
    archive: readArcFile(arcDir, 'archive'),
    linkRouting: readArcFile(arcDir, 'linkRouting'),
  });

  console.log(`Spaces: ${model.spaces.length}`);
  for (const s of model.spaces) {
    console.log(`  ${s.title}: ${countTabs(s.pinned)} pinned, ${countTabs(s.today)} today (profile: ${s.profile})`);
  }
  console.log(`Favorites: ${model.favorites.reduce((n, f) => n + countTabs(f.items), 0)}`);
  console.log(`Archived items: ${model.archive.length}`);
  console.log(`Air Traffic Control routes: ${model.linkRoutes.length}`);
  if (values.summary) return;

  const wanted = String(values.format).split(',').map((f) => f.trim()).filter(Boolean);
  const unknown = wanted.filter((f) => !(f in FORMATS));
  if (unknown.length) {
    console.error(`Unknown format(s): ${unknown.join(', ')}`);
    process.exitCode = 1;
    return;
  }

  const outDir = values.out ?? `arc-export-${new Date().toISOString().slice(0, 10)}`;
  fs.mkdirSync(outDir, { recursive: true });
  for (const name of wanted) {
    const { file, render } = FORMATS[/** @type {keyof typeof FORMATS} */ (name)];
    const target = path.join(outDir, file);
    fs.writeFileSync(target, render(model, { includeToday: !values['no-today'] }));
    console.log(`wrote ${target}`);
  }
}

main();
