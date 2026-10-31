// Saved passwords: CSV import, filling from the menu under a sign-in field, the save prompt, and keeping
// passwords out of State and off other sites.
import { expect, test, type ElectronApplication } from '@playwright/test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { command, launch, state, waitForState } from './helpers';

let server: http.Server;
let port = 0;
// Two origins on one server: 127.0.0.1 has a saved login, localhost doesn't.
const site = () => `http://127.0.0.1:${port}`;
const other = () => `http://localhost:${port}`;

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    if (req.url?.startsWith('/welcome')) return res.end('<title>Welcome</title>signed in');
    // A password field the user can't see: no menu may open for it.
    if (req.url?.startsWith('/trap')) return res.end('<title>Login</title><body style="margin:0"><input id="p" type="password" style="opacity:0;width:200px;height:24px;margin:20px">');
    // /login?fail sends the form back to a sign-in page, as a wrong password does.
    const action = req.url?.includes('fail') ? '/login' : '/welcome';
    res.end(`<title>Login</title><body style="margin:0"><form action="${action}" method="get" style="padding:20px">
      <input id="u" name="u" autocomplete="username" style="display:block;width:200px;height:24px">
      <input id="p" name="p" type="password" style="display:block;width:200px;height:24px;margin-top:8px">
      <button id="go" style="display:block;width:100px;height:24px;margin-top:8px">Sign in</button>
    </form>`);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
test.afterAll(() => server.close());

function inPage(app: ElectronApplication, prefix: string, js: string) {
  return app.evaluate(({ webContents }, [p, code]) => webContents.getAllWebContents().find((w) => w.getURL().startsWith(p!))!.executeJavaScript(code!), [prefix, js]);
}

/** A real (trusted) click at page coordinates, as a user would make it. */
function click(app: ElectronApplication, prefix: string, x: number, y: number) {
  return app.evaluate(({ webContents }, [p, cx, cy]) => {
    const wc = webContents.getAllWebContents().find((w) => w.getURL().startsWith(p as string))!;
    wc.sendInputEvent({ type: 'mouseDown', x: cx as number, y: cy as number, button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x: cx as number, y: cy as number, button: 'left', clickCount: 1 });
  }, [prefix, x, y]);
}

async function clickElement(app: ElectronApplication, prefix: string, selector: string) {
  const r = await inPage(app, prefix, `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left + 10, y: r.top + r.height / 2 }; })()`);
  await click(app, prefix, Math.round(r.x), Math.round(r.y));
}

async function openTab(ui: Parameters<typeof command>[0], url: string) {
  await command(ui, { type: 'open', url, where: 'newTab' });
  await waitForState(ui, (s) => Object.values(s.items).some((i: any) => i.tab?.savedURL === url && i.tab?.savedTitle === 'Login'));
}

test('imported logins fill only on their own site, and never reach State', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-arc-pw-'));
  const csv = path.join(dir, 'Arc Passwords.csv');
  fs.writeFileSync(csv, `name,url,username,password,note\n127.0.0.1,${site()}/login,ann@example.com,"s3cret,pw","a ""quoted"" note"\napp,android://x@com.example/,bob,pw,\n`);
  const { app, ui, userData } = await launch();
  await ui.keyboard.press('Escape');

  const result: any = await command(ui, { type: 'passwords', op: 'import', file: csv });
  expect(result).toMatchObject({ added: 1, updated: 0, skipped: 1 });
  const list: any = await command(ui, { type: 'passwords', op: 'list' });
  expect(list.logins).toHaveLength(1);
  expect(list.logins[0]).toMatchObject({ origin: site(), username: 'ann@example.com', note: 'a "quoted" note' });
  expect(JSON.stringify(list)).not.toContain('s3cret');

  // The CSV can be deleted from here; only the file just imported.
  expect(await command(ui, { type: 'passwords', op: 'deleteImported' })).toBe(true);
  expect(fs.existsSync(csv)).toBe(false);

  // The fill menu is a native menu (drawn by the browser, out of the page's reach). Menus can't be
  // clicked from Playwright, and would show on screen: keep each built menu instead.
  await app.evaluate(({ Menu }) => {
    Menu.prototype.popup = function (this: Electron.Menu) {
      (globalThis as any).menus = [...((globalThis as any).menus ?? []), this];
    };
  });
  const menus = (): Promise<string[][]> => app.evaluate(() => ((globalThis as any).menus ?? []).map((m: any) => m.items.map((i: any) => i.label)));
  const clearMenus = () => app.evaluate(() => void ((globalThis as any).menus = []));

  // Clicking the username field offers the login; picking it fills both fields.
  await openTab(ui, `${site()}/login`);
  await clickElement(app, `${site()}/login`, '#u');
  await expect.poll(menus).toEqual([['Saved logins for 127.0.0.1', 'ann@example.com']]);
  expect(await inPage(app, `${site()}/login`, `document.querySelector('#p').value`)).toBe('');
  await app.evaluate(() => (globalThis as any).menus[0].items[1].click());
  await expect.poll(() => inPage(app, `${site()}/login`, `[document.querySelector('#u').value, document.querySelector('#p').value]`)).toEqual(['ann@example.com', 's3cret,pw']);

  // The page focusing a field itself opens nothing.
  await clearMenus();
  await openTab(ui, `${site()}/login?again`);
  await inPage(app, `${site()}/login?again`, `document.querySelector('#p').focus()`);
  await new Promise((r) => setTimeout(r, 500));
  expect(await menus()).toEqual([]);

  // Another origin gets nothing.
  await openTab(ui, `${other()}/login`);
  await clickElement(app, `${other()}/login`, '#u');
  await clickElement(app, `${other()}/login`, '#p');
  // A field the user can't see never gets the menu.
  await openTab(ui, `${site()}/trap`);
  await clickElement(app, `${site()}/trap`, '#p');
  await new Promise((r) => setTimeout(r, 500));
  expect(await menus()).toEqual([]);

  // Revealing hands back the password (Touch ID is skipped in test runs); nothing on disk is readable.
  expect(await command(ui, { type: 'passwords', op: 'reveal', id: list.logins[0].id })).toBe('s3cret,pw');
  await app.evaluate(() => new Promise((r) => setTimeout(r, 600))); // let state.json save
  for (const f of fs.readdirSync(userData).filter((f) => f === 'state.json' || f.startsWith('passwords-'))) {
    expect(fs.readFileSync(path.join(userData, f)).includes('s3cret')).toBe(false);
  }
  expect(fs.readdirSync(userData).some((f) => /^passwords-.+\.bin$/.test(f))).toBe(true);
  expect(JSON.stringify(await state(ui))).not.toContain('s3cret');
  await app.close();
});

test('signing in offers to save the login, then to update a changed password', async () => {
  const { app, ui } = await launch();
  await ui.keyboard.press('Escape');
  const signIn = async (user: string, pw: string, page = 'login') => {
    await openTab(ui, `${other()}/${page}`);
    await inPage(app, `${other()}/${page}`, `document.querySelector('#u').value = ${JSON.stringify(user)}; document.querySelector('#p').value = ${JSON.stringify(pw)}`);
    await clickElement(app, `${other()}/${page}`, '#go');
  };

  // A sign-in that comes back to a password form failed: nothing to save.
  await signIn('typo-user', 'wrong-pw', 'login?fail');
  await waitForState(ui, (s) => Object.values(s.items).some((i: any) => i.tab?.savedURL?.startsWith(`${other()}/login?u=typo-user`)));
  await new Promise((r) => setTimeout(r, 4500)); // past main's fallback (SETTLE_MS), so a missed "failed" signal would show
  await expect(ui.locator('.password-prompt')).toHaveCount(0);

  await signIn('new-user', 'first-pw');
  const prompt = ui.locator('.password-prompt');
  await expect(prompt).toContainText('Save the password for new-user on localhost');
  expect(JSON.stringify(await ui.evaluate(() => (window as any).openArc.getWindow()))).not.toContain('first-pw');
  await prompt.locator('.pw-save').click();
  await expect(prompt).toHaveCount(0);
  const list: any = await command(ui, { type: 'passwords', op: 'list' });
  expect(list.logins).toMatchObject([{ origin: other(), username: 'new-user' }]);

  // A page sending the form by script, with no user action, offers nothing.
  await openTab(ui, `${other()}/login`);
  await inPage(app, `${other()}/login`, `document.querySelector('#u').value = 'planted'; document.querySelector('#p').value = 'planted-pw'; document.querySelector('form').requestSubmit()`);
  await waitForState(ui, (s) => Object.values(s.items).some((i: any) => i.tab?.savedURL?.includes('u=planted')));
  await new Promise((r) => setTimeout(r, 4500));
  await expect(prompt).toHaveCount(0);

  // The same password again: nothing to offer. A new one: update.
  await signIn('new-user', 'first-pw');
  await waitForState(ui, (s) => Object.values(s.items).filter((i: any) => i.tab?.savedTitle === 'Welcome').length === 3);
  await expect(prompt).toHaveCount(0);
  await signIn('new-user', 'second-pw');
  await expect(prompt).toContainText('Update the saved password for new-user');
  await prompt.locator('.pw-save').click();
  expect(await command(ui, { type: 'passwords', op: 'reveal', id: list.logins[0].id })).toBe('second-pw');

  // "Never for this site" stops the offers there.
  await signIn('someone-else', 'pw');
  await prompt.locator('.pw-never').click();
  await signIn('third-user', 'pw');
  await waitForState(ui, (s) => Object.values(s.items).filter((i: any) => i.tab?.savedTitle === 'Welcome').length === 6);
  await expect(prompt).toHaveCount(0);
  expect(((await command(ui, { type: 'passwords', op: 'list' })) as any).never).toEqual([other()]);
  await app.close();
});

test('the Library lists saved logins without their passwords', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-arc-pw-'));
  const csv = path.join(dir, 'p.csv');
  fs.writeFileSync(csv, `url,username,password\n${site()},ann,hidden-pw\n`);
  const { app, ui } = await launch();
  await ui.keyboard.press('Escape');
  await command(ui, { type: 'passwords', op: 'import', file: csv });
  await command(ui, { type: 'runAction', id: 'passwords' });
  const row = ui.locator('.list.logins li');
  await expect(row).toContainText('ann');
  await expect(row).not.toContainText('hidden-pw');
  await row.getByTitle('Show password').click();
  await expect(row.locator('.login-password')).toHaveText('hidden-pw');
  await row.getByTitle('Copy password').click();
  await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe('hidden-pw');
  await app.close();
});
