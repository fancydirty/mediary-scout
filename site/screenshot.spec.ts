import { test } from '@playwright/test';
import path from 'path';

const BASE_URL = 'http://localhost:8788';
const SCRATCHPAD = '/private/tmp/claude-501/-Users-dirtyfancy-projects-media-track/c01cb6cc-fa19-42e6-8e61-56ddee106e16/scratchpad';

test('Screenshot demo and FAQ sections - desktop', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1024 });
  await page.goto(BASE_URL);
  await page.waitForLoadState('networkidle');

  // Scroll to demo section
  await page.locator('#demo').scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);

  await page.screenshot({
    path: path.join(SCRATCHPAD, 'demo-faq-desktop.png'),
    fullPage: false
  });
});

test('Screenshot demo and FAQ sections - mobile', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(BASE_URL);
  await page.waitForLoadState('networkidle');

  // Scroll to demo section
  await page.locator('#demo').scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);

  await page.screenshot({
    path: path.join(SCRATCHPAD, 'demo-faq-mobile.png'),
    fullPage: false
  });
});
