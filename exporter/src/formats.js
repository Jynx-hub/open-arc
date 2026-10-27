// @ts-check
// Output formats. Each takes the model from buildModel() and returns file contents as a string.

/** @typedef {import('./model.js').ArcModel} ArcModel */
/** @typedef {import('./model.js').Node} Node */

const escapeHtml = (/** @type {string} */ s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const unixSeconds = (/** @type {Date | null} */ d) => (d ? Math.floor(d.getTime() / 1000) : 0);

/**
 * Netscape bookmark file, importable by Chrome, Firefox, Safari, Zen, Brave, Edge, etc.
 * Layout: Arc / <Space> / {Pinned, Today}, plus Arc / Favorites (<profile>).
 * @param {ArcModel} model
 * @param {{ includeToday?: boolean }} [opts]
 */
export function toBookmarksHtml(model, { includeToday = true } = {}) {
  const lines = [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    '<!-- Exported by arc-export (Open Arc). -->',
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    '<TITLE>Bookmarks</TITLE>',
    '<H1>Bookmarks</H1>',
    '<DL><p>',
  ];

  /** @param {number} depth @param {string} title @param {() => void} body */
  const folder = (depth, title, body) => {
    const pad = '    '.repeat(depth);
    lines.push(`${pad}<DT><H3>${escapeHtml(title)}</H3>`, `${pad}<DL><p>`);
    body();
    lines.push(`${pad}</DL><p>`);
  };

  /** @param {Node[]} nodes @param {number} depth */
  const emit = (nodes, depth) => {
    for (const node of nodes) {
      if (node.type === 'tab') {
        if (!node.url) continue;
        lines.push(
          `${'    '.repeat(depth)}<DT><A HREF="${escapeHtml(node.url)}" ADD_DATE="${unixSeconds(node.createdAt)}">${escapeHtml(node.title)}</A>`,
        );
      } else if ('children' in node) {
        folder(depth, node.title, () => emit(node.children, depth + 1));
      }
    }
  };

  folder(1, 'Arc', () => {
    for (const fav of model.favorites) {
      if (fav.items.length === 0) continue;
      const label = model.favorites.length > 1 ? `Favorites (${fav.profile})` : 'Favorites';
      folder(2, label, () => emit(fav.items, 3));
    }
    for (const space of model.spaces) {
      folder(2, space.title, () => {
        if (space.pinned.length) folder(3, 'Pinned', () => emit(space.pinned, 4));
        if (includeToday && space.today.length) folder(3, 'Today', () => emit(space.today, 4));
      });
    }
  });

  lines.push('</DL><p>');
  return lines.join('\n') + '\n';
}

/**
 * Human-readable Markdown outline of every Space.
 * @param {ArcModel} model
 */
export function toMarkdown(model) {
  const out = ['# Arc export', ''];
  const mdLink = (/** @type {string} */ title, /** @type {string} */ url) =>
    `[${title.replace(/([\[\]])/g, '\\$1')}](${url.replace(/\)/g, '%29')})`;

  /** @param {Node[]} nodes @param {number} depth */
  const emit = (nodes, depth) => {
    for (const node of nodes) {
      const pad = '  '.repeat(depth);
      if (node.type === 'tab') out.push(`${pad}- ${node.url ? mdLink(node.title, node.url) : node.title}`);
      else if ('children' in node) {
        out.push(`${pad}- **${node.title}**${node.type === 'folder' ? '' : ` _(${node.type})_`}`);
        emit(node.children, depth + 1);
      } else out.push(`${pad}- ${node.title} _(${node.kind}, content not stored locally)_`);
    }
  };

  for (const fav of model.favorites) {
    if (!fav.items.length) continue;
    out.push(`## Favorites${model.favorites.length > 1 ? ` (${fav.profile})` : ''}`, '');
    emit(fav.items, 0);
    out.push('');
  }
  for (const space of model.spaces) {
    out.push(`## ${space.title}`, '', `_Profile: ${space.profile}_`, '');
    if (space.pinned.length) {
      out.push('### Pinned', '');
      emit(space.pinned, 0);
      out.push('');
    }
    if (space.today.length) {
      out.push('### Today', '');
      emit(space.today, 0);
      out.push('');
    }
  }
  if (model.linkRoutes.length) {
    out.push('## Air Traffic Control routes', '');
    for (const r of model.linkRoutes) out.push(`- URL ${r.operator ?? 'matches'} \`${r.pattern}\` → ${r.destination}`);
    out.push('');
  }
  return out.join('\n');
}

/**
 * Lossless-ish JSON of the whole model, for other tools (and Open Arc's importer).
 * @param {ArcModel} model
 */
export function toJson(model) {
  return JSON.stringify({ format: 'open-arc-export', version: 1, ...model }, null, 2) + '\n';
}

/**
 * Archive as CSV: one row per archived tab (folders are flattened).
 * @param {ArcModel} model
 */
export function toArchiveCsv(model) {
  const cell = (/** @type {unknown} */ v) => {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = [['archived_at', 'reason', 'source', 'space', 'title', 'url']];
  /** @param {import('./model.js').ArchiveEntry} e @param {Node} node */
  const add = (e, node) => {
    if (node.type === 'tab') {
      rows.push([e.archivedAt?.toISOString() ?? '', e.reason, e.source, e.spaceTitle ?? '', node.title, node.url]);
    } else if ('children' in node) node.children.forEach((c) => add(e, c));
  };
  for (const e of model.archive) if (e.item) add(e, e.item);
  return rows.map((r) => r.map(cell).join(',')).join('\n') + '\n';
}
