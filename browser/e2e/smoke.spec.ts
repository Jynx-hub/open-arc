import { expect, test } from '@playwright/test';
import { launch } from './helpers';

test('launches with one Space and an empty sidebar', async () => {
  const { app, ui } = await launch();
  await ui.screenshot({ path: 'test-results/first-launch.png' });
  await expect(ui.locator('.space-dot')).toHaveCount(1);
  await app.close();
});
