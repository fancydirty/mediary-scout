import { describe, expect, it } from "vitest";
import { confirmLoginPage } from "./confirm-login-page.js";

describe("confirmLoginPage", () => {
  it("escapes the email and is kept out of search results", () => {
    const html = confirmLoginPage('a<img src=x onerror=alert(1)>@example.com');
    expect(html).toContain("a&lt;img src=x onerror=alert(1)&gt;@example.com");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain('<meta name="robots" content="noindex">');
  });

  it("signs in only from the button: a same-origin fetch POST, then /console", () => {
    const html = confirmLoginPage("alice@example.com");
    expect(html).toContain('fetch("/auth/callback",{method:"POST"');
    expect(html).toContain('location.replace("/console")');
    expect(html).not.toContain("<form");
  });
});
