import { describe, expect, it, vi } from "vitest";

// @ts-expect-error Vitest runtime supports virtual mocks, but v4 typings omit the option.
vi.mock("server-only", () => ({}), { virtual: true });

import { connectSlugReasonText } from "./connect-wizard";

describe("ConnectWizard copy", () => {
  it.each([
    ["reserved", "这个名字被保留了（可能与商标冲突）"],
    ["invalid", "这个名字不符合规则"],
    ["taken", "这个名字已被占用"],
  ])("uses the console wording for %s slugs", (reason, expected) => {
    expect(connectSlugReasonText(reason)).toBe(expected);
  });
});
