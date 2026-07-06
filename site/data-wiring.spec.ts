import { test, expect } from "@playwright/test";

test.describe("Data Wiring - Live and Fallback", () => {
  test.beforeEach(async ({ page }) => {
    // Collect console messages and errors
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        console.error(`Console error: ${msg.text()}`);
      }
    });
    page.on("pageerror", (err) => {
      console.error(`Page error: ${err.message}`);
    });
  });

  test("Live path - GitHub API success", async ({ page }) => {
    await page.goto("http://localhost:8788/");

    // Wait for network idle to ensure all fetches complete
    await page.waitForLoadState("networkidle");

    // Verify stars - should be formatted and NOT the loading placeholder
    const starsText = await page.locator("[data-stars]").first().textContent();
    expect(starsText).toMatch(/^★ [\d.k]+$/);
    expect(starsText).not.toBe("★ …");
    console.log(`Stars text: ${starsText}`);

    // Verify first download link (macOS on mac runner)
    const firstDl = page.locator("[data-dl]").first();
    const href = await firstDl.getAttribute("href");
    expect(href).toMatch(/\.dmg$/);
    console.log(`First download href: ${href}`);

    // Verify version shows on first anchor
    const version = await firstDl.locator("[data-dl-ver]").textContent();
    expect(version).toBe("v1.1.0");
    console.log(`Version: ${version}`);

    // Verify no console errors
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    const pageErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));

    expect(consoleErrors).toHaveLength(0);
    expect(pageErrors).toHaveLength(0);
    console.log(`Console errors: ${consoleErrors.length}, Page errors: ${pageErrors.length}`);
  });

  test("Fallback drill - GitHub API blocked", async ({ page }) => {
    // Block all GitHub API requests
    await page.route("https://api.github.com/**", (route) => route.abort());

    await page.goto("http://localhost:8788/");
    await page.waitForLoadState("networkidle");

    // Stars should show fallback value (968)
    const starsText = await page.locator("[data-stars]").first().textContent();
    expect(starsText).toBe("★ 968");
    console.log(`Stars text (fallback): ${starsText}`);

    // First download should STILL work from snapshot
    const firstDl = page.locator("[data-dl]").first();
    const href = await firstDl.getAttribute("href");
    expect(href).toMatch(/\.dmg$/);
    console.log(`First download href (fallback): ${href}`);

    // Version should still be v1.1.0
    const version = await firstDl.locator("[data-dl-ver]").textContent();
    expect(version).toBe("v1.1.0");
    console.log(`Version (fallback): ${version}`);

    // No console errors - fallback paths must swallow cleanly
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    const pageErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));

    expect(consoleErrors).toHaveLength(0);
    expect(pageErrors).toHaveLength(0);
    console.log(`Console errors (fallback): ${consoleErrors.length}, Page errors: ${pageErrors.length}`);
  });

  test("Windows UA emulation - platform detection", async ({ browser }) => {
    // Create new context with Windows user agent
    const context = await browser.newContext({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    });
    const page = await context.newPage();

    await page.goto("http://localhost:8788/");
    await page.waitForLoadState("networkidle");

    // On Windows UA, orderDownloads reverses items so items[0]=Windows lands on FIRST anchor
    const firstDl = page.locator("[data-dl]").first();

    // First anchor should now be Windows
    const label = await firstDl.locator("[data-dl-label]").textContent();
    expect(label).toBe("Windows");
    console.log(`First download label (Windows UA): ${label}`);

    const href = await firstDl.getAttribute("href");
    expect(href).toMatch(/\.exe$/);
    console.log(`First download href (Windows UA): ${href}`);

    // Version should show on first anchor (the Windows one now)
    const version = await firstDl.locator("[data-dl-ver]").textContent();
    expect(version).toBe("v1.1.0");
    console.log(`Version (Windows UA): ${version}`);

    // No console errors
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    const pageErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));

    expect(consoleErrors).toHaveLength(0);
    expect(pageErrors).toHaveLength(0);
    console.log(`Console errors (Windows UA): ${consoleErrors.length}, Page errors: ${pageErrors.length}`);

    await context.close();
  });
});
