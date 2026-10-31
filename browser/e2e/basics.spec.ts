// Browser basics: the page context menu, downloads, and site permission prompts.
import { expect, test, type ElectronApplication } from '@playwright/test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { command, launch, state, waitForState } from './helpers';

let server: http.Server;
let base = '';

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    if (url.startsWith('/file.txt')) {
      res.setHeader('content-type', 'text/plain');
      res.setHeader('content-disposition', 'attachment; filename="report.txt"');
      return res.end('hello from the test server\n');
    }
    res.setHeader('content-type', 'text/html');
    if (url === '/geo') {
      // The result lands on window.geo so the test can read it.
      return res.end(`<title>Geo</title><script>
        window.geo = 'pending';
        window.ask = () => navigator.geolocation.getCurrentPosition(() => (window.geo = 'allowed'), (e) => (window.geo = 'error ' + e.code));
      </script>`);
    }
    res.end(`<title>Links</title><body style="margin:0"><a id="dl" href="/file.txt" style="display:block;width:300px;height:60px">download</a><a id="other" href="/target" style="display:block;width:300px;height:60px">target</a></body>`);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.afterAll(() => server.close());

/** Run JS in the page whose URL starts with `prefix`, as a user gesture. */
function inPage(app: ElectronApplication, prefix: string, js: string) {
  return app.evaluate(({ webContents }, [p, code]) => webContents.getAllWebContents().find((w) => w.getURL().startsWith(p!))!.executeJavaScript(code!, true), [prefix, js]);
}

async function openTab(ui: Parameters<typeof command>[0], url: string, title: string) {
  await command(ui, { type: 'open', url, where: 'newTab' });
  return waitForState(ui, (s) => Object.values(s.items).some((i: any) => i.tab?.savedTitle === title));
}

test('right-click on a link shows the link menu, and its items work', async () => {
  const { app, ui } = await launch();
  await ui.keyboard.press('Escape');
  const s0 = await openTab(ui, `${base}/links`, 'Links');
  const todayRoot = s0.spaces[0].todayRootId;

  // Native menus can't be clicked from Playwright: keep the built menu instead of showing it.
  await app.evaluate(({ Menu }) => {
    Menu.prototype.popup = function (this: Electron.Menu) {
      (globalThis as any).lastMenu = this;
    };
  });
  await app.evaluate(({ webContents }, prefix) => {
    const wc = webContents.getAllWebContents().find((w) => w.getURL().startsWith(prefix))!;
    wc.sendInputEvent({ type: 'mouseDown', x: 40, y: 90, button: 'right', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x: 40, y: 90, button: 'right', clickCount: 1 });
  }, `${base}/links`);
  await expect.poll(() => app.evaluate(() => (globalThis as any).lastMenu?.items.map((i: any) => i.label) ?? [])).toContain('Open Link in New Tab');
  const labels: string[] = await app.evaluate(() => (globalThis as any).lastMenu.items.map((i: any) => i.label));
  expect(labels).toEqual(expect.arrayContaining(['Open Link Side by Side', 'Copy Link', 'Inspect Element']));
  expect(labels).not.toContain('Reload');

  await app.evaluate(() => (globalThis as any).lastMenu.items.find((i: any) => i.label === 'Copy Link').click());
  expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(`${base}/target`);

  // Opens in the background: a new Today tab, while the selection stays put.
  const selectedBefore = (await ui.evaluate(() => (window as any).openArc.getWindow())).selectedId;
  await app.evaluate(() => (globalThis as any).lastMenu.items.find((i: any) => i.label === 'Open Link in New Tab').click());
  const s1 = await waitForState(ui, (s) => s.items[todayRoot].children.some((id: string) => s.items[id].tab?.savedURL === `${base}/target`));
  expect(s1.items[todayRoot].children).toHaveLength(2);
  expect((await ui.evaluate(() => (window as any).openArc.getWindow())).selectedId).toBe(selectedBefore);
  await app.close();
});

test('downloads save to the downloads folder with unique names and are listed', async () => {
  const downloads = fs.mkdtempSync(path.join(os.tmpdir(), 'open-arc-dl-'));
  const { app, ui } = await launch({ OPEN_ARC_DOWNLOADS_DIR: downloads });
  await ui.keyboard.press('Escape');
  await openTab(ui, `${base}/links`, 'Links');

  await inPage(app, `${base}/links`, `document.getElementById('dl').click()`);
  let s = await waitForState(ui, (x) => x.downloads[0]?.state === 'completed');
  expect(s.downloads[0]).toMatchObject({ filename: 'report.txt', url: `${base}/file.txt`, path: path.join(downloads, 'report.txt') });
  expect(fs.readFileSync(path.join(downloads, 'report.txt'), 'utf8')).toBe('hello from the test server\n');
  await expect(ui.locator('.toast').filter({ hasText: 'Downloaded report.txt' })).toBeVisible();

  // Same name again: numbered, the first file untouched.
  await inPage(app, `${base}/links`, `document.getElementById('dl').click()`);
  s = await waitForState(ui, (x) => x.downloads.length === 2 && x.downloads[0].state === 'completed');
  expect(s.downloads[0].filename).toBe('report (1).txt');
  expect(fs.existsSync(path.join(downloads, 'report (1).txt'))).toBe(true);

  // The sidebar popover lists them; removing one keeps the file.
  await ui.locator('.downloads-btn').click();
  await expect(ui.locator('.downloads-panel .download')).toHaveCount(2);
  await command(ui, { type: 'download', op: 'remove', id: s.downloads[0].id });
  await expect(ui.locator('.downloads-panel .download')).toHaveCount(1);
  expect(fs.existsSync(path.join(downloads, 'report (1).txt'))).toBe(true);
  await app.close();
  fs.rmSync(downloads, { recursive: true, force: true });
});

test('a site asking for location gets a prompt; Block is remembered across reloads', async () => {
  const { app, ui } = await launch();
  await ui.keyboard.press('Escape');
  await openTab(ui, `${base}/geo`, 'Geo');

  await inPage(app, `${base}/geo`, 'ask()');
  const prompt = ui.locator('.permission-prompt');
  await expect(prompt).toContainText('127.0.0.1 wants to know your location');
  expect(await inPage(app, `${base}/geo`, 'window.geo')).toBe('pending');

  await prompt.locator('.perm-block').click();
  await expect(prompt).toHaveCount(0);
  await expect.poll(() => inPage(app, `${base}/geo`, 'window.geo')).toBe('error 1');
  const s = await state(ui);
  expect(s.settings.sitePermissions[base]).toEqual({ geolocation: 'deny' });

  // After a reload the saved answer applies at once: no prompt.
  await command(ui, { type: 'navigate', op: 'reload' });
  await expect.poll(() => inPage(app, `${base}/geo`, 'window.geo')).toBe('pending');
  await inPage(app, `${base}/geo`, 'ask()');
  await expect.poll(() => inPage(app, `${base}/geo`, 'window.geo')).toBe('error 1');
  await expect(prompt).toHaveCount(0);

  // The site panel shows the saved answer; Reset makes the site ask again.
  await ui.locator('.site-btn').click();
  await expect(ui.locator('.site-panel')).toContainText('Know your location');
  await ui.locator('.site-panel button', { hasText: 'Reset' }).click();
  expect((await state(ui)).settings.sitePermissions).toEqual({});
  await inPage(app, `${base}/geo`, 'ask()');
  await expect(prompt).toBeVisible();

  // Answering from the site panel instead settles the waiting prompt too.
  await ui.evaluate((origin) => (window as any).openArc.dispatch({ type: 'sitePermission.set', origin, permission: 'geolocation', decision: 'deny' }), base);
  await expect(prompt).toHaveCount(0);
  await expect.poll(() => inPage(app, `${base}/geo`, 'window.geo')).toBe('error 1');
  await app.close();
});
