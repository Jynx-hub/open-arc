import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export async function launch(env: Record<string, string> = {}): Promise<{ app: ElectronApplication; ui: Page; userData: string }> {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'open-arc-e2e-'));
  const app = await electron.launch({ args: [path.resolve(__dirname, '..')], env: { ...process.env, OPEN_ARC_USER_DATA: userData, ...env } as Record<string, string> });
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
