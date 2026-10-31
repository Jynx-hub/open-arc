// Saved passwords: one file per Profile, encrypted with the OS key (safeStorage). Passwords stay in this
// process. A page gets one login when the user picks it in the browser's native fill menu; the UI gets one
// only to reveal it. Never in State, IPC broadcasts or logs.
import { app, clipboard, ipcMain, safeStorage, systemPreferences, type MenuItemConstructorOptions, type IpcMainEvent, type IpcMainInvokeEvent, type Session, type WebContents } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PasswordList, PasswordPrompt } from '../shared/ipc';
import { parseCsv } from '../shared/csv';
import { loginOrigin, loginsFor, sameSite, loginsFromCsv, loginsToCsv, mergeLogins, saveKind, summarize, type Login } from '../shared/passwords';
import { QUIET } from './profiles';

interface Vault {
  logins: Login[];
  /** Sites the user said never to offer saving for. */
  never: string[];
}

interface PendingSave extends PasswordPrompt {
  profileId: string;
  password: string;
}

/** A sent sign-in form, held until it looks like the sign-in worked. */
interface Candidate extends PendingSave {
  /** The page navigated since; the next page says whether it still asks for a password. */
  navigated: boolean;
  timer: NodeJS.Timeout | null;
}

export interface PasswordHooks {
  /** The save prompt shown for some page changed. */
  promptChanged(): void;
  /** A Profile's saved logins changed (for an open Library). */
  listChanged(profileId: string): void;
  /** Show a native menu over `wc`'s page, `at` in page coordinates. */
  showMenu(wc: WebContents, items: MenuItemConstructorOptions[], at: { x: number; y: number }): void;
}

/** After a navigation, how long to wait to hear from the new page before offering to save anyway. */
const SETTLE_MS = 4000;
const UNLOCK_MS = 60_000;
/** Clicking a field fires mousedown then focus: one menu. */
const OFFER_GAP_MS = 500;
const MAX_FIELD = 1024;

export class Passwords {
  private vaults = new Map<string, Vault>();
  /** Profiles whose file exists but can't be decrypted: never overwritten. */
  private unreadable = new Set<string>();
  private profiles = new WeakMap<Session, string>();
  private pending = new Map<WebContents, PendingSave>();
  private candidates = new Map<WebContents, Candidate>();
  private watched = new WeakSet<WebContents>();
  private unlockedUntil = 0;
  private lastOffer = new WeakMap<WebContents, number>();
  /** The CSV each Profile last imported, which Delete the file may remove. */
  private lastImport = new Map<string, string>();

  constructor(private dir: string, private hooks: PasswordHooks) {
    ipcMain.on('pw:offer', (e, at: unknown) => this.offer(e, at));
    ipcMain.on('pw:submitted', (e, username: unknown, password: unknown) => this.submitted(e, username, password));
    // The sign-in form went away without a navigation (a single-page app signed in).
    ipcMain.on('pw:gone', (e) => this.pageOf(e) && this.promote(e.sender));
    // A page finished loading; after a sign-in navigation, a page still asking for a password means it failed.
    ipcMain.on('pw:loaded', (e, hasPassword: unknown) => {
      const c = this.pageOf(e) && this.candidates.get(e.sender);
      if (!c?.navigated) return;
      if (hasPassword === true) this.drop(e.sender);
      else this.promote(e.sender);
    });
  }

  /** A Profile session: its top-level pages get the fill menu. Private sessions are never set up. */
  setup(ses: Session, profileId: string) {
    this.profiles.set(ses, profileId);
    ses.registerPreloadScript({ type: 'frame', id: 'open-arc-passwords', filePath: path.join(__dirname, 'pagePreload.cjs') });
  }

  available(): boolean {
    return safeStorage.isEncryptionAvailable();
  }

  // ── pages ────────────────────────────────────────────────────────────────

  /**
   * The Profile and origin a page message speaks for, taken from the sender, never from the message.
   * Only a page's top frame: logins are never offered to or taken from iframes.
   */
  private pageOf(e: IpcMainEvent | IpcMainInvokeEvent): { profileId: string; origin: string; wc: WebContents } | null {
    // The tab's committed page itself: not an iframe, fenced frame or prerendered page.
    const frame = e.senderFrame;
    if (!frame || frame !== e.sender.mainFrame) return null;
    const profileId = this.profiles.get(e.sender.session);
    const origin = loginOrigin(frame.origin);
    return profileId && origin ? { profileId, origin, wc: e.sender } : null;
  }

  /** The user clicked or tabbed into a sign-in field: list the site's logins in a native menu under it. */
  private offer(e: IpcMainEvent, at: unknown) {
    const page = this.pageOf(e);
    const pos = at as { x?: unknown; y?: unknown } | null;
    if (!page || typeof pos?.x !== 'number' || typeof pos.y !== 'number' || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) return;
    const now = Date.now();
    if (now - (this.lastOffer.get(page.wc) ?? 0) < OFFER_GAP_MS) return;
    this.lastOffer.set(page.wc, now);
    const logins = loginsFor(this.vault(page.profileId).logins, page.origin);
    if (!logins.length) return;
    const items: MenuItemConstructorOptions[] = [
      { label: `Saved logins for ${new URL(page.origin).hostname}`, enabled: false },
      ...logins.map((l) => ({ label: l.username || '(no username)', click: () => this.fillChosen(page.wc, page.profileId, page.origin, l.id) })),
    ];
    this.hooks.showMenu(page.wc, items, { x: pos.x, y: pos.y });
  }

  /** Send the login the user picked to the page, if it's still on the same site. */
  private fillChosen(wc: WebContents, profileId: string, origin: string, id: string) {
    if (wc.isDestroyed()) return;
    const now = loginOrigin(wc.mainFrame.origin);
    const login = now && sameSite(now, origin) ? loginsFor(this.vault(profileId).logins, now).find((l) => l.id === id) : null;
    if (login) wc.mainFrame.send('pw:fill', login.username, login.password);
  }

  /**
   * A page sent a sign-in form. The offer to save waits until the sign-in seems to have worked: the page
   * navigated to one without a password field, or the form went away. A failed sign-in never offers to
   * overwrite a saved password.
   */
  private submitted(e: IpcMainEvent, username: unknown, password: unknown) {
    const page = this.pageOf(e);
    if (!page || typeof username !== 'string' || typeof password !== 'string') return;
    if (username.length > MAX_FIELD || password.length > MAX_FIELD) return;
    const vault = this.vault(page.profileId);
    if (!this.available() || this.unreadable.has(page.profileId) || vault.never.some((o) => sameSite(o, page.origin))) return;
    const kind = saveKind(vault.logins, page.origin, username, password);
    if (!kind) return;
    this.watch(page.wc);
    this.drop(page.wc);
    this.candidates.set(page.wc, { id: randomUUID(), origin: page.origin, username, kind, profileId: page.profileId, password, navigated: false, timer: null });
  }

  private watch(wc: WebContents) {
    if (this.watched.has(wc)) return;
    this.watched.add(wc);
    wc.on('did-navigate', () => {
      const c = this.candidates.get(wc);
      if (!c || c.navigated) return;
      c.navigated = true;
      c.timer = setTimeout(() => this.promote(wc), SETTLE_MS);
    });
    wc.once('destroyed', () => {
      this.drop(wc);
      if (this.pending.delete(wc)) this.hooks.promptChanged();
    });
  }

  private drop(wc: WebContents) {
    const c = this.candidates.get(wc);
    if (c?.timer) clearTimeout(c.timer);
    this.candidates.delete(wc);
  }

  /** The sign-in worked: show the offer. */
  private promote(wc: WebContents) {
    const c = this.candidates.get(wc);
    if (!c) return;
    this.drop(wc);
    const { navigated: _, timer: __, ...save } = c;
    this.pending.set(wc, save);
    this.hooks.promptChanged();
  }

  /** The save prompt for a window: the first page in `wcs` (most important first) with one waiting. */
  promptFor(wcs: WebContents[]): PasswordPrompt | null {
    for (const wc of wcs) {
      const p = this.pending.get(wc);
      if (p) return { id: p.id, origin: p.origin, username: p.username, kind: p.kind };
    }
    return null;
  }

  respond(id: string, answer: 'save' | 'never' | 'dismiss') {
    const entry = [...this.pending].find(([, p]) => p.id === id);
    if (!entry) return;
    const [wc, p] = entry;
    this.pending.delete(wc);
    if (answer !== 'dismiss') {
      const vault = { ...this.vault(p.profileId) };
      if (answer === 'never') vault.never = vault.never.some((o) => sameSite(o, p.origin)) ? vault.never : [...vault.never, p.origin];
      else {
        const now = Date.now();
        const same = loginsFor(vault.logins, p.origin).find((l) => l.username === p.username);
        vault.logins = same
          ? vault.logins.map((l) => (l === same ? { ...l, password: p.password, updatedAt: now } : l))
          : [...vault.logins, { id: randomUUID(), origin: p.origin, username: p.username, password: p.password, note: '', createdAt: now, updatedAt: now }];
      }
      this.write(p.profileId, vault);
    }
    this.hooks.promptChanged();
  }

  // ── the manager (Library › Passwords) ────────────────────────────────────

  list(profileId: string): PasswordList {
    const vault = this.vault(profileId);
    return {
      logins: [...vault.logins].sort((a, b) => a.origin.localeCompare(b.origin) || a.username.localeCompare(b.username)).map(summarize),
      never: [...vault.never].sort(),
      available: this.available() && !this.unreadable.has(profileId),
    };
  }

  /** Revealing, copying or exporting passwords asks for Touch ID first, then stays unlocked for a minute. */
  async authorize(reason: string): Promise<boolean> {
    if (Date.now() < this.unlockedUntil) return true;
    // Without Touch ID (no sensor, lid closed) there is nothing to ask.
    // Test runs never raise the system prompt; the env switch means nothing in a packaged app.
    const canAsk = !(QUIET && !app.isPackaged) && process.platform === 'darwin' && systemPreferences.canPromptTouchID();
    const ok = canAsk ? await systemPreferences.promptTouchID(reason).then(() => true, () => false) : true;
    if (ok) this.unlockedUntil = Date.now() + UNLOCK_MS;
    return ok;
  }

  async reveal(profileId: string, id: string): Promise<string | null> {
    const login = this.vault(profileId).logins.find((l) => l.id === id);
    if (!login || !(await this.authorize(`show the password for ${new URL(login.origin).hostname}`))) return null;
    return login.password;
  }

  async copy(profileId: string, id: string): Promise<boolean> {
    const login = this.vault(profileId).logins.find((l) => l.id === id);
    if (!login || !(await this.authorize(`copy the password for ${new URL(login.origin).hostname}`))) return false;
    clipboard.writeText(login.password);
    return true;
  }

  update(profileId: string, id: string, patch: { username: string; password?: string; note: string }) {
    const vault = { ...this.vault(profileId) };
    const now = Date.now();
    vault.logins = vault.logins.map((l) =>
      l.id === id ? { ...l, username: patch.username.slice(0, MAX_FIELD), note: patch.note, password: patch.password ? patch.password.slice(0, MAX_FIELD) : l.password, updatedAt: now } : l,
    );
    this.write(profileId, vault);
  }

  remove(profileId: string, id: string) {
    const vault = { ...this.vault(profileId) };
    vault.logins = vault.logins.filter((l) => l.id !== id);
    this.write(profileId, vault);
  }

  unblock(profileId: string, origin: string) {
    const vault = { ...this.vault(profileId) };
    vault.never = vault.never.filter((o) => o !== origin);
    this.write(profileId, vault);
  }

  importCsv(profileId: string, file: string): { added: number; updated: number; unchanged: number; skipped: number; file: string } {
    if (!this.available()) throw new Error('Passwords can’t be saved because this Mac’s keychain isn’t available.');
    const now = Date.now();
    const { logins, skipped } = loginsFromCsv(parseCsv(fs.readFileSync(file, 'utf8')), now, randomUUID);
    const vault = { ...this.vault(profileId) };
    const merged = mergeLogins(vault.logins, logins, now);
    vault.logins = merged.logins;
    this.write(profileId, vault);
    this.lastImport.set(profileId, file);
    return { added: merged.added, updated: merged.updated, unchanged: merged.unchanged, skipped, file };
  }

  /** The CSV just imported holds every password in plain text: offer to delete it. Only that file. */
  deleteImported(profileId: string): boolean {
    const file = this.lastImport.get(profileId);
    if (!file) return false;
    fs.rmSync(file, { force: true });
    this.lastImport.delete(profileId);
    return true;
  }

  async exportCsv(profileId: string, file: string): Promise<boolean> {
    if (!(await this.authorize('export your saved passwords'))) return false;
    // Plain-text passwords: owner-only, even when replacing an existing file.
    writeAtomic(file, loginsToCsv(this.vault(profileId).logins));
    return true;
  }

  /** A deleted Profile takes its passwords with it. */
  forget(profileId: string) {
    for (const [wc, c] of this.candidates) if (c.profileId === profileId) this.drop(wc);
    for (const [wc, p] of this.pending) if (p.profileId === profileId) this.pending.delete(wc);
    this.hooks.promptChanged();
    this.vaults.delete(profileId);
    this.unreadable.delete(profileId);
    fs.rmSync(this.file(profileId), { force: true });
  }

  // ── storage ──────────────────────────────────────────────────────────────

  private file(profileId: string): string {
    return path.join(this.dir, `passwords-${profileId.replace(/[^\w-]/g, '_')}.bin`);
  }

  private vault(profileId: string): Vault {
    let vault = this.vaults.get(profileId);
    if (vault) return vault;
    vault = { logins: [], never: [] };
    const file = this.file(profileId);
    if (fs.existsSync(file)) {
      try {
        const saved = JSON.parse(safeStorage.decryptString(fs.readFileSync(file))) as Partial<Vault>;
        vault = { logins: saved.logins ?? [], never: saved.never ?? [] };
      } catch {
        // A different key (another Mac, a reset keychain): keep the file untouched and save nothing over it.
        this.unreadable.add(profileId);
      }
    }
    this.vaults.set(profileId, vault);
    return vault;
  }

  private write(profileId: string, vault: Vault) {
    if (this.unreadable.has(profileId)) throw new Error('The saved passwords file can’t be read on this Mac, so it was left untouched.');
    if (!this.available()) throw new Error('Passwords can’t be saved because this Mac’s keychain isn’t available.');
    fs.mkdirSync(this.dir, { recursive: true });
    const file = this.file(profileId);
    writeAtomic(file, safeStorage.encryptString(JSON.stringify(vault)));
    this.vaults.set(profileId, vault);
    this.hooks.listChanged(profileId);
  }
}

/** Owner-only, flushed to disk, then renamed over `file`: a crash leaves the old file or the new one, never half. */
function writeAtomic(file: string, data: string | Buffer) {
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeSync(fd, typeof data === 'string' ? Buffer.from(data) : data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}
