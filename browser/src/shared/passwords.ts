// Saved logins: CSV import/export in Chrome's column layout, origin matching, and the save-or-update
// decision. Pure, so the main process (which alone ever holds passwords) and tests share it.
import { toCsv } from './csv';

export interface Login {
  id: string;
  /** scheme://host[:port] of the site the login is for. */
  origin: string;
  username: string;
  password: string;
  note: string;
  createdAt: number;
  updatedAt: number;
}

/** What the UI may see of a login: everything but the password. */
export type LoginSummary = Omit<Login, 'password'>;

export const CSV_COLUMNS = ['name', 'url', 'username', 'password', 'note'] as const;

/** The origin a login belongs to: http(s) only (Chrome's export also carries android:// apps). */
export function loginOrigin(url: string): string | null {
  try {
    const u = new URL(url.trim());
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : null;
  } catch {
    return null;
  }
}

/**
 * A login saved for `saved` fills on `page` when scheme, port and host agree, treating `www.` as the same
 * host. Never across schemes: an https login doesn't fill on an http page.
 */
export function sameSite(saved: string, page: string): boolean {
  if (saved === page) return true;
  try {
    const a = new URL(saved);
    const b = new URL(page);
    const host = (h: string) => h.replace(/^www\./, '');
    return a.protocol === b.protocol && a.port === b.port && host(a.hostname) === host(b.hostname);
  } catch {
    return false;
  }
}

export function loginsFor(logins: Login[], origin: string): Login[] {
  return logins.filter((l) => sameSite(l.origin, origin)).sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Logins from parsed CSV rows (the first row names the columns). Rows without a web address or password are skipped. */
export function loginsFromCsv(rows: string[][], now: number, newId: () => string): { logins: Login[]; skipped: number } {
  const [header, ...body] = rows;
  if (!header) return { logins: [], skipped: 0 };
  const col = (name: string) => header.findIndex((h) => h.trim().toLowerCase() === name);
  const [url, username, password, note] = [col('url'), col('username'), col('password'), col('note')];
  if (url < 0 || password < 0) throw new Error('This file has no url and password columns. Export passwords as CSV and try again.');
  const logins: Login[] = [];
  let skipped = 0;
  for (const r of body) {
    const origin = loginOrigin(r[url] ?? '');
    const pw = r[password] ?? '';
    if (!origin || !pw) {
      skipped++;
      continue;
    }
    logins.push({ id: newId(), origin, username: username < 0 ? '' : (r[username] ?? ''), password: pw, note: note < 0 ? '' : (r[note] ?? ''), createdAt: now, updatedAt: now });
  }
  return { logins, skipped };
}

/** Adds `incoming` to `existing`: a login for the same site (as `sameSite` sees it) and username replaces the password (and note, if given). */
export function mergeLogins(existing: Login[], incoming: Login[], now: number): { logins: Login[]; added: number; updated: number; unchanged: number } {
  const logins = [...existing];
  let added = 0;
  let updated = 0;
  let unchanged = 0;
  for (const l of incoming) {
    const i = logins.findIndex((x) => sameSite(x.origin, l.origin) && x.username === l.username);
    if (i < 0) {
      logins.push(l);
      added++;
    } else if (logins[i]!.password !== l.password || (l.note && logins[i]!.note !== l.note)) {
      logins[i] = { ...logins[i]!, password: l.password, note: l.note || logins[i]!.note, updatedAt: now };
      updated++;
    } else unchanged++;
  }
  return { logins, added, updated, unchanged };
}

export function loginsToCsv(logins: Login[]): string {
  return toCsv([[...CSV_COLUMNS], ...logins.map((l) => [new URL(l.origin).hostname, `${l.origin}/`, l.username, l.password, l.note])]);
}

/** After a sign-in form is sent: offer to save a new login, update a changed password, or nothing. */
export function saveKind(logins: Login[], origin: string, username: string, password: string): 'save' | 'update' | null {
  if (!password) return null;
  const same = loginsFor(logins, origin).find((l) => l.username === username);
  if (!same) return 'save';
  return same.password === password ? null : 'update';
}

export function summarize(l: Login): LoginSummary {
  const { password: _, ...rest } = l;
  return rest;
}
