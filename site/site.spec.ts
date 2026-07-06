import { test, expect } from '@playwright/test';

const BASE_URL = 'http://localhost:8788';

test.describe('Task 8: Demo, Deploy, FAQ, CTA sections', () => {
  test('FAQ accordion exclusivity and interaction', async ({ page }) => {
    await page.goto(BASE_URL);

    // Navigate to FAQ section
    await page.locator('#faq').scrollIntoViewIfNeeded();

    // Get all FAQ details elements
    const faqs = page.locator('details.faq');
    await expect(faqs).toHaveCount(5);

    // Initially all should be closed
    for (let i = 0; i < 5; i++) {
      await expect(faqs.nth(i)).not.toHaveAttribute('open', '');
    }

    // Click Q2 (index 1)
    await faqs.nth(1).locator('summary').click();
    await page.waitForTimeout(250); // Wait for animation

    // Q2 should be open
    await expect(faqs.nth(1)).toHaveAttribute('open', '');

    // Click Q3 (index 2)
    await faqs.nth(2).locator('summary').click();
    await page.waitForTimeout(250);

    // Q3 should be open AND Q2 should be closed (exclusivity)
    await expect(faqs.nth(2)).toHaveAttribute('open', '');
    await expect(faqs.nth(1)).not.toHaveAttribute('open', '');

    // Rapid-click all 5
    for (let i = 0; i < 5; i++) {
      await faqs.nth(i).locator('summary').click();
      await page.waitForTimeout(50);
    }

    // Exactly one should be open at the end (the last one clicked)
    let openCount = 0;
    let lastOpenIndex = -1;
    for (let i = 0; i < 5; i++) {
      const isOpen = await faqs.nth(i).getAttribute('open');
      if (isOpen !== null) {
        openCount++;
        lastOpenIndex = i;
      }
    }
    expect(openCount).toBe(1);
    expect(lastOpenIndex).toBe(4);

    // Test keyboard navigation
    await faqs.nth(0).locator('summary').focus();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(250);
    await expect(faqs.nth(0)).toHaveAttribute('open', '');

    // Check chevron rotation
    const chevron = faqs.nth(0).locator('.chev');
    const transform = await chevron.evaluate((el) => window.getComputedStyle(el).transform);
    // transform should contain rotation (matrix with rotation values)
    expect(transform).not.toBe('none');
  });

  test('CTA download wiring', async ({ page }) => {
    await page.goto(BASE_URL);

    // Wait for download wiring to complete
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);

    // Check the final CTA button
    const ctaButton = page.locator('[data-dl-cta]');
    await expect(ctaButton).toBeVisible();

    // Should have a valid href (either async-loaded .dmg/.exe or fallback to releases/latest)
    const href = await ctaButton.getAttribute('href');
    expect(href).toBeTruthy();
    // Either direct download link or releases page
    expect(href).toMatch(/\.(dmg|exe)$|releases\/latest/);

    // Label should be present
    const label = await ctaButton.locator('[data-dl-label]').textContent();
    expect(label).toBeTruthy();
    expect(label).toContain('下载 Mediary Scout');

    // Verify the original download buttons are still working (regression check)
    const firstDL = page.locator('[data-dl]').first();
    const firstHref = await firstDL.getAttribute('href');
    expect(firstHref).toBeTruthy();
  });

  test('Demo section GIF and structure', async ({ page }) => {
    await page.goto(BASE_URL);

    await page.locator('#demo').scrollIntoViewIfNeeded();

    // Check heading
    await expect(page.locator('#demo h2')).toHaveText('不装也能玩');

    // Check demo window with GIF
    const demoImg = page.locator('.demo-window img');
    await expect(demoImg).toBeVisible();
    await expect(demoImg).toHaveAttribute('alt', /demo.*回放/i);

    // Verify image loaded (naturalWidth > 0)
    const naturalWidth = await demoImg.evaluate((img: HTMLImageElement) => img.naturalWidth);
    expect(naturalWidth).toBeGreaterThan(0);

    // Check CTA link
    const demoCTA = page.locator('.demo-cta a');
    await expect(demoCTA).toHaveAttribute('href', 'https://demo.dirtyfancy.sbs');
  });

  test('Deploy section layout and content', async ({ page }) => {
    await page.goto(BASE_URL);

    await page.locator('#deploy').scrollIntoViewIfNeeded();

    // Check heading
    await expect(page.locator('#deploy h2')).toHaveText('装在电脑，或装在服务器');

    // Check desktop column
    const desktopEyebrow = page.locator('.deploy-eyebrow-green');
    await expect(desktopEyebrow).toHaveText('DESKTOP');

    // Check docker column
    const dockerCode = page.locator('.deploy-code');
    await expect(dockerCode).toHaveText('docker compose up -d');

    // Check docker link (URL-encoded Chinese anchor)
    const dockerLink = page.locator('.deploy-link');
    await expect(dockerLink).toBeVisible();
    const dockerHref = await dockerLink.getAttribute('href');
    expect(dockerHref).toContain('github.com/fancydirty/mediary-scout#docker');
  });

  test('Mobile responsive - 375px width', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(BASE_URL);

    // Check no horizontal overflow
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollWidth).toBe(375);

    // Deploy columns should stack
    await page.locator('#deploy').scrollIntoViewIfNeeded();
    const deploySplit = page.locator('.deploy-split');
    const gridTemplate = await deploySplit.evaluate((el) =>
      window.getComputedStyle(el).gridTemplateColumns
    );
    // Should be single column on mobile
    expect(gridTemplate).not.toContain('1fr 1px 1fr');
  });

  test('Page error count', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => {
      errors.push(error.message);
    });

    await page.goto(BASE_URL);

    // Wait for all async operations
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);

    // No JavaScript errors
    expect(errors).toHaveLength(0);
  });

  test('Reduced motion - FAQ still functions', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(BASE_URL);

    await page.locator('#faq').scrollIntoViewIfNeeded();

    const faq = page.locator('details.faq').first();
    await faq.locator('summary').click();

    // Should still open (instantly without animation)
    await expect(faq).toHaveAttribute('open', '');

    // Content should be visible
    const body = faq.locator('.faq-body p');
    await expect(body).toBeVisible();
  });
});

test.describe('Footer TMDB attribution', () => {
  test('TMDB logo and text present', async ({ page }) => {
    await page.goto(BASE_URL);

    await page.locator('footer').scrollIntoViewIfNeeded();

    // Check TMDB logo SVG
    const tmdbLogo = page.locator('.tmdb-logo');
    await expect(tmdbLogo).toBeVisible();

    // Check attribution text
    const attrText = page.locator('.tmdb-attr p');
    await expect(attrText).toContainText('TMDB API');
    await expect(attrText).toContainText('not endorsed');
  });
});
