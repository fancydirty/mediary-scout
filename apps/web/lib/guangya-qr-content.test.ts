import { describe, expect, it } from "vitest";
import { buildGuangYaQrContent } from "./guangya-qr-content";

/** The exact value the real site handed to its QR canvas on 2026-10-26. */
const LIVE_VERIFICATION_URL =
  "https://account.guangyapan.com/__/auth/device/?client_id=aMe-8VSlkrbQXpUR&scope=user%20profile%20sso%20offline";

describe("buildGuangYaQrContent", () => {
  // Live regression pin: the first shipped version encoded the bare
  // verification_url and the user's very first scan landed on 404. `user_code`
  // is what identifies which pending authorization is being approved.
  // Compared by parsed params rather than raw string: `new URL()` normalises
  // `%20` to `+` in a query value, which is semantically identical (both decode
  // to a space) but would fail a byte-for-byte assertion.
  it("appends user_code — the parameter whose absence made scans 404", () => {
    const out = new URL(
      buildGuangYaQrContent({ verificationUrl: LIVE_VERIFICATION_URL, userCode: "AWrfZhuaq-jGBr7e-g" }),
    );
    expect(out.searchParams.get("user_code")).toBe("AWrfZhuaq-jGBr7e-g");
    // Everything else must survive untouched.
    expect(out.searchParams.get("client_id")).toBe("aMe-8VSlkrbQXpUR");
    expect(out.searchParams.get("scope")).toBe("user profile sso offline");
    expect(out.origin + out.pathname).toBe(
      "https://account.guangyapan.com/__/auth/device/",
    );
  });

  it("matches the parameter set the real site encodes", () => {
    // The live canvas value was:
    //   …/__/auth/device/?client_id=…&scope=user%20profile%20sso%20offline&user_code=AWrfZhuaq-jGBr7e-g
    const out = new URL(
      buildGuangYaQrContent({ verificationUrl: LIVE_VERIFICATION_URL, userCode: "AWrfZhuaq-jGBr7e-g" }),
    );
    expect([...out.searchParams.keys()].sort()).toEqual(["client_id", "scope", "user_code"]);
  });

  it("uses ? when the url has no query string yet", () => {
    const out = buildGuangYaQrContent({ verificationUrl: "https://account.guangyapan.com/x", userCode: "abc" });
    expect(out).toBe("https://account.guangyapan.com/x?user_code=abc");
  });

  it("round-trips a user_code containing reserved characters", () => {
    const plain = buildGuangYaQrContent({ verificationUrl: LIVE_VERIFICATION_URL, userCode: "a-b_c.d~e" });
    expect(new URL(plain).searchParams.get("user_code")).toBe("a-b_c.d~e");
    // `&` and `=` must be encoded, or they would split/terminate the parameter.
    const weird = buildGuangYaQrContent({ verificationUrl: LIVE_VERIFICATION_URL, userCode: "a&b=c" });
    expect(weird.match(/user_code=/g)).toHaveLength(1);
    expect(new URL(weird).searchParams.get("user_code")).toBe("a&b=c");
  });

  // URL/searchParams instead of string concatenation: an upstream that already
  // includes user_code must be overridden, not duplicated.
  it("does not duplicate an existing user_code", () => {
    const withCode = `${LIVE_VERIFICATION_URL}&user_code=OLD`;
    const out = buildGuangYaQrContent({ verificationUrl: withCode, userCode: "NEW" });
    expect(out.match(/user_code=/g)).toHaveLength(1);
    expect(out).toContain("user_code=NEW");
    expect(out).not.toContain("OLD");
  });

  it("returns the url unchanged when there is no user code", () => {
    expect(buildGuangYaQrContent({ verificationUrl: LIVE_VERIFICATION_URL, userCode: "" })).toBe(
      LIVE_VERIFICATION_URL,
    );
  });
});
