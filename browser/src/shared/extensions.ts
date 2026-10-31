// Chrome extensions: what the UI is told about each one, and the pure bits of reading Arc's extension folders.

export const WEB_STORE_URL = 'https://chromewebstore.google.com/';

export interface ExtensionInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  /** A data URL, or null when the extension ships no usable icon. */
  icon: string | null;
  /** Disabled extensions stay installed but are not loaded. */
  enabled: boolean;
  /** It has a toolbar button (`action` / `browser_action`), so it can be pinned to the sidebar. */
  hasAction: boolean;
}

/** An extension found in Arc's data, offered for reinstalling from the Chrome Web Store. */
export interface ArcExtension {
  id: string;
  name: string;
  /** Arc's Chromium profile folder ("Default", "Profile 1"). */
  profileDir: string;
}

export interface Manifest {
  name?: string;
  version?: string;
  description?: string;
  default_locale?: string;
  icons?: Record<string, string>;
  action?: unknown;
  browser_action?: unknown;
}

/** Chrome Web Store ids are 32 letters from a to p. */
export function isExtensionId(id: string): boolean {
  return /^[a-p]{32}$/.test(id);
}

/**
 * A manifest string, with `__MSG_key__` placeholders looked up in the default locale's messages
 * (keys are case-insensitive). An unresolved placeholder falls back to `fallback`.
 */
export function localized(value: string | undefined, messages: Record<string, { message?: string }> | null, fallback: string): string {
  if (!value) return fallback;
  const m = /^__MSG_(.+)__$/.exec(value);
  if (!m) return value;
  const key = m[1]!.toLowerCase();
  const entry = messages && Object.entries(messages).find(([k]) => k.toLowerCase() === key)?.[1];
  return entry?.message || fallback;
}

/** The manifest icon closest to `size` px, preferring larger ones (they scale down cleanly). */
export function pickIcon(icons: Record<string, string> | undefined, size: number): string | null {
  const sizes = Object.keys(icons ?? {}).map(Number).filter((n) => n > 0).sort((a, b) => a - b);
  if (!sizes.length) return null;
  const best = sizes.find((n) => n >= size) ?? sizes[sizes.length - 1]!;
  return icons![String(best)]!;
}

/** Newest version folder name ("1.2.10_0" beats "1.2.9_0"). */
export function newestVersion(dirs: string[]): string | null {
  const parts = (v: string) => v.split(/[._]/).map((x) => Number(x) || 0);
  const cmp = (a: string, b: string) => {
    const pa = parts(a);
    const pb = parts(b);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
    return 0;
  };
  return [...dirs].sort(cmp).pop() ?? null;
}


const PERMISSION_TEXT: Record<string, string> = {
  tabs: 'See the addresses and titles of your tabs',
  history: 'Read and change your browsing history',
  bookmarks: 'Read and change your bookmarks',
  cookies: 'Read and change cookies',
  downloads: 'Manage your downloads',
  clipboardRead: 'Read what you copy',
  clipboardWrite: 'Change what you copy',
  geolocation: 'Know your location',
  notifications: 'Show notifications',
  webNavigation: 'See where you go on the web',
  webRequest: 'See your web traffic',
  declarativeNetRequest: 'Block or change content on pages',
  declarativeNetRequestWithHostAccess: 'Block or change content on pages',
  nativeMessaging: 'Talk to apps installed on this Mac',
  debugger: 'Inspect and control pages',
  management: 'Manage your other extensions',
  privacy: 'Change privacy settings',
  proxy: 'Change how you connect to the internet',
};

/**
 * What the install prompt says an extension can do, from its manifest `permissions` and `host_permissions`.
 * Harmless permissions (storage, alarms, …) aren't listed; sites are grouped into one line.
 */
export function describeExtensionPermissions(permissions: string[]): string[] {
  const lines: string[] = [];
  const patterns = permissions.filter((p) => p.includes('://'));
  const web = patterns.filter((p) => !p.startsWith('file:')).map((p) => p.replace(/^[^:]+:\/\/(\*\.)?/, '').replace(/\/.*$/, ''));
  if (permissions.includes('<all_urls>') || web.includes('*')) lines.push('Read and change everything on every website');
  else {
    const hosts = [...new Set(web.filter(Boolean))];
    if (hosts.length) lines.push(`Read and change your data on ${hosts.length > 3 ? `${hosts.slice(0, 3).join(', ')} and ${hosts.length - 3} more sites` : hosts.join(', ')}`);
  }
  if (patterns.some((p) => p.startsWith('file:'))) lines.push('Read files from this Mac that you open in a tab');
  for (const p of permissions) {
    const text = PERMISSION_TEXT[p];
    if (text && !lines.includes(text)) lines.push(text);
  }
  return lines;
}
