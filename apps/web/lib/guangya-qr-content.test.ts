import { describe, expect, it } from "vitest";
import { buildGuangYaQrContent } from "./guangya-qr-content";

/** The exact value the real site handed to its QR canvas on 2026-10-26. */
const LIVE_VERIFICATION_URL =
  "https://account.guangyapan.com/__/auth/device/?client_id=aMe-8VSlkrbQXpUR&scope=user%20profile%20sso%20offline";

describe("buildGuangYaQrContent", () => {
  // Live regression pin: the first shipped version encoded the bare
  // verification_url and the user's very first scan landed on 404. `user_code`
  // is what identifies which pending authorization is being approved.
  it("appends user_code — the parameter whose absence made scans 404", () => {
    const out = buildGuangYaQrContent({ verificationUrl: LIVE_VERIFICATION_URL, userCode: "AWrfZhuaq-jGBr7e-g" });
    expect(out).toBe(`${LIVE_VERIFICATION_URL}&user_code=AWrfZhuaq-jGBr7e-g`);
    expect(out).toContain("user_code=");
  });

  it("matches the exact shape the real site encodes", () => {
    // Copied from the canvas's qrCodeUrl prop on the live login screen.
    const expected =
      "https://account.guangyapan.com/__/auth/device/?client_id=aMe-8VSlkrbQXpUR&scope=user%20profile%20sso%20offline&user_code=AWrfZhuaq-jGBr7e-g";
    expect(
      buildGuangYaQrContent({ verificationUrl: LIVE_VERIFICATION_URL, userCode: "AWrfZhuaq-jGBr7e-g" }),
    ).toBe(expected);
  });

  it("uses ? when the url has no query string yet", () => {
    const out = buildGuangYaQrContent({ verificationUrl: "https://account.guangyapan.com/x", userCode: "abc" });
    expect(out).toBe("https://account.guangyapan.com/x?user_code=abc");
  });

  it("percent-encodes a user_code containing reserved characters", () => {
    const out = buildGuangYaQrContent({ verificationUrl: LIVE_VERIFICATION_URL, userCode: "a-b_c.d~e" });
    expect(out.split("user_code=")[1]).toBe("a-b_c.d~e");
    const weird = buildGuangYaQrContent({ verificationUrl: LIVE_VERIFICATION_URL, userCode: "a&b=c" });
    expect(weird.split("user_code=")[1]).toBe("a%26b%3Dc");
  });

  it("returns the url unchanged when there is no user code", () => {
    expect(buildGuangYaQrContent({ verificationUrl: LIVE_VERIFICATION_URL, userCode: "" })).toBe(
      LIVE_VERIFICATION_URL,
    );
  });
});
