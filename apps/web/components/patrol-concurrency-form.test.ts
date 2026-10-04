import { describe, expect, it, vi } from "vitest";

vi.mock("../app/actions", () => ({ savePatrolConcurrencyAction: vi.fn() }));

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PatrolConcurrencyForm } from "./patrol-concurrency-form";

describe("PatrolConcurrencyForm", () => {
  it("says the number covers manual 获取 too, not only the patrol", () => {
    const html = renderToStaticMarkup(createElement(PatrolConcurrencyForm, { initial: 1, max: 5 }));
    expect(html).toContain("同时处理");
    expect(html).not.toContain("同时巡检");
    expect(html).toContain("巡检和手动点的「获取」都按这个数");
  });
});
