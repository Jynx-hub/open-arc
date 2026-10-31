// Chrome extensions: loading a Profile's installed extensions, content scripts, the toolbar button and
// chrome.tabs, turning one off and on, removing it, and finding the ones installed in Arc.
import { expect, test, type ElectronApplication } from '@playwright/test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { command, launch, waitForState } from './helpers';

// Fixed by the `key` in the fixture's manifest.
const EXT_ID = 'hpcpmmbjognoiknallhbefglkdogojbh';
const FIXTURE = path.join(__dirname, 'fixtures', 'ext');

let server: http.Server;
let base = '';

test.beforeAll(async () => {
  server = http.createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end('<title>Plain</title>plain');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.afterAll(() => server.close());

/** Installed as the Web Store would leave it: `Extensions/<profile>/<id>/<version>/`. */
function seedExtension(userData: string) {
  fs.cpSync(FIXTURE, path.join(userData, 'Extensions', 'default', EXT_ID, '1.0_0'), { recursive: true });
}

function extensions(ui: Parameters<typeof command>[0]): Promise<any[]> {
  return command(ui, { type: 'extensions' }) as Promise<any[]>;
}

async function waitFor<T>(fn: () => Promise<T>, pred: (v: T) => boolean, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (pred(v)) return v;
    if (Date.now() > end) throw new Error(`never matched: ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** The content script's mark on the page at `url`, read in that page. */
function marked(app: ElectronApplication, url: string) {
  return app.evaluate(({ webContents }, u) => {
    const wc = webContents.getAllWebContents().find((w) => w.getURL() === u);
    return wc ? wc.executeJavaScript('document.documentElement.dataset.openArcExt ?? null') : 'no page';
  }, url);
}

test('an installed extension loads, runs in pages, and its sidebar button reaches chrome.tabs', async () => {
  const { app, ui } = await launch({}, seedExtension);
  await ui.keyboard.press('Escape');

  const [ext] = await waitFor(() => extensions(ui), (l) => l.length > 0);
  // The name comes from the extension's locale file, and the icon-less extension still lists.
  expect(ext).toMatchObject({ id: EXT_ID, name: 'Open Arc Test', version: '1.0', enabled: true, hasAction: true });

  await command(ui, { type: 'open', url: `${base}/`, where: 'newTab' });
  expect(await waitFor(() => marked(app, `${base}/`), (v) => v === '1')).toBe('1');

  // Not pinned: only in the extensions menu. Pinned: a button under the address.
  await expect(ui.locator('.extension-bar')).toHaveCount(0);
  await ui.click('.ext-btn');
  await expect(ui.locator('.extensions-panel .extension-row')).toContainText('Open Arc Test');
  await ui.click('.extensions-panel .pin-btn');
  await waitForState(ui, (s) => s.settings.pinnedExtensions.default?.includes(EXT_ID));
  const button = ui.locator(`.extension-bar button[is="browser-action"][id="${EXT_ID}"]`);
  await expect(button).toHaveAttribute('title', 'Open Arc Test');

  // The extension has no popup, so a click goes to its worker, which opens a tab with chrome.tabs.create.
  await button.click();
  await waitForState(ui, (s) => Object.values(s.items).some((i: any) => i.tab?.savedURL === 'about:blank#opened-by-extension'));

  await app.close();
});

test('turning an extension off unloads it until it is turned back on; removing it deletes it', async () => {
  const { app, ui, userData } = await launch({}, seedExtension);
  await ui.keyboard.press('Escape');
  await waitFor(() => extensions(ui), (l) => l.length > 0);
  await command(ui, { type: 'open', url: `${base}/`, where: 'newTab' });
  await waitFor(() => marked(app, `${base}/`), (v) => v === '1');
  await ui.evaluate((id) => (window as any).openArc.dispatch({ type: 'settings.update', patch: { pinnedExtensions: { default: [id] } } }), EXT_ID);

  expect(await command(ui, { type: 'extension', op: 'disable', id: EXT_ID })).toBe(true);
  expect(await extensions(ui)).toMatchObject([{ id: EXT_ID, enabled: false }]);
  expect(fs.existsSync(path.join(userData, 'Extensions (disabled)', 'default', EXT_ID))).toBe(true);
  await command(ui, { type: 'navigate', op: 'reload' });
  expect(await waitFor(() => marked(app, `${base}/`), (v) => v === null)).toBeNull();
  // An extension that is off has no button, even while pinned.
  await expect(ui.locator('.extension-bar')).toHaveCount(0);

  expect(await command(ui, { type: 'extension', op: 'enable', id: EXT_ID })).toBe(true);
  expect(await extensions(ui)).toMatchObject([{ id: EXT_ID, enabled: true }]);
  await command(ui, { type: 'navigate', op: 'reload' });
  expect(await waitFor(() => marked(app, `${base}/`), (v) => v === '1')).toBe('1');

  expect(await command(ui, { type: 'extension', op: 'remove', id: EXT_ID })).toBe(true);
  expect(await extensions(ui)).toEqual([]);
  expect(fs.existsSync(path.join(userData, 'Extensions', 'default', EXT_ID))).toBe(false);
  await waitForState(ui, (s) => s.settings.pinnedExtensions.default.length === 0);

  await app.close();
});

test('a tab shown in another window is moved, not registered with extensions twice', async () => {
  const { app, ui } = await launch({}, seedExtension);
  await ui.keyboard.press('Escape');
  await waitFor(() => extensions(ui), (l) => l.length > 0);
  await command(ui, { type: 'open', url: `${base}/`, where: 'newTab' });
  const s = await waitForState(ui, (st) => Object.values(st.items).some((i: any) => i.tab?.savedURL === `${base}/`));
  const id = Object.values(s.items).find((i: any) => i.tab?.savedURL === `${base}/`)!.id as string;
  await waitFor(() => marked(app, `${base}/`), (v) => v === '1');
  const listeners = () => app.evaluate(({ webContents }, u) => webContents.getAllWebContents().find((w) => w.getURL() === u)!.listenerCount('page-title-updated'), `${base}/`);
  const before = await listeners();

  const [other] = await Promise.all([app.waitForEvent('window'), command(ui, { type: 'runAction', id: 'newWindow' })]);
  await other.waitForSelector('.sidebar');
  for (const page of [other, ui, other]) await command(page, { type: 'select', id });
  expect(await listeners()).toBe(before);
  await app.close();
});

test('private windows run no extensions', async () => {
  const { app, ui } = await launch({}, seedExtension);
  await ui.keyboard.press('Escape');
  await waitFor(() => extensions(ui), (l) => l.length > 0);
  const [priv] = await Promise.all([app.waitForEvent('window'), command(ui, { type: 'runAction', id: 'newIncognitoWindow' })]);
  await priv.waitForSelector('.private-sidebar');
  await priv.keyboard.press('Escape');
  await command(priv, { type: 'open', url: `${base}/`, where: 'newTab' });
  await expect(priv.locator('.private-tab .row-title')).toHaveText('Plain');
  expect(await marked(app, `${base}/`)).toBeNull();
  expect(await command(priv, { type: 'extensions' })).toEqual([]);
  await app.close();
});

test('lists the extensions installed in Arc by name, reading only their manifests', async () => {
  const arc = fs.mkdtempSync(path.join(os.tmpdir(), 'open-arc-arcext-'));
  const profile = path.join(arc, 'User Data', 'Default', 'Extensions');
  fs.cpSync(FIXTURE, path.join(profile, EXT_ID, '1.0_0'), { recursive: true });
  fs.mkdirSync(path.join(profile, 'Temp'), { recursive: true });
  fs.mkdirSync(path.join(profile, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '0.9_0'), { recursive: true }); // no manifest: skipped
  // Another Arc profile's extension: not offered to the default Profile, which came from Arc's "Default".
  fs.cpSync(FIXTURE, path.join(arc, 'User Data', 'Profile 1', 'Extensions', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', '1.0_0'), { recursive: true });
  const { app, ui } = await launch();
  await ui.keyboard.press('Escape');
  expect(await command(ui, { type: 'arcExtensions', dir: arc })).toEqual([{ id: EXT_ID, name: 'Open Arc Test', profileDir: 'Default' }]);
  await app.close();
  fs.rmSync(arc, { recursive: true, force: true });
});
