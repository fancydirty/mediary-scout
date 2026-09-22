// apps/web/components/service-block.test.ts
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ServiceBlock } from "./service-block";

const render = (props: Parameters<typeof ServiceBlock>[0]) =>
  renderToStaticMarkup(createElement(ServiceBlock, props));

describe("ServiceBlock", () => {
  it("renders name as h3, pills with tone classes + full label as title (CSS may ellipsize), summary, and children", () => {
    const html = render({
      name: "Jev 候选预筛",
      pills: [
        { label: "生效中", tone: "on" },
        { label: "jev-1.13.0", tone: "neutral" },
      ],
      summary: "一句话。",
      children: createElement("input", { "aria-label": "X" }),
    });
    expect(html).toContain('<h3 class="service-block-name">Jev 候选预筛</h3>');
    expect(html).toContain('<span class="service-pill is-on" title="生效中">生效中</span>');
    expect(html).toContain('<span class="service-pill is-neutral" title="jev-1.13.0">jev-1.13.0</span>');
    expect(html).toContain('<p class="service-block-summary">一句话。</p>');
    expect(html).toContain('aria-label="X"');
  });

  it("renders a closed <details> labelled 说明 only when details are given; summary's accessible name carries the service name", () => {
    const withDetails = render({
      name: "A",
      summary: "s",
      details: createElement("p", null, "长说明"),
      children: null,
    });
    // Six blocks each have a 说明 disclosure — aria-label keeps them distinguishable
    // for screen readers while the visible text stays 说明.
    expect(withDetails).toContain('<details class="service-block-details"><summary aria-label="A 说明">说明</summary>');
    expect(withDetails).not.toContain(" open");
    expect(withDetails).toContain("长说明");

    const withoutDetails = render({ name: "A", summary: "s", children: null });
    expect(withoutDetails).not.toContain("<details");
  });

  it("omits the pill row entries when pills is empty (head still renders the name)", () => {
    const html = render({ name: "A", summary: "s", children: null });
    expect(html).toContain('<div class="service-block-head"><h3 class="service-block-name">A</h3></div>');
    expect(html).not.toContain("service-pill");
  });
});
