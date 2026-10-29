// Live Folders (spec/features/folders-favorites-groups.md): folders filled from an RSS/Atom feed or a
// GitHub repository's open pull requests. Local fetchers only; refreshed every 30 minutes.
import { net } from 'electron';
import { randomUUID } from 'node:crypto';
import type { Store } from './store';

const MAX_ENTRIES = 25;

export interface FeedEntry {
  url: string;
  title: string;
}

function decode(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .trim();
}

/** Minimal RSS 2.0 / Atom parser: title + link of each item/entry. */
export function parseFeed(xml: string): FeedEntry[] {
  const blocks = xml.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/g) ?? [];
  return blocks
    .map((b) => {
      const title = decode(/<title[^>]*>([\s\S]*?)<\/title>/.exec(b)?.[1] ?? '');
      const link = /<link[^>]*href="([^"]+)"/.exec(b)?.[1] ?? decode(/<link>([\s\S]*?)<\/link>/.exec(b)?.[1] ?? '');
      return { url: decode(link), title: title || link };
    })
    .filter((e) => /^https?:/.test(e.url))
    .slice(0, MAX_ENTRIES);
}

async function fetchEntries(feed: string, kind: 'rss' | 'github'): Promise<FeedEntry[]> {
  if (kind === 'github') {
    const repo = feed.replace(/^https:\/\/github\.com\//, '').replace(/\/$/, '');
    const res = await net.fetch(`https://api.github.com/repos/${repo}/pulls?state=open&per_page=${MAX_ENTRIES}`, { headers: { accept: 'application/vnd.github+json' } });
    if (!res.ok) throw new Error(`GitHub responded ${res.status}`);
    const pulls = (await res.json()) as { html_url: string; title: string; number: number }[];
    return pulls.map((p) => ({ url: p.html_url, title: `#${p.number} ${p.title}` }));
  }
  const res = await net.fetch(feed);
  if (!res.ok) throw new Error(`Feed responded ${res.status}`);
  return parseFeed(await res.text());
}

export async function refreshLiveFolder(store: Store, id: string): Promise<number> {
  const live = store.state.items[id]?.live;
  if (!live) return 0;
  const entries = await fetchEntries(live.feed, live.kind);
  store.dispatch({ type: 'liveFolder.sync', id, entries: entries.map((e) => ({ ...e, id: randomUUID() })), now: Date.now() });
  return entries.length;
}

export function startLiveFolderTimer(store: Store) {
  const tick = () => {
    for (const item of Object.values(store.state.items)) {
      if (item.live && Date.now() - (item.live.lastFetchedAt ?? 0) > 30 * 60_000) void refreshLiveFolder(store, item.id).catch(() => {});
    }
  };
  setTimeout(tick, 5_000);
  return setInterval(tick, 60_000);
}
