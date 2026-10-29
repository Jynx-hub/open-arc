import { app, BrowserWindow, dialog, ipcMain, protocol, net } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Action } from '../shared/reducer';
import type { Command, Rect } from '../shared/ipc';
import { dueForArchive } from '../shared/archiver';
import { Store, StateTooNewError } from './store';
import { Browser } from './browser';
import { startLiveFolderTimer } from './liveFolders';

const ARCHIVE_TICK_MS = 60_000;

// Tests point this at a throwaway folder.
if (process.env.OPEN_ARC_USER_DATA) app.setPath('userData', process.env.OPEN_ARC_USER_DATA);

protocol.registerSchemesAsPrivileged([{ scheme: 'openarc', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

if (!app.requestSingleInstanceLock()) app.quit();

let browser: Browser | null = null;
const pendingUrls: string[] = [];

// macOS delivers links from other apps (when we're the default browser) through `open-url`.
app.on('open-url', (event, url) => {
  event.preventDefault();
  if (browser) browser.openExternal(url);
  else pendingUrls.push(url);
});

app.on('second-instance', (_e, argv) => {
  const url = argv.find((a) => /^https?:\/\//.test(a));
  if (url) browser?.openExternal(url);
  else browser?.focused()?.win.focus();
});

app.whenReady().then(() => {
  const rendererDir = path.join(__dirname, 'renderer');
  protocol.handle('openarc', (req) => {
    const { pathname } = new URL(req.url);
    const file = path.join(rendererDir, decodeURIComponent(pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(rendererDir)) return new Response('not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });

  let store: Store;
  try {
    store = new Store(path.join(app.getPath('userData'), 'state.json'));
  } catch (err) {
    if (!(err instanceof StateTooNewError)) throw err;
    dialog.showErrorBox('Open Arc can’t open your data', err.message);
    app.exit(1);
    return;
  }
  browser = new Browser(store, process.env.OPEN_ARC_RENDERER_URL ?? 'openarc://app/index.html');
  const b = browser;
  b.buildMenu();

  ipcMain.handle('getState', () => b.uiState());
  ipcMain.handle('getWindow', (e) => {
    const w = b.winFor(e.sender);
    return w ? b.windowInfo(w) : null;
  });
  ipcMain.handle('getLive', () => Object.fromEntries(b.tabs.live));
  ipcMain.on('dispatch', (_e, action: Action) => store.dispatch(action));
  ipcMain.handle('command', (e, command: Command) => {
    const w = b.winFor(e.sender);
    return w ? b.command(w, command) : null;
  });
  ipcMain.on('setContentBounds', (e, rect: Rect) => {
    const w = b.winFor(e.sender);
    if (w) b.setContentBounds(w, rect);
  });
  ipcMain.handle('find', (e, text: string, opts: { forward?: boolean; findNext?: boolean }) => {
    const w = b.winFor(e.sender);
    if (w) b.find(w, text, opts);
  });
  ipcMain.handle('captures', async () => (await import('./library')).listCaptures());

  b.createWindow();
  if (store.firstRun) {
    const w = b.focused();
    if (w) b.sendUi(w, 'action', { id: 'welcome' });
  }
  for (const url of pendingUrls.splice(0)) b.openExternal(url);

  // Auto-archive: idle Today tabs past their Profile's threshold, never a selected tab.
  setInterval(() => {
    const selected = new Set(b.allWindows().flatMap((w) => (w.selectedId ? [w.selectedId] : [])));
    const ids = dueForArchive(store.state, Date.now(), selected);
    if (!ids.length) return;
    store.dispatch({ type: 'item.archive', ids, reason: 'auto', now: Date.now() });
    const first = !store.state.settings.seenArchiveEducation;
    if (first) store.dispatch({ type: 'settings.update', patch: { seenArchiveEducation: true } });
    for (const w of b.allWindows()) {
      if (first) b.sendUi(w, 'action', { id: 'archiveEducation' });
      b.toast(w, `${ids.length} idle ${ids.length === 1 ? 'tab was' : 'tabs were'} archived`, 'Open Archive', { type: 'runAction', id: 'archive' });
    }
  }, Number(process.env.OPEN_ARC_ARCHIVE_TICK_MS) || ARCHIVE_TICK_MS);

  startLiveFolderTimer(store);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) b.createWindow();
  });
  app.on('before-quit', () => store.flush());
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
