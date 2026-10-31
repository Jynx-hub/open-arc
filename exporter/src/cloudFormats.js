// @ts-check
// Output for the Firestore cache model (src/firestore.js): Boosts as userstyles, Easels as JSON + SVG.

/** @typedef {import('./firestore.js').Boost} Boost @typedef {import('./firestore.js').Easel} Easel @typedef {import('./firestore.js').ColorScheme} ColorScheme */

/**
 * Approximates a color-wheel recolor (Arc's exact algorithm is unknown): a fixed, click-through layer
 * blended with `mix-blend-mode: color` tints the page toward the primary hue, fading to the secondary
 * hue. `invertLightness` turns light pages dark (and back for media, so photos keep their look).
 * @param {Pick<ColorScheme, 'hue' | 'saturation' | 'secondaryHueOffset' | 'invertLightness'>} cs
 */
export function colorSchemeCss(cs) {
  const sat = Math.round(Math.min(1, Math.max(0, cs.saturation)) * 100);
  const h1 = Math.round(cs.hue);
  const h2 = Math.round(cs.hue + cs.secondaryHueOffset);
  const css = [
    'html::after { content: ""; position: fixed; inset: 0; pointer-events: none; z-index: 2147483647;',
    `  mix-blend-mode: color; opacity: ${(0.35 + 0.4 * (sat / 100)).toFixed(2)};`,
    `  background: linear-gradient(135deg, hsl(${h1} ${sat}% 50%), hsl(${h2} ${sat}% 50%)); }`,
  ];
  if (cs.invertLightness) {
    css.push('html { filter: invert(1) hue-rotate(180deg) !important; }');
    css.push('img, video, picture, canvas, iframe, [style*="background-image"] { filter: invert(1) hue-rotate(180deg) !important; }');
  }
  return css.join('\n');
}

/** A UserCSS file (installable in Stylus) for one Boost. */
export function toBoostUserCss(/** @type {Boost} */ boost) {
  const body = [];
  if (boost.colorScheme) body.push(colorSchemeCss(boost.colorScheme));
  const selectors = boost.zaps.filter((z) => typeof z === 'string');
  if (selectors.length) body.push(`${selectors.join(',\n')} { display: none !important; }`);
  return [
    '/* ==UserStyle==',
    `@name         ${boost.name || boost.host} (Arc Boost)`,
    '@namespace    arc-export',
    '@version      1.0.0',
    `@description  Exported from Arc by arc-export.${boost.enabled ? '' : ' It was turned off in Arc.'}`,
    '==/UserStyle== */',
    `@-moz-document domain("${boost.host}") {`,
    body.join('\n') || '/* This Boost had no color or zap settings to export. */',
    '}',
    '',
  ].join('\n');
}

/** Easel text sizes per Arc paragraph style, and the canvas width that Arc's normalized rects are laid out on. */
export const HEADING_SIZES = /** @type {Record<string, number>} */ ({ h1: 40, h2: 30, h3: 24 });
export const EASEL_WIDTH = 1000;

const xml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);

/** A static picture of an Easel's text. Rects are fractions of the canvas width (spec/formats/cloud-cache.md). */
export function toEaselSvg(/** @type {Easel} */ easel) {
  const boxes = easel.objects.filter((o) => o.kind === 'text' && o.text);
  const height = Math.max(400, ...boxes.map((o) => (o.rect.y + o.rect.height) * EASEL_WIDTH + 40));
  const parts = boxes.map((o) => {
    const size = HEADING_SIZES[String(o.style?.paragraphStyle)] ?? 18;
    const x = Math.round(o.rect.x * EASEL_WIDTH);
    const top = Math.round(o.rect.y * EASEL_WIDTH);
    const lines = wrap(String(o.text), Math.max(1, Math.floor((o.rect.width * EASEL_WIDTH) / (size * 0.55))));
    const spans = lines.map((line, i) => `<tspan x="${x}" dy="${i ? Math.round(size * 1.25) : size}">${xml(line)}</tspan>`).join('');
    return `  <text y="${top}" font-family="system-ui, -apple-system, sans-serif" font-size="${size}" fill="#222">${spans}</text>`;
  });
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${EASEL_WIDTH}" height="${Math.round(height)}" viewBox="0 0 ${EASEL_WIDTH} ${Math.round(height)}">`,
    `  <title>${xml(easel.title || 'Easel')}</title>`,
    '  <rect width="100%" height="100%" fill="#fff"/>',
    ...parts,
    '</svg>',
    '',
  ].join('\n');
}

/** Greedy word wrap at roughly `cols` characters (SVG text doesn't wrap by itself). */
function wrap(text, cols) {
  const lines = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(' ')) {
      if (line && line.length + 1 + word.length > cols) {
        lines.push(line);
        line = word;
      } else line = line ? `${line} ${word}` : word;
    }
    lines.push(line);
  }
  return lines;
}

/** File-system-safe names, unique even on a case-insensitive disk: `base`, `base-2`, … */
export function uniqueNames(/** @type {string[]} */ bases) {
  /** @type {Set<string>} */
  const used = new Set();
  return bases.map((b) => {
    const safe = b.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'untitled';
    let name = safe;
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${safe}-${n}`;
    used.add(name.toLowerCase());
    return name;
  });
}
