import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** `prepare` runs on the fresh profile folder before the app starts (to seed files in it). */
export async function launch(env: Record<string, string> = {}, prepare?: (userData: string) => void): Promise<{ app: ElectronApplication; ui: Page; userData: string }> {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'open-arc-e2e-'));
  prepare?.(userData);
  const app = await electron.launch({
    args: [path.resolve(__dirname, '..')],
    env: { ...process.env, OPEN_ARC_USER_DATA: userData, OPEN_ARC_FIRESTORE_DIR: path.join(userData, 'no-firestore'), OPEN_ARC_QUIET: '1', OPEN_ARC_NO_EXTENSION_UPDATES: '1', ...env } as Record<string, string>,
  });
  // The system clipboard is the user's: copies in a test go to an in-memory one.
  await app.evaluate(({ clipboard }) => {
    let text = '';
    let items: unknown[] = [];
    Object.assign(clipboard, {
      writeText: (t: string) => void (text = t),
      readText: () => text,
      write: async (i: unknown[]) => void (items = i),
      clear: () => void ((text = ''), (items = [])),
    });
    (globalThis as any).clipboardItems = () => items;
  });
  const ui = await app.firstWindow();
  await ui.waitForSelector('.sidebar');
  return { app, ui, userData };
}

/** Runs a command in the UI's own bridge, exactly as a click would. */
export function command(ui: Page, c: unknown) {
  return ui.evaluate((cmd) => (window as any).openArc.command(cmd), c);
}

export function state(ui: Page) {
  return ui.evaluate(() => (window as any).openArc.getState());
}

export async function waitForState(ui: Page, pred: (s: any) => boolean, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const s = await state(ui);
    if (pred(s)) return s;
    await ui.waitForTimeout(100);
  }
  throw new Error('state never matched');
}
