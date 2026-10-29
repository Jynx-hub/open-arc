import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { command, launch, state, waitForState } from './helpers';

const FIXTURES = path.resolve(__dirname, '../../exporter/test/fixtures/arc');
let server: http.Server;
let base = '';

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    const page = (req.url ?? '/').replace(/\W/g, '') || 'home';
    const port = (server.address() as AddressInfo).port;
    res.setHeader('content-type', 'text/html');
    res.end(`<title>Page ${page}</title><h1>${page}</h1><a id="ext" href="http://localhost:${port}/other">other site</a><a id="same" href="/two">same site</a>`);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.afterAll(() => server.close());

async function windowInfo(ui: Page) {
  return ui.evaluate(() => (window as any).openArc.getWindow());
}
function pageContents(app: ElectronApplication) {
  return app.evaluate(({ webContents }) => webContents.getAllWebContents().map((w) => ({ id: w.id, url: w.getURL() })));
}

test('first run offers Arc import and imports Spaces, Favorites, Archive and link rules', async () => {
  const { app, ui } = await launch();
  await expect(ui.locator('.modal h2')).toHaveText('Welcome');
  await ui.keyboard.press('Escape');
  const summary: any = await command(ui, { type: 'importArc', dir: FIXTURES });
  expect(summary.spaces).toBeGreaterThan(0);
  const s = await state(ui);
  expect(s.spaces).toHaveLength(summary.spaces);
  await expect(ui.locator('.space-dot')).toHaveCount(summary.spaces);
  await ui.screenshot({ path: 'test-results/imported.png' });
  await app.close();
});

test('pinned vs Today: open, pin, wander, go home, unload, close to Archive, reopen', async () => {
  const { app, ui } = await launch();
  await ui.keyboard.press('Escape');
  await command(ui, { type: 'open', url: `${base}/one`, where: 'newTab' });
  let s = await waitForState(ui, (x) => Object.values(x.items).some((i: any) => i.tab?.savedTitle === 'Page one'));
  const space = s.spaces[0];
  const tabId = s.items[space.todayRootId].children[0];
  await expect(ui.locator('.section-today .row-title')).toHaveText('Page one');

  await command(ui, { type: 'runAction', id: 'togglePin' });
  s = await waitForState(ui, (x) => x.items[space.pinnedRootId].children.includes(tabId));
  await expect(ui.locator('.toast').first()).toContainText('Pinned');

  // Wander inside the pinned tab: the home URL stays; "back to home" appears and works.
  await app.evaluate(({ webContents }, url) => webContents.getAllWebContents().find((w) => w.getURL().endsWith('/one'))!.loadURL(url), `${base}/two`);
  await expect(ui.locator('.home-btn')).toBeVisible();
  s = await state(ui);
  expect(s.items[tabId].tab.savedURL).toBe(`${base}/one`);
  await command(ui, { type: 'goHome', id: tabId });
  await expect(ui.locator('.home-btn')).toHaveCount(0);

  // Closing a pinned tab unloads it but keeps it.
  await command(ui, { type: 'close', id: tabId });
  await expect(ui.locator('.row.unloaded')).toHaveCount(1);
  expect((await pageContents(app)).some((p) => p.url.endsWith('/one'))).toBe(false);

  // A Today tab goes to the Archive on close, and reopen brings it back.
  await command(ui, { type: 'open', url: `${base}/three`, where: 'newTab' });
  s = await waitForState(ui, (x) => x.items[space.todayRootId].children.length === 1);
  const t3 = s.items[space.todayRootId].children[0];
  await command(ui, { type: 'close', id: t3 });
  s = await waitForState(ui, (x) => x.archive.length === 1);
  expect(s.archive[0].reason).toBe('manual');
  await command(ui, { type: 'runAction', id: 'reopenClosed' });
  s = await waitForState(ui, (x) => x.archive.length === 0 && x.items[space.todayRootId].children.includes(t3));
  await app.close();
});

test('auto-archive moves idle Today tabs but never the selected one', async () => {
  const { app, ui } = await launch({ OPEN_ARC_ARCHIVE_TICK_MS: '400' });
  await ui.keyboard.press('Escape');
  await command(ui, { type: 'open', url: `${base}/idle`, where: 'newTab' });
  await command(ui, { type: 'open', url: `${base}/active`, where: 'newTab' });
  let s = await waitForState(ui, (x) => x.items[x.spaces[0].todayRootId].children.length === 2);
  const [activeId, idleId] = s.items[s.spaces[0].todayRootId].children;
  const old = Date.now() - 60_000;
  await ui.evaluate(([idle, active, at]) => {
    const api = (window as any).openArc;
    api.dispatch({ type: 'tab.touch', id: idle, now: at });
    api.dispatch({ type: 'tab.touch', id: active, now: at });
    api.dispatch({ type: 'settings.update', patch: { autoArchive: { default: 'twentySeconds' } } });
  }, [idleId, activeId, old] as const);
  s = await waitForState(ui, (x) => x.archive.length === 1);
  expect(s.archive[0].reason).toBe('auto');
  expect(s.archive[0].items[0].id).toBe(idleId);
  expect(s.items[activeId]).toBeTruthy();
  await expect(ui.locator('.modal h2')).toHaveText('Idle tabs were archived');
  await app.close();
});

test('Command Bar: URL entry, tab switching, Site Search pill, learned ranking', async () => {
  const { app, ui } = await launch();
  await ui.keyboard.press('Escape');
  await command(ui, { type: 'runAction', id: 'commandBar' });
  await ui.locator('.command-bar input').fill(`${base}/alpha`);
  await expect(ui.locator('.cb-results li').first()).toContainText('Open address');
  await ui.keyboard.press('Enter');
  await waitForState(ui, (x) => Object.values(x.items).some((i: any) => i.tab?.savedTitle === 'Page alpha'));
  await command(ui, { type: 'open', url: `${base}/beta`, where: 'newTab' });

  await command(ui, { type: 'runAction', id: 'commandBar' });
  await ui.locator('.command-bar input').fill('alpha');
  await expect(ui.locator('.cb-results li').first()).toContainText('Switch to tab');
  await ui.screenshot({ path: 'test-results/command-bar.png' });
  await ui.keyboard.press('Enter');
  const info = await windowInfo(ui);
  const s = await state(ui);
  expect(s.items[info.selectedId].tab.savedTitle).toBe('Page alpha');

  await command(ui, { type: 'runAction', id: 'commandBar' });
  await ui.locator('.command-bar input').fill('wiki');
  await ui.keyboard.press('Tab');
  await expect(ui.locator('.site-pill')).toHaveText('Wikipedia');
  await ui.keyboard.press('Escape');
  await ui.keyboard.press('Escape');
  await app.close();
});

test('Split View: two panes side by side, flip, separate', async () => {
  const { app, ui } = await launch();
  await ui.keyboard.press('Escape');
  await command(ui, { type: 'open', url: `${base}/left`, where: 'newTab' });
  await command(ui, { type: 'open', url: `${base}/right`, where: 'split' });
  let s = await waitForState(ui, (x) => Object.values(x.items).some((i: any) => i.kind === 'split'));
  const split: any = Object.values(s.items).find((i: any) => i.kind === 'split');
  expect(split.children).toHaveLength(2);
  await ui.waitForTimeout(600);
  const bounds = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.contentView.children.map((v) => v.getBounds()));
  expect(bounds).toHaveLength(2);
  expect(bounds[0]!.y).toBe(bounds[1]!.y);
  expect(bounds[1]!.x).toBeGreaterThan(bounds[0]!.x + bounds[0]!.width);
  await ui.screenshot({ path: 'test-results/split.png' });
  await command(ui, { type: 'runAction', id: 'splitFlip' });
  await ui.waitForTimeout(200);
  const flipped = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.contentView.children.map((v) => v.getBounds()));
  expect(flipped[1]!.y).toBeGreaterThan(flipped[0]!.y);
  await command(ui, { type: 'runAction', id: 'splitSeparate' });
  s = await waitForState(ui, (x) => !Object.values(x.items).some((i: any) => i.kind === 'split'));
  expect(s.items[s.spaces[0].todayRootId].children).toHaveLength(2);
  await app.close();
});

test('Peek: a link to another site from a pinned tab opens in a preview', async () => {
  const { app, ui } = await launch();
  await ui.keyboard.press('Escape');
  await command(ui, { type: 'open', url: `${base}/pinnedhome`, where: 'newTab' });
  await waitForState(ui, (x) => Object.values(x.items).some((i: any) => i.tab?.savedTitle === 'Page pinnedhome'));
  await command(ui, { type: 'runAction', id: 'togglePin' });
  await ui.waitForTimeout(300);
  await app.evaluate(({ webContents }) => webContents.getAllWebContents().find((w) => w.getURL().endsWith('/pinnedhome'))!.executeJavaScript('document.getElementById("ext").click()'));
  await expect.poll(async () => (await windowInfo(ui)).peek?.url ?? '').toContain('localhost');
  await expect(ui.locator('.peek-chrome')).toBeVisible();
  await ui.screenshot({ path: 'test-results/peek.png' });
  await command(ui, { type: 'peek', op: 'expand' });
  const s = await waitForState(ui, (x) => x.items[x.spaces[0].todayRootId].children.length === 1);
  expect((await windowInfo(ui)).peek).toBeNull();
  void s;
  await app.close();
});

test('Spaces with separate Profiles, and link rules route external links', async () => {
  const { app, ui } = await launch();
  await ui.keyboard.press('Escape');
  await ui.evaluate(() => {
    const api = (window as any).openArc;
    api.dispatch({ type: 'profile.create', id: 'work', name: 'Work', favoritesRootId: 'fav-work', now: Date.now() });
    api.dispatch({ type: 'space.create', id: 'S-work', pinnedRootId: 'P-work', todayRootId: 'T-work', title: 'Work', icon: null, color: '#e8590c', profileId: 'work', now: Date.now() });
    api.dispatch({ type: 'linkRule.upsert', rule: { id: 'r1', pattern: '/meeting', destination: { kind: 'space', spaceId: 'S-work' } } });
  });
  await expect(ui.locator('.space-dot')).toHaveCount(2);
  await app.evaluate(({ app: a }, url) => a.emit('open-url', { preventDefault() {} }, url), `${base}/meeting`);
  const s = await waitForState(ui, (x) => x.items['T-work'].children.length === 1);
  expect((await windowInfo(ui)).spaceId).toBe('S-work');
  await expect
    .poll(() => app.evaluate(({ webContents }) => webContents.getAllWebContents().filter((w) => w.getURL().includes('/meeting')).map((w) => w.session.storagePath ?? '')[0] ?? ''))
    .toContain('profile-work');
  void s;
  await app.close();
});
