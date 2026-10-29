// Command Bar results and ranking (spec/features/command-bar.md). Ranking = text match × result type,
// plus frecency from the user's own visits and a bonus for what they picked before for the same query.
import type { LiveTab, SearchResult } from './ipc';
import { itemTitle, type State } from './model';
import { allTabs, spaceOf } from './tree';
import { KEY_ACTIONS } from './keymap';

const MAX_RESULTS = 12;
const DAY = 86_400_000;

const KIND_WEIGHT: Record<SearchResult['kind'], number> = {
  url: 1.2,
  siteSearch: 1.2,
  tab: 1.0,
  space: 0.95,
  action: 0.9,
  history: 0.75,
  archive: 0.55,
  search: 0.3,
};

/** Actions offered by name that aren't plain keymap entries. */
const EXTRA_ACTIONS = [
  { id: 'archive', label: 'Open Archive' },
  { id: 'setDefaultBrowser', label: 'Set as Default Browser' },
  { id: 'importArc', label: 'Import from Arc' },
];

export function looksLikeURL(q: string): string | null {
  const t = q.trim();
  if (!t || /\s/.test(t)) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t) || /^(about|file|data):/i.test(t)) return t;
  if (/^localhost(:\d+)?(\/|$)/i.test(t) || /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/|$)/.test(t)) return `http://${t}`;
  if (/^[^./][^/]*\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(t)) return `https://${t}`;
  return null;
}

/** 1 = prefix of the whole text, 0.8 = prefix of a word, 0.5 = substring (every token must appear). */
export function matchScore(text: string, q: string): number {
  const hay = text.toLowerCase();
  const needle = q.trim().toLowerCase();
  if (!needle) return 0;
  if (hay.startsWith(needle)) return 1;
  if (new RegExp(`(^|[\\s/._-])${escapeRe(needle)}`).test(hay)) return 0.8;
  if (hay.includes(needle)) return 0.5;
  const tokens = needle.split(/\s+/);
  return tokens.length > 1 && tokens.every((t) => hay.includes(t)) ? 0.4 : 0;
}

function hostAndPath(url: string): string {
  return url.replace(/^[a-z]+:\/\/(www\.)?/i, '');
}

function frecency(state: State, key: string, now: number): number {
  const visits = state.ranking.visits[key] ?? [];
  return visits.reduce((acc, t) => acc + Math.exp(-(now - t) / (7 * DAY)), 0);
}

function learned(state: State, q: string, key: string): number {
  const query = q.trim().toLowerCase();
  let score = 0;
  for (const [stored, picks] of Object.entries(state.ranking.picks)) {
    const count = picks[key];
    if (!count) continue;
    if (stored === query) score += 0.6 * Math.min(4, count);
    else if (stored.startsWith(query) || query.startsWith(stored)) score += 0.15 * Math.min(4, count);
  }
  return score;
}

export function search(state: State, live: Map<string, LiveTab> | Record<string, LiveTab>, query: string, spaceId: string, now = Date.now()): SearchResult[] {
  const liveOf = (id: string) => (live instanceof Map ? live.get(id) : live[id]);
  const q = query.trim();
  const out: (SearchResult & { score: number })[] = [];
  const push = (r: SearchResult, base: number) => {
    if (base <= 0) return;
    out.push({ ...r, score: base * KIND_WEIGHT[r.kind] + 0.08 * frecency(state, r.key, now) + learned(state, q, r.key) });
  };

  // Site Search: "<keyword> <terms>".
  const [first, ...rest] = q.split(/\s+/);
  const site = state.settings.siteSearches.find((s) => s.keyword.toLowerCase() === first?.toLowerCase());
  if (site && rest.length) {
    const terms = rest.join(' ');
    push({ key: `site:${site.keyword}`, kind: 'siteSearch', title: `${site.name}: ${terms}`, subtitle: `Search ${site.name}`, run: { type: 'open', url: site.template.replace('%s', encodeURIComponent(terms)), where: 'newTab' } }, 2);
  }

  const url = looksLikeURL(q);
  if (url) push({ key: `url:${url}`, kind: 'url', title: q, subtitle: 'Open address', run: { type: 'open', url, where: 'newTab' } }, 1.5);

  if (!q) {
    // Empty query: the most recently used tabs.
    return allTabs(state)
      .map((t) => ({ t, last: t.tab?.lastActiveAt ?? 0 }))
      .sort((a, b) => b.last - a.last)
      .slice(0, 8)
      .map(({ t }) => tabResult(state, t.id, liveOf(t.id), spaceId));
  }

  const seenUrls = new Set<string>();
  for (const t of allTabs(state)) {
    const lt = liveOf(t.id);
    const title = lt?.title || itemTitle(t);
    const u = lt?.url || t.tab!.savedURL;
    seenUrls.add(u);
    push(tabResult(state, t.id, lt, spaceId), Math.max(matchScore(title, q), matchScore(hostAndPath(u), q) * 0.9));
  }

  for (const sp of state.spaces) {
    if (sp.id !== spaceId) push({ key: `space:${sp.id}`, kind: 'space', title: sp.title, subtitle: 'Switch to Space', run: { type: 'switchSpace', spaceId: sp.id } }, matchScore(sp.title, q));
  }

  for (const a of [...KEY_ACTIONS.map((k) => ({ id: k.id, label: k.label })), ...EXTRA_ACTIONS]) {
    if (/^(space|tab|pane)\d$/.test(a.id)) continue;
    const label = a.label.replace(/…$/, '');
    push({ key: `action:${a.id}`, kind: 'action', title: label, subtitle: 'Command', run: { type: 'runAction', id: a.id } }, matchScore(label, q));
  }

  for (const h of state.history) {
    if (seenUrls.has(h.url)) continue;
    const base = Math.max(matchScore(h.title, q), matchScore(hostAndPath(h.url), q));
    if (base > 0) {
      seenUrls.add(h.url);
      push({ key: `url:${h.url}`, kind: 'history', title: h.title || h.url, subtitle: hostAndPath(h.url), run: { type: 'open', url: h.url, where: 'newTab' } }, base + Math.min(0.3, Math.log10(1 + h.visits) * 0.15));
    }
  }

  for (const e of state.archive.slice(0, 2000)) {
    const root = e.items[0];
    const tab = root?.tab;
    if (!root || !tab || seenUrls.has(tab.savedURL)) continue;
    const base = Math.max(matchScore(itemTitle(root), q), matchScore(hostAndPath(tab.savedURL), q));
    if (base > 0) {
      seenUrls.add(tab.savedURL);
      push({ key: `url:${tab.savedURL}`, kind: 'archive', title: itemTitle(root), subtitle: `Archived · ${hostAndPath(tab.savedURL)}`, run: { type: 'open', url: tab.savedURL, where: 'newTab' } }, base);
    }
  }

  if (!url) {
    push({ key: `search:${q.toLowerCase()}`, kind: 'search', title: q, subtitle: 'Search the web', run: { type: 'open', url: state.settings.searchTemplate.replace('%s', encodeURIComponent(q)), where: 'newTab' } }, 1);
  }

  out.sort((a, b) => b.score - a.score);
  const results = out.slice(0, MAX_RESULTS);
  // Keep the web search reachable even when many other results score higher.
  const searchResult = out.find((r) => r.kind === 'search');
  if (searchResult && !results.includes(searchResult)) results[results.length - 1] = searchResult;
  return results.map(({ score: _score, ...r }) => r);
}

function tabResult(state: State, id: string, lt: LiveTab | undefined, spaceId: string): SearchResult {
  const item = state.items[id]!;
  const space = spaceOf(state, id);
  const u = lt?.url || item.tab!.savedURL;
  const where = space && space.id !== spaceId ? ` · ${space.title}` : '';
  return {
    key: `tab:${id}`,
    kind: 'tab',
    title: lt?.title || itemTitle(item),
    subtitle: `Switch to tab · ${hostAndPath(u)}${where}`,
    run: { type: 'select', id },
    favicon: lt?.favicon ?? item.tab?.faviconURL ?? null,
  };
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
