// apps/web/components/library-quick-find.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Interaction harness: tests run DOM-less (`environment: "node"`), so the
 * stateful LibraryQuickFind is driven the way lib/use-router.test.ts drives
 * hooks — React's hooks are faked with a module-level slot — and its handler
 * props are picked off the directly-returned element tree (the
 * remote-access-section.test.ts precedent). Markup assertions render the
 * fresh tree to static HTML, service-block.test.ts style.
 *
 * 假 useState 是单槽的——组件将来加第二个 useState 会让全部交互测试静默串槽，届时改按调用次序分配。
 * 假 useRef 固定返回假 input ref（current.focus 是 spy）——清空后焦点回搜索框就断言它。
 */
const h = vi.hoisted(() => {
  const focus = vi.fn();
  return {
    query: "" as string,
    push: vi.fn(),
    focus,
    inputRef: { current: { focus } },
  };
});

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: () => [
      h.query,
      (next: string | ((prev: string) => string)) => {
        h.query = typeof next === "function" ? next(h.query) : next;
      },
    ],
    useRef: () => h.inputRef,
  };
});

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: h.push }) }));

import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { InProgressTitle, LibraryWallEntry } from "../lib/title-hub";
import { filterLibraryEntries, LibraryQuickFind } from "./library-quick-find";

type Props = Parameters<typeof LibraryQuickFind>[0];

const entry = (over: Partial<LibraryWallEntry> & { tmdbId: number; title: string }): LibraryWallEntry => ({
  year: 2025,
  type: "movie",
  posterPath: null,
  seasonCount: 1,
  obtainedEpisodes: 1,
  totalAiredEpisodes: 1,
  totalEpisodes: 1,
  releaseDate: null,
  state: "complete",
  airing: false,
  ...over,
});

const ip = (over: Partial<InProgressTitle> & { tmdbId: number; title: string }): InProgressTitle => ({
  year: 2025,
  type: "tv",
  posterPath: null,
  ...over,
});

function find(node: ReactNode, match: (element: ReactElement) => boolean): ReactElement | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = find(child, match);
      if (found) return found;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  const element = node as ReactElement<{ children?: ReactNode }>;
  if (match(element)) return element;
  return find(element.props.children, match);
}

/** Re-render at the current fake state → static markup. */
const html = (props: Props) => renderToStaticMarkup(createElement(LibraryQuickFind, props));

/** Simulate typing in the search box (fires the real onChange handler). */
function typeQuery(props: Props, value: string) {
  const input = find(LibraryQuickFind(props), (element) => element.type === "input");
  expect(input).not.toBeNull();
  (input!.props as { onChange: (event: { target: { value: string } }) => void }).onChange({
    target: { value },
  });
}

function pressKey(props: Props, key: string, isComposing = false, keyCode = 0) {
  const input = find(LibraryQuickFind(props), (element) => element.type === "input");
  expect(input).not.toBeNull();
  (input!.props as {
    onKeyDown: (event: { key: string; nativeEvent: { isComposing: boolean; keyCode: number } }) => void;
  }).onKeyDown({
    key,
    nativeEvent: { isComposing, keyCode },
  });
}

function clickButton(props: Props, ariaLabel: string) {
  const button = find(
    LibraryQuickFind(props),
    (element) =>
      element.type === "button" && (element.props as { "aria-label"?: string })["aria-label"] === ariaLabel,
  );
  expect(button, `button[${ariaLabel}]`).not.toBeNull();
  (button!.props as { onClick: () => void }).onClick();
}

/** Click the 清空 button inside the 0-match quiet-state (it has no aria-label). */
function clickClearInEmptyState(props: Props) {
  const button = find(
    LibraryQuickFind(props),
    (element) =>
      element.type === "button" && (element.props as { children?: ReactNode }).children === "清空",
  );
  expect(button, "清空 button").not.toBeNull();
  (button!.props as { onClick: () => void }).onClick();
}

describe("filterLibraryEntries", () => {
  const entries = [entry({ tmdbId: 1, title: "The Batman" }), entry({ tmdbId: 2, title: "Inception" })];

  it("空串返回全量", () => {
    expect(filterLibraryEntries(entries, "")).toEqual(entries);
  });

  it("包含匹配且大小写不敏感", () => {
    expect(filterLibraryEntries(entries, "bat")).toEqual([entries[0]]);
    expect(filterLibraryEntries(entries, "THE")).toEqual([entries[0]]);
    expect(filterLibraryEntries(entries, "ept")).toEqual([entries[1]]);
  });

  it("trim 空白后再匹配；纯空白视同空串", () => {
    expect(filterLibraryEntries(entries, "  inception  ")).toEqual([entries[1]]);
    expect(filterLibraryEntries(entries, "   ")).toEqual(entries);
  });

  it("0 匹配返回空数组", () => {
    expect(filterLibraryEntries(entries, "阿凡达")).toEqual([]);
  });

  it("保留条目原对象与顺序，不改动入参", () => {
    const result = filterLibraryEntries(entries, "the");
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(entries[0]);
  });
});

describe("LibraryQuickFind — home 模式", () => {
  // 获取中标题同时出现在「获取中」行和它自己的分类行（page.tsx 原行为）。
  const props = (): Props => ({
    wallEntries: [
      entry({ tmdbId: 101, title: "猛攻", type: "movie" }),
      entry({ tmdbId: 102, title: "黄泉的使者", type: "tv", state: "tracking" }),
    ],
    inProgressTitles: [ip({ tmdbId: 201, title: "追风" }), ip({ tmdbId: 202, title: "追风少年", type: "movie" })],
    storageId: undefined,
    mode: "home",
  });

  beforeEach(() => {
    h.query = "";
    h.push.mockClear();
    h.focus.mockClear();
  });

  it("query 空 → 原布局：获取中行 + 分类行（空行隐藏），无计数/清空按钮", () => {
    const markup = html(props());
    expect(markup).toContain("我的媒体库");
    expect(markup).toContain("获取中 2");
    expect(markup).toContain("电影 2");
    expect(markup).toContain("电视剧 2");
    expect(markup).not.toContain("动漫");
    expect(markup).toContain('placeholder="在库中查找…"');
    expect(markup).not.toContain("匹配 ");
    expect(markup).not.toContain("没找到");
    expect(markup).not.toContain('aria-label="清空查找"');
  });

  it("输入即过滤：只留匹配项，整行空则隐藏该分类行，计数提示", () => {
    const p = props();
    typeQuery(p, "猛攻");
    const markup = html(p);
    expect(markup).toContain("匹配 1 部");
    expect(markup).toContain("猛攻");
    expect(markup).not.toContain("黄泉的使者");
    expect(markup).not.toContain("追风");
    expect(markup).not.toContain("获取中 ");
    expect(markup).not.toContain("电视剧 ");
    expect(markup).toContain("电影 1");
  });

  it("Enter 唯一匹配直达详情页（showHref 参数与海报卡一致）；多匹配/空 query 不导航", () => {
    const p = props();
    typeQuery(p, "猛攻");
    pressKey(p, "Enter");
    expect(h.push).toHaveBeenCalledTimes(1);
    expect(h.push).toHaveBeenCalledWith("/show/101?from=library&t=movie");

    h.push.mockClear();
    typeQuery(p, "追");
    pressKey(p, "Enter");
    expect(h.push).not.toHaveBeenCalled();

    h.query = "";
    pressKey(p, "Enter");
    expect(h.push).not.toHaveBeenCalled();
  });

  it("唯一匹配是「获取中」占位时 Enter 不导航（占位卡不可进入）", () => {
    const p = props();
    typeQuery(p, "追风少年"); // 只命中获取中的占位标题
    expect(html(p)).toContain("匹配 1 部");
    pressKey(p, "Enter");
    expect(h.push).not.toHaveBeenCalled();
  });

  it("可达 1 + 获取中 1（总 2）不导航；唯一可达匹配才直达", () => {
    const p: Props = {
      wallEntries: [entry({ tmdbId: 110, title: "追风行动", type: "movie" })],
      inProgressTitles: [ip({ tmdbId: 210, title: "追风" })],
      storageId: undefined,
      mode: "home",
    };
    typeQuery(p, "追风");
    pressKey(p, "Enter");
    expect(h.push).not.toHaveBeenCalled();

    typeQuery(p, "追风行动");
    pressKey(p, "Enter");
    expect(h.push).toHaveBeenCalledTimes(1);
    expect(h.push).toHaveBeenCalledWith("/show/110?from=library&t=movie");
  });

  it("匹配计数带 aria-live=polite，过滤结果数变化可被辅助技术播报", () => {
    const p = props();
    typeQuery(p, "猛攻");
    const count = find(
      LibraryQuickFind(p),
      (element) =>
        element.type === "p" &&
        String((element.props as { className?: string }).className ?? "").includes("panel-note"),
    );
    expect(count).not.toBeNull();
    expect((count!.props as Record<string, unknown>)["aria-live"]).toBe("polite");
  });

  it("中文输入法确认词的 Enter 不触发直达（isComposing）", () => {
    const p = props();
    typeQuery(p, "猛攻");
    pressKey(p, "Enter", true);
    expect(h.push).not.toHaveBeenCalled();

    pressKey(p, "Enter");
    expect(h.push).toHaveBeenCalledTimes(1);
  });

  it("WebKit 变体：isComposing 已复位但 keyCode 229 的 Enter 同样不触发直达", () => {
    const p = props();
    typeQuery(p, "猛攻");
    pressKey(p, "Enter", false, 229);
    expect(h.push).not.toHaveBeenCalled();

    pressKey(p, "Enter", false, 13);
    expect(h.push).toHaveBeenCalledTimes(1);
  });

  it("纯空白 query 按未输入处理：全量墙、无计数、无 ✕、非 0 匹配空态", () => {
    const p = props();
    typeQuery(p, "   ");
    const markup = html(p);
    expect(markup).toContain("获取中 2");
    expect(markup).toContain("猛攻");
    expect(markup).toContain("黄泉的使者");
    expect(markup).not.toContain("匹配 ");
    expect(markup).not.toContain("没找到");
    expect(markup).not.toContain('aria-label="清空查找"');
  });

  it("0 匹配显示「没找到『××』」+清空按钮；清空后恢复完整视图", () => {
    const p = props();
    typeQuery(p, "无此片");
    const markup = html(p);
    expect(markup).toContain("没找到『无此片』");
    expect(markup).not.toContain("黄泉的使者");

    clickClearInEmptyState(p);
    expect(h.query).toBe("");
    const restored = html(p);
    expect(restored).toContain("获取中 2");
    expect(restored).toContain("黄泉的使者");
    expect(restored).not.toContain("没找到");
  });

  it("✕ 按钮仅 query 非空时显示；Esc 清空恢复", () => {
    const p = props();
    typeQuery(p, "猛攻");
    expect(html(p)).toContain('aria-label="清空查找"');

    pressKey(p, "Escape");
    expect(h.query).toBe("");
    const restored = html(p);
    expect(restored).not.toContain("匹配 ");
    expect(restored).toContain("黄泉的使者");

    typeQuery(p, "猛攻");
    clickButton(p, "清空查找");
    expect(h.query).toBe("");
    expect(html(p)).toContain("黄泉的使者");
  });

  it("清空统一走 clearQuery：✕、0 匹配清空、Esc 清空后焦点回搜索框", () => {
    const p = props();

    typeQuery(p, "猛攻");
    clickButton(p, "清空查找");
    expect(h.query).toBe("");
    expect(h.focus).toHaveBeenCalledTimes(1);

    typeQuery(p, "无此片");
    clickClearInEmptyState(p);
    expect(h.query).toBe("");
    expect(h.focus).toHaveBeenCalledTimes(2);

    typeQuery(p, "猛攻");
    pressKey(p, "Escape");
    expect(h.query).toBe("");
    expect(h.focus).toHaveBeenCalledTimes(3);
  });
});

describe("LibraryQuickFind — category 模式与 filter 叠加", () => {
  const props = (): Props => ({
    wallEntries: [
      entry({ tmdbId: 301, title: "深海", type: "tv", state: "complete" }),
      entry({ tmdbId: 302, title: "黄泉的使者", type: "tv", state: "tracking" }),
      entry({ tmdbId: 303, title: "猛攻", type: "movie", state: "complete" }),
    ],
    inProgressTitles: [ip({ tmdbId: 201, title: "追风", type: "tv" })],
    storageId: "d1",
    mode: "category",
    mediaType: "tv",
    filter: "complete",
  });

  beforeEach(() => {
    h.query = "";
    h.push.mockClear();
  });

  it("先按 filter chips 过滤再叠加 query；标题行带返回链接与追踪计数", () => {
    const markup = html(props());
    expect(markup).toContain("‹");
    expect(markup).toContain("电视剧");
    expect(markup).toContain("1 部正在追踪");
    expect(markup).toContain('class="filter-pill is-active"');
    expect(markup).toContain("/w/d1?tab=library&amp;type=tv&amp;filter=complete");
    // complete 过滤掉追更中的黄泉；type=tv 过滤掉电影猛攻；获取中行不受 state filter 影响
    expect(markup).toContain("深海");
    expect(markup).not.toContain("黄泉的使者");
    expect(markup).not.toContain("猛攻");
    expect(markup).toContain("追风");
  });

  it("query 与 filter 叠加：只留 filter 通过且标题匹配的项", () => {
    const p = props();
    typeQuery(p, "深海");
    const markup = html(p);
    expect(markup).toContain("匹配 1 部");
    expect(markup).toContain("深海");
    expect(markup).not.toContain("追风");

    pressKey(p, "Enter");
    expect(h.push).toHaveBeenCalledWith("/show/301?from=library&w=d1&t=tv");
  });

  it("filter 全挡掉时 0 匹配提示同样生效（filter chips 保留可切换）", () => {
    const p = props();
    typeQuery(p, "黄泉");
    const markup = html(p);
    expect(markup).toContain("没找到『黄泉』");
    expect(markup).toContain("/w/d1?tab=library&amp;type=tv&amp;filter=tracking");
  });
});
