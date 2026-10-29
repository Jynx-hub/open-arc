#!/usr/bin/env node
// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_ARC_DIR, readArcFile } from '../src/read.js';
import { buildModel, countTabs } from '../src/model.js';
import { toArchiveCsv, toBookmarksHtml, toJson, toMarkdown } from '../src/formats.js';
import { DEFAULT_FIRESTORE_DIR, readCloudModel } from '../src/firestore.js';
import { toBoostUserCss, toEaselSvg, uniqueNames } from '../src/cloudFormats.js';

const FORMATS = {
  bookmarks: { file: 'arc-bookmarks.html', render: toBookmarksHtml },
  markdown: { file: 'arc-spaces.md', render: toMarkdown },
  json: { file: 'arc-export.json', render: toJson },
  archive: { file: 'arc-archive.csv', render: toArchiveCsv },
};

/** Formats from Arc's Firestore offline cache; each writes a folder of files. */
const CLOUD_FORMATS = {
  boosts: {
    dir: 'arc-boosts',
    /** @param {import('../src/firestore.js').CloudModel} cloud */
    files: (cloud) => uniqueNames(cloud.boosts.map((b) => b.host)).map((n, i) => [`${n}.user.css`, toBoostUserCss(cloud.boosts[i])]),
  },
  easels: {
    dir: 'arc-easels',
    /** @param {import('../src/firestore.js').CloudModel} cloud */
    files: (cloud) =>
      uniqueNames(cloud.easels.map((e) => e.title || e.id)).flatMap((n, i) => [
        [`${n}.json`, JSON.stringify(cloud.easels[i], null, 2) + '\n'],
        [`${n}.svg`, toEaselSvg(cloud.easels[i])],
      ]),
  },
};
const ALL_FORMATS = [...Object.keys(FORMATS), ...Object.keys(CLOUD_FORMATS)];

const HELP = `arc-export: get your Spaces, pinned tabs, Favorites and Archive out of Arc.

Usage: arc-export [options]

Options:
  --arc-dir <dir>    Arc data folder (default: ${DEFAULT_ARC_DIR})
  --firestore-dir <dir>  Arc's cloud cache, for Boosts and Easels (default: ${DEFAULT_FIRESTORE_DIR})
  --out <dir>        Output folder (default: ./arc-export-YYYY-MM-DD)
  --format <list>    Comma list of: ${ALL_FORMATS.join(', ')} (default: all)
  --no-today         Leave Today (unpinned) tabs out of the bookmarks file
  --summary          Print counts only, write nothing
  -h, --help         Show this help

Reads only StorableSidebar.json, StorableArchiveItems.json and StorableLinkRouting.json, plus
Boost and Easel documents from a temporary copy of the cloud cache (never account or sync data).
Never reads account secrets. Never touches the network. Never modifies Arc's files.`;

function main() {
  const { values } = parseArgs({
    options: {
      'arc-dir': { type: 'string', default: DEFAULT_ARC_DIR },
      'firestore-dir': { type: 'string', default: DEFAULT_FIRESTORE_DIR },
      out: { type: 'string' },
      format: { type: 'string', default: ALL_FORMATS.join(',') },
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

  const wanted = String(values.format).split(',').map((f) => f.trim()).filter(Boolean);
  /** @type {import('../src/firestore.js').CloudModel} */
  let cloud = { boosts: [], easels: [] };
  if (values.summary || wanted.some((f) => f in CLOUD_FORMATS)) {
    try {
      cloud = readCloudModel(/** @type {string} */ (values['firestore-dir']));
    } catch (err) {
      console.error(`Couldn't read the cloud cache (${/** @type {Error} */ (err).message}); skipping Boosts and Easels.`);
    }
    console.log(`Boosts: ${cloud.boosts.length}`);
    console.log(`Easels: ${cloud.easels.length} (${cloud.easels.filter((e) => e.objects.length).length} with content)`);
  }
  if (values.summary) return;

  const unknown = wanted.filter((f) => !ALL_FORMATS.includes(f));
  if (unknown.length) {
    console.error(`Unknown format(s): ${unknown.join(', ')}`);
    process.exitCode = 1;
    return;
  }

  const outDir = values.out ?? `arc-export-${new Date().toISOString().slice(0, 10)}`;
  fs.mkdirSync(outDir, { recursive: true });
  for (const name of wanted) {
    if (name in CLOUD_FORMATS) {
      const { dir, files } = CLOUD_FORMATS[/** @type {keyof typeof CLOUD_FORMATS} */ (name)];
      const list = files(cloud);
      if (!list.length) continue;
      const target = path.join(outDir, dir);
      fs.mkdirSync(target, { recursive: true });
      for (const [file, content] of list) fs.writeFileSync(path.join(target, file), content);
      console.log(`wrote ${target}/ (${list.length} files)`);
      continue;
    }
    const { file, render } = FORMATS[/** @type {keyof typeof FORMATS} */ (name)];
    const target = path.join(outDir, file);
    fs.writeFileSync(target, render(model, { includeToday: !values['no-today'] }));
    console.log(`wrote ${target}`);
  }
}

main();
