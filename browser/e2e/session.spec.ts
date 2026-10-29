// Private windows, media (mini player, Picture in Picture), print and page fullscreen.
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
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
      res.setHeader('content-disposition', 'attachment; filename="private.txt"');
      return res.end('from a private window\n');
    }
    res.setHeader('content-type', 'text/html');
    if (url === '/cookie') {
      res.setHeader('set-cookie', 'secret=1; Path=/');
      return res.end('<title>Cookie</title>cookie set');
    }
    // The page's title shows which cookies it can see.
    if (url === '/echo') return res.end(`<script>document.title = 'cookie:' + (document.cookie || 'none')</script>`);
    res.end('<title>Plain</title>plain');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.afterAll(() => server.close());

/** Run JS in the page whose URL starts with `prefix`, as a user gesture. */
function inPage(app: ElectronApplication, prefix: string, js: string) {
  return app.evaluate(({ webContents }, [p, code]) => webContents.getAllWebContents().find((w) => w.getURL().startsWith(p!))!.executeJavaScript(code!, true), [prefix, js]);
}

async function openTab(ui: Page, url: string, title: string) {
  await command(ui, { type: 'open', url, where: 'newTab' });
  return waitForState(ui, (s) => Object.values(s.items).some((i: any) => i.tab?.savedTitle === title));
}

test('a private window keeps its pages, cookies and downloads out of the normal windows and off disk', async () => {
  const downloads = fs.mkdtempSync(path.join(os.tmpdir(), 'open-arc-dl-'));
  const { app, ui, userData } = await launch({ OPEN_ARC_DOWNLOADS_DIR: downloads });
  await ui.keyboard.press('Escape');
  const before = await state(ui);

  const [priv] = await Promise.all([app.waitForEvent('window'), command(ui, { type: 'runAction', id: 'newIncognitoWindow' })]);
  await priv.waitForSelector('.private-sidebar');
  // A new private window starts in the Command Bar.
  await priv.waitForSelector('.command-bar');
  await priv.keyboard.press('Escape');
  await command(priv, { type: 'open', url: `${base}/cookie`, where: 'newTab' });
  await expect(priv.locator('.private-tab .row-title')).toHaveText('Cookie');

  // The cookie lives in the private session only; a normal tab on the same site can't see it.
  const cookies = await app.evaluate(async ({ webContents, session }, [url, profileId]) => {
    const wc = webContents.getAllWebContents().find((w) => w.getURL() === `${url}/cookie`)!;
    return { priv: (await wc.session.cookies.get({ url })).length, normal: (await session.fromPartition(`persist:profile-${profileId}`).cookies.get({ url })).length };
  }, [base, before.spaces[0].profileId]);
  expect(cookies).toEqual({ priv: 1, normal: 0 });
  await openTab(ui, `${base}/echo`, 'cookie:none');

  // A private download is listed nowhere and never saved, but the file itself lands in Downloads.
  await command(priv, { type: 'open', url: `${base}/file.txt`, where: 'current' });
  await waitForState(ui, (s) => s.downloads.some((d: any) => d.private && d.state === 'completed'));
  expect(fs.existsSync(path.join(downloads, 'private.txt'))).toBe(true);

  // Only the normal tab became an item; the saved file has the normal visit and nothing private.
  const after = await state(ui);
  expect(Object.keys(after.items).length).toBe(Object.keys(before.items).length + 1);
  await ui.waitForTimeout(700); // past the save debounce
  const saved = fs.readFileSync(path.join(userData, 'state.json'), 'utf8');
  expect(saved).toContain(`${base}/echo`);
  expect(saved).not.toContain(`${base}/cookie`);
  expect(saved).not.toContain('private.txt');

  // Closing the window drops its download entry and its session's cookies.
  const partition = await app.evaluate(({ webContents }, url) => {
    const wc = webContents.getAllWebContents().find((w) => w.getURL() === `${url}/cookie`)!;
    const p = (wc.session as unknown as { storagePath: string | null }).storagePath;
    return p;
  }, base);
  expect(partition).toBeNull(); // in memory: nothing on disk to begin with
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('#incognito'))!.close());
  await waitForState(ui, (s) => !s.downloads.some((d: any) => d.private));
  await app.close();
});
