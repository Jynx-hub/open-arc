// Chrome extensions, one set per Profile: the chrome.* APIs (electron-chrome-extensions) plus installing and
// updating from the Chrome Web Store (electron-chrome-web-store). Private sessions get none: the library
// doesn't support in-memory sessions, and an extension there could carry data out of the private window.
import { app, nativeImage, webContents, type BaseWindow, type ContextMenuParams, type MenuItem, type Session, type WebContents } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { ElectronChromeExtensions, type ChromeExtensionOptions } from 'electron-chrome-extensions';
import { downloadExtension, installChromeWebStore, loadAllExtensions, uninstallExtension } from 'electron-chrome-web-store';
import { localized, newestVersion, pickIcon, type ExtensionInfo, type Manifest } from '../shared/extensions';

type Impl = Required<Pick<ChromeExtensionOptions, 'createTab' | 'createWindow'>>;

export interface ExtensionHooks {
  /** `chrome.tabs.create`: a new tab in a Space of this Profile. */
  createTab(profileId: string, details: Parameters<Impl['createTab']>[0]): ReturnType<Impl['createTab']>;
  /** `chrome.tabs.update({active: true})`. */
  selectTab(wc: WebContents): void;
  /** The page `win` shows as its current tab, if any. */
  activeTab(win: BaseWindow): WebContents | null;
  /** `chrome.tabs.remove`. */
  closeTab(wc: WebContents): void;
  createWindow(profileId: string, details: Parameters<Impl['createWindow']>[0]): ReturnType<Impl['createWindow']>;
  closeWindow(win: BaseWindow): void;
  /** Asked before a Web Store page installs an extension. */
  confirmInstall(name: string, permissions: string[], wc: WebContents): Promise<boolean>;
  /** An extension was installed, removed, enabled or disabled. */
  changed(): void;
}

/** Tests set this so runs never reach the Web Store. */
const NO_UPDATES = process.env.OPEN_ARC_NO_EXTENSION_UPDATES === '1';

export class Extensions {
  private bySession = new Map<Session, { profileId: string; ext: ElectronChromeExtensions }>();
  /** The window each tab is registered with. The library keeps the first one, but our views move between windows. */
  private tabWindow = new WeakMap<WebContents, BaseWindow>();
  /** Set while we register a tab ourselves: the library then activates it as if an extension asked. */
  private registering: WebContents | null = null;

  constructor(private hooks: ExtensionHooks) {}

  static dir(profileId: string, enabled = true) {
    return path.join(app.getPath('userData'), enabled ? 'Extensions' : 'Extensions (disabled)', profileId);
  }

  /** Called once per Profile session, before any of its pages load. */
  setup(ses: Session, profileId: string) {
    const h = this.hooks;
    const ext = new ElectronChromeExtensions({
      session: ses,
      createTab: (details) => h.createTab(profileId, details),
      selectTab: (wc) => {
        if (wc !== this.registering) h.selectTab(wc);
      },
      // Also called after one of our own views is destroyed; only an extension's request closes a tab.
      removeTab: (wc) => {
        if (wc !== this.registering && !wc.isDestroyed()) h.closeTab(wc);
      },
      createWindow: (details) => h.createWindow(profileId, details),
      removeWindow: (win) => h.closeWindow(win),
    });
    this.bySession.set(ses, { profileId, ext });
    ses.extensions.on('extension-loaded', () => h.changed());
    ses.extensions.on('extension-unloaded', () => h.changed());
    void installChromeWebStore({
      session: ses,
      extensionsPath: Extensions.dir(profileId),
      autoUpdate: !NO_UPDATES,
      beforeInstall: async ({ localizedName, manifest, frame }) => {
        const wc = frame && !frame.isDestroyed() ? webContents.fromFrame(frame) ?? null : null;
        const ok = wc ? await h.confirmInstall(localizedName, permissionsOf(manifest as PermissionFields), wc) : false;
        return { action: ok ? 'allow' : 'deny' };
      },
    }).catch((err) => console.error('Chrome Web Store setup failed', err));
  }

  /** Make `wc` known to `chrome.tabs` as a tab of `win` (again, if it moved to another window). */
  track(wc: WebContents, win: BaseWindow) {
    const entry = this.bySession.get(wc.session);
    if (!entry || wc.isDestroyed() || this.tabWindow.get(wc) === win) return;
    const moved = this.tabWindow.has(wc);
    this.tabWindow.set(wc, win);
    if (moved) {
      // The library has no "move": removing and re-adding would attach its page listeners a second time.
      // Point its window map at the new window instead (the same two steps its addTab takes).
      const store = (entry.ext as unknown as { ctx: { store: { tabToWindow: WeakMap<WebContents, BaseWindow>; addWindow(w: BaseWindow): void } } }).ctx.store;
      store.addWindow(win);
      store.tabToWindow.set(wc, win);
      return;
    }
    this.registering = wc;
    try {
      entry.ext.addTab(wc, win);
    } finally {
      this.registering = null;
    }
    // A tab loading in the background isn't the window's current one, whatever the library assumed.
    const active = this.hooks.activeTab(win);
    if (active && active !== wc) this.selected(active);
  }

  /** The tab the user is now looking at (extensions get `tabs.onActivated`). */
  selected(wc: WebContents) {
    const entry = this.bySession.get(wc.session);
    if (entry && this.tabWindow.has(wc) && !wc.isDestroyed()) entry.ext.selectTab(wc);
  }

  /** Items extensions added with `chrome.contextMenus` for this click. */
  contextMenuItems(wc: WebContents, params: ContextMenuParams): MenuItem[] {
    const entry = this.bySession.get(wc.session);
    return entry && this.tabWindow.has(wc) ? entry.ext.getContextMenuItems(wc, params) : [];
  }

  /** Installed extensions of a Profile, enabled and disabled, by name. */
  list(ses: Session, profileId: string): ExtensionInfo[] {
    const loaded = ses.extensions.getAllExtensions().map((e) => info(e.id, e.path, e.manifest as Manifest, true));
    const disabled = installedIn(Extensions.dir(profileId, false))
      .filter(({ id }) => !loaded.some((e) => e.id === id))
      .flatMap(({ id, dir }) => {
        const manifest = readJson<Manifest>(path.join(dir, 'manifest.json'));
        return manifest ? [info(id, dir, manifest, false)] : [];
      });
    return [...loaded, ...disabled].sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Download from the Web Store, then ask (as a store page's Add button does) before loading it.
   * Returns the extension's name, or null when the user said no.
   */
  async install(ses: Session, profileId: string, id: string, confirm: (name: string, permissions: string[]) => Promise<boolean>): Promise<string | null> {
    const existing = ses.extensions.getExtension(id);
    if (existing) return existing.name;
    const root = Extensions.dir(profileId);
    const dir = await downloadExtension(id, root);
    const manifest = readJson<Manifest & PermissionFields>(path.join(dir, 'manifest.json'));
    const { name } = info(id, dir, manifest ?? {}, true);
    if (!manifest || !(await confirm(name, permissionsOf(manifest)))) {
      await fs.promises.rm(path.join(root, id), { recursive: true, force: true });
      return null;
    }
    await loadAllExtensions(ses, root);
    if (!ses.extensions.getExtension(id)) throw new Error(`${id} downloaded but did not load`);
    return name;
  }

  async remove(ses: Session, profileId: string, id: string) {
    await uninstallExtension(id, { session: ses, extensionsPath: Extensions.dir(profileId) });
    await fs.promises.rm(path.join(Extensions.dir(profileId, false), id), { recursive: true, force: true });
    this.hooks.changed();
  }

  /** Disabling moves the extension's folder aside, so neither loading nor updating sees it. */
  async setEnabled(ses: Session, profileId: string, id: string, enabled: boolean) {
    const from = path.join(Extensions.dir(profileId, !enabled), id);
    const to = path.join(Extensions.dir(profileId, enabled), id);
    if (!fs.existsSync(from)) return;
    if (!enabled && ses.extensions.getExtension(id)) ses.extensions.removeExtension(id);
    await fs.promises.mkdir(path.dirname(to), { recursive: true });
    await fs.promises.rm(to, { recursive: true, force: true });
    await fs.promises.rename(from, to);
    if (enabled) {
      await loadAllExtensions(ses, Extensions.dir(profileId));
      // The loader only logs failures. One that won't load goes back to the disabled list, where it can be removed.
      if (!ses.extensions.getExtension(id)) {
        await fs.promises.rename(to, from);
        this.hooks.changed();
        throw new Error(`${id} did not load`);
      }
    }
    this.hooks.changed();
  }
}

interface PermissionFields {
  permissions?: string[];
  host_permissions?: string[];
  content_scripts?: { matches?: string[] }[];
}

/** What the install prompt lists: API permissions, and the sites it can read (granted, or where its scripts run). */
function permissionsOf(m: PermissionFields): string[] {
  const sites = (m.content_scripts ?? []).flatMap((c) => c.matches ?? []);
  return [...new Set([...(m.permissions ?? []), ...(m.host_permissions ?? []), ...sites])].filter((p) => typeof p === 'string');
}

function info(id: string, dir: string, manifest: Manifest, enabled: boolean): ExtensionInfo {
  const messages = manifest.default_locale ? readJson<Record<string, { message?: string }>>(path.join(dir, '_locales', manifest.default_locale, 'messages.json')) : null;
  const iconPath = pickIcon(manifest.icons, 32);
  let icon: string | null = null;
  if (iconPath) {
    const file = path.resolve(dir, iconPath.replace(/^\//, ''));
    const rel = path.relative(dir, file);
    const image = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? nativeImage.createFromPath(file) : null;
    if (image && !image.isEmpty()) icon = image.resize({ width: 32, height: 32 }).toDataURL();
  }
  return {
    id,
    name: localized(manifest.name, messages, id),
    version: manifest.version ?? '',
    description: localized(manifest.description, messages, ''),
    icon,
    enabled,
    hasAction: !!(manifest.action || manifest.browser_action),
  };
}

/** `<root>/<id>/<version>/` folders (the Web Store layout, also Chrome's and Arc's), newest version per id. */
export function installedIn(root: string): { id: string; dir: string }[] {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).flatMap((id) => {
    const idDir = path.join(root, id);
    let versions: string[];
    try {
      versions = fs.readdirSync(idDir).filter((v) => fs.existsSync(path.join(idDir, v, 'manifest.json')));
    } catch {
      return [];
    }
    const v = newestVersion(versions);
    return v ? [{ id, dir: path.join(idDir, v) }] : [];
  });
}

export function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')) as T;
  } catch {
    return null;
  }
}
