// Boosts (spec/features/boosts.md): per-site CSS, hidden elements, font/color, and JS in an isolated world.
import type { WebContents } from 'electron';
// @ts-ignore: plain JS module with JSDoc types
import { colorSchemeCss } from '../../../exporter/src/cloudFormats.js';
import type { Boost, State } from '../shared/model';

const ISOLATED_WORLD = 1001;

export function boostMatches(boost: Boost, url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    const want = boost.host.replace(/^www\./, '').toLowerCase();
    return host === want || host.endsWith(`.${want}`);
  } catch {
    return false;
  }
}

export function boostCss(boost: Boost): string {
  const parts: string[] = [];
  if (boost.font) parts.push(`body, body * { font-family: ${JSON.stringify(boost.font)}, system-ui, sans-serif !important; }`);
  if (boost.color) parts.push(`html { filter: none; } body { background-color: ${boost.color} !important; }`);
  if (boost.colorScheme) parts.push(colorSchemeCss(boost.colorScheme) as string);
  if (boost.zapped.length) parts.push(`${boost.zapped.join(',\n')} { display: none !important; }`);
  if (boost.css.trim()) parts.push(boost.css);
  return parts.join('\n');
}

export function applyBoosts(state: State, wc: WebContents) {
  const url = wc.getURL();
  for (const boost of state.boosts) {
    if (!boost.enabled || !boostMatches(boost, url)) continue;
    const css = boostCss(boost);
    if (css) void wc.insertCSS(css, { cssOrigin: 'user' }).catch(() => {});
    if (boost.js.trim()) void wc.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD, [{ code: boost.js }]).catch(() => {});
  }
}

/**
 * Shared Boosts carry CSS only (spec: Arc rejects shared Boost data containing JS). We export a
 * userstyle that Stylus and similar extensions can install.
 */
export function exportBoostCss(boost: Boost): string {
  return [
    '/* ==UserStyle==',
    `@name         ${boost.name || boost.host}`,
    '@namespace    open-arc',
    '@version      1.0.0',
    '==/UserStyle== */',
    `@-moz-document domain("${boost.host}") {`,
    boostCss(boost),
    '}',
    '',
  ].join('\n');
}
