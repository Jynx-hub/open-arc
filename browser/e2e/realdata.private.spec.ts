import { expect, test } from '@playwright/test';
import { command, launch, state } from './helpers';

// Runs only when OPEN_ARC_REAL_DATA points at a private copy of Arc's data. Never commit its output.
test.skip(!process.env.OPEN_ARC_REAL_DATA, 'needs OPEN_ARC_REAL_DATA');

test('imports a real Arc data copy', async () => {
  const { app, ui } = await launch();
  await ui.keyboard.press('Escape');
  const summary: any = await command(ui, { type: 'importArc', dir: process.env.OPEN_ARC_REAL_DATA });
  const s: any = await state(ui);
  const countTabs = (root: string): number => (s.items[root]?.children ?? []).reduce((n: number, c: string) => n + (s.items[c]?.kind === 'tab' ? 1 : countTabs(c)), 0);
  const tabs = s.spaces.reduce((n: number, sp: any) => n + countTabs(sp.pinnedRootId) + countTabs(sp.todayRootId), 0);
  console.log(JSON.stringify({ summary: { ...summary, skipped: [...new Set(summary.skipped)] }, spaces: s.spaces.length, tabs, archive: s.archive.length, rules: s.linkRules.length }));
  expect(tabs).toBe(summary.tabs);
  await ui.waitForTimeout(4000);
  await ui.screenshot({ path: `${process.env.OPEN_ARC_SHOT_DIR}/real-import.png` });
  await app.close();
});
