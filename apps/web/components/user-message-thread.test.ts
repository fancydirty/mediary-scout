// apps/web/components/user-message-thread.test.ts
import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { UserMessageReply } from "@media-track/workflow";
import type { MessageRunView, MessageThreadView } from "../lib/user-message-server";
import type { ThreadMessage } from "../lib/user-message-state";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }) }));
vi.mock("../app/actions", () => ({
  postUserMessageAction: vi.fn(),
  editUserMessageAction: vi.fn(),
  withdrawUserMessageAction: vi.fn(),
  processMessagesNowAction: vi.fn(),
  keepEpisodesAsIsAction: vi.fn(),
  restoreEpisodesToPendingAction: vi.fn(),
}));

const { UserMessageThread } = await import("./user-message-thread");

const NOW = "2026-09-27T08:00:00.000Z"; // 16:00 in China
const EPISODES = Array.from({ length: 24 }, (_, i) => `S01E${String(i + 1).padStart(2, "0")}`);
const idleRun: MessageRunView = { running: false, activity: null, waitsForRun: false };

const msg = (over: Partial<ThreadMessage> & { id: string }): ThreadMessage => ({
  body: "画面发蓝，换个别的版本",
  episodeTags: ["S01E13", "S01E24"],
  status: "pending",
  urgent: false,
  createdAt: "2026-09-27T06:02:00.000Z",
  processedAt: null,
  reply: null,
  ...over,
});

function render(input: {
  mediaType?: "movie" | "tv";
  messages?: ThreadMessage[];
  pending?: string[];
  run?: MessageRunView;
  episodes?: string[];
}) {
  const messages = input.messages ?? [];
  const pending = input.pending ?? [];
  const view: MessageThreadView = {
    messages,
    pendingReplacements: pending,
    pendingRows: pending.map((episode) => ({ episode, messageId: "msg_1", requestedAt: NOW })),
    busy: messages.some((m) => m.status === "processing"),
  };
  const mediaType = input.mediaType ?? "tv";
  return renderToStaticMarkup(
    createElement(UserMessageThread, {
      work: { tmdbId: 1, mediaType, storageId: undefined },
      view,
      run: input.run ?? idleRun,
      nextPatrol: "明早 06:00",
      episodes: input.episodes ?? (mediaType === "tv" ? EPISODES : []),
      now: NOW,
    }),
  );
}

const done = (runId: string, reply: Omit<UserMessageReply, "runId">, over: Partial<ThreadMessage> & { id: string }) =>
  msg({ status: "done", processedAt: "2026-09-27T06:31:00.000Z", reply: { ...reply, runId }, ...over });

describe("UserMessageThread — the states of the mockup", () => {
  it("① resting: just the pill, no heading", () => {
    const html = render({});
    expect(html).toContain('placeholder="哪一集有问题？告诉 agent，下次巡检它会换一个"');
    expect(html).not.toContain("给 agent 的留言</h3>");
    expect(html).toMatch(/<button[^>]*class="um-go"[^>]*disabled=""[^>]*aria-label="发送"|<button[^>]*aria-label="发送"[^>]*disabled=""/);
  });

  it("① a film's pill", () => {
    expect(render({ mediaType: "movie" })).toContain('placeholder="这部有问题？告诉 agent，下次巡检它会换一个"');
  });

  it("③ waiting for the patrol: orange pill, 修改 / 撤回 / 现在处理, the pill still there for more", () => {
    const html = render({ messages: [msg({ id: "m1" })] });
    // Focusable from script only: where the focus lands when the undo toast goes.
    expect(html).toContain('<h3 tabindex="-1">给 agent 的留言</h3>');
    expect(html).toContain('<span class="um-status is-wait">等巡检 · 明早 06:00</span>');
    expect(html).toContain('<span class="um-ep-inline">E13</span><span class="um-ep-inline">E24</span>');
    expect(html).toContain("今天 14:02");
    for (const label of ["修改", "撤回", "现在处理"]) expect(html).toContain(`${label}</button>`);
    expect(html).toContain('placeholder="还有别的？写在这里，排在上面这条后面"');
  });

  it("④ processing: locked message, equalizer, the run's live line", () => {
    const html = render({
      messages: [msg({ id: "m1", status: "processing" })],
      run: { running: true, activity: "正在搜索资源：黄泉のツガイ 13", waitsForRun: true },
    });
    expect(html).toContain('<span class="um-status is-done">已锁定</span>');
    expect(html).toContain('class="um-body is-locked"');
    expect(html).toContain('<span class="um-eq" aria-hidden="true"><i></i><i></i><i></i></span>正在处理');
    expect(html).toContain('<div class="um-ticker" role="status" aria-live="polite"><span>正在搜索资源：黄泉のツガイ 13</span></div>');
    expect(html).not.toContain("修改</button>");
    // No step count (C5).
    expect(html).not.toMatch(/第 \d+ 步/);
  });

  it("④ before the run's first line: a plain one instead of an empty ticker", () => {
    const html = render({ messages: [msg({ id: "m1", status: "processing" })], run: { running: true, activity: null, waitsForRun: true } });
    expect(html).toContain("<span>正在看你的留言</span>");
  });

  it("④+ a message left while processing waits for this run, and can still be changed", () => {
    const html = render({
      messages: [
        msg({ id: "m2", body: "这两集也是蓝的，一起换", episodeTags: ["S01E07", "S01E08"], urgent: true, createdAt: "2026-09-27T06:20:00.000Z" }),
        msg({ id: "m1", status: "processing" }),
      ],
      run: { running: true, activity: "正在转存：[喵萌奶茶屋] 黄泉的使者 13", waitsForRun: true },
    });
    expect(html).toContain("排队中 · 这次处理完接着处理");
    expect(html).toContain("修改</button>");
    expect(html).not.toContain("现在处理</button>");
    // Order: the locked message, the agent at work, then the queued one.
    expect(html.indexOf("已锁定")).toBeLessThan(html.indexOf("正在转存"));
    expect(html.indexOf("正在转存")).toBeLessThan(html.indexOf("排队中"));
  });

  it("现在处理 pressed and nothing running yet: 马上处理", () => {
    expect(render({ messages: [msg({ id: "m1", urgent: true })] })).toContain("排队中 · 马上处理");
  });

  it("⑤ answered: track list, 不换了 on the episode still looked for, old files, the fold", () => {
    const html = render({
      messages: [
        done(
          "run_c",
          {
            results: [
              { episode: "S01E13", outcome: "replaced", label: "[喵萌奶茶屋] 黄泉的使者 13 [1080p][简日双语]", sizeBytes: Math.round(1.1 * 1024 ** 3), note: "换掉了原来的 CR 版" },
              { episode: "S01E24", outcome: "not_found", note: "搜到的 4 个都是原来那份 CR 版" },
            ],
            oldFiles: ["Season 01/Yomi no Tsugai - 13 [CR 1080p].mkv", "Season 01/Yomi no Tsugai - 24 [CR 1080p].mkv"],
          },
          { id: "m3" },
        ),
        done("run_b", { results: [], oldFiles: [] }, { id: "m2", createdAt: "2026-09-25T06:00:00.000Z", processedAt: "2026-09-25T06:30:00.000Z" }),
        done("run_a", { results: [], oldFiles: [] }, { id: "m1", createdAt: "2026-09-24T06:00:00.000Z", processedAt: "2026-09-24T06:30:00.000Z" }),
      ],
      pending: ["S01E24"],
    });
    expect(html).toContain('<span class="um-meta">今天 14:31 处理完</span>');
    expect(html).toContain("换好 1 集，1 集还在找");
    expect(html).toContain("[喵萌奶茶屋] 黄泉的使者 13 [1080p][简日双语]");
    expect(html).toContain("1.1 GB");
    expect(html).toContain("换好了");
    expect(html).toContain("没有找到别的版本");
    expect(html).toContain("继续找");
    expect(html).toContain('aria-label="E24 不换了"');
    expect(html).toContain("旧文件都还在，换好的集确认新的能看再删：");
    expect(html).toContain("Season 01/Yomi no Tsugai - 24 [CR 1080p].mkv");
    expect(html.match(/复制路径/g)?.length).toBe(2);
    expect(html).toContain("换好的那集和旧文件放在一起，播放器里会看到两个 E13。");
    expect(html).toContain("再留一条</button>");
    expect(html).toContain("之前的留言 · 2 条");
    // The answered state has no open composer, just 再留一条.
    expect(html).not.toContain("<textarea");
  });

  it("⑤+ answered with driveLabel: renders '换好了 · 夸克' in the track outcome column", () => {
    const html = render({
      mediaType: "movie",
      messages: [
        done(
          "run_hathaway",
          {
            results: [
              {
                episode: "MOVIE",
                outcome: "replaced",
                label: "机动战士高达 闪光的哈萨维 喀耳刻的魔女 (臻彩) 4K HDR 杜比视界",
                sizeBytes: 9_610_380_966,
                driveLabel: "夸克",
                note: "已用画质更高的新版本替换（约9.0GB，4K/2160p H.265）",
              },
            ],
            oldFiles: ["[Prejudice-Studio] 机动战士高达 闪光的哈萨维 [1080P].mp4"],
          },
          { id: "m_hathaway", body: "画质太差，请尽量找个质量最高的", episodeTags: [] },
        ),
      ],
    });
    expect(html).toContain("机动战士高达 闪光的哈萨维 喀耳刻的魔女 (臻彩) 4K HDR 杜比视界");
    expect(html).toContain("9.0 GB");
    expect(html).toContain("换好了 · 夸克");
  });

  it("⑥ a film still 待换: the red bar with 不换了, and no 不换了 in the track row", () => {
    const html = render({
      mediaType: "movie",
      messages: [
        done(
          "run_f",
          { results: [{ episode: "MOVIE", outcome: "not_found", note: "4 个是这部山寨片" }], oldFiles: ["Movies/奥德赛 (2026)/The.Odyssey.2026.1080p.WEB-DL.mkv"] },
          { id: "m1", body: "这部是假的，是山寨公司拍的同名片，换成诺兰那部", episodeTags: [] },
        ),
      ],
      pending: ["MOVIE"],
    });
    expect(html).toContain('<div class="um-movie-state"><span><b>还在找别的版本。</b>现在这份先留着，之后每次巡检都会接着找。</span>');
    expect(html.match(/不换了<\/button>/g)?.length).toBe(1);
    expect(html).toMatch(/<button type="button" class="um-btn is-outline" data-keep-episode="MOVIE">不换了<\/button>/);
    expect(html).toContain("这次没找到能换的");
    expect(html).toContain("旧文件还在：");
    expect(html).toContain('class="um-tracks is-movie"');
  });

  it("one run, two messages: the 「没看出是哪几集」 hint sits only under the one without episode tags", () => {
    const reply = { results: [{ episode: "S01E04", outcome: "not_found" as const, note: "还是没找到" }], oldFiles: [], unidentified: true };
    const html = render({
      messages: [
        done("run_u", reply, { id: "m2", body: "有几集声音对不上", episodeTags: [], createdAt: "2026-09-27T06:10:00.000Z" }),
        done("run_u", reply, { id: "m1", body: "第 4 集偏色", episodeTags: ["S01E04"], createdAt: "2026-09-27T06:00:00.000Z" }),
      ],
      pending: ["S01E04"],
    });
    const hint = "没看出是哪几集——用「选集数」标出来，再发一次";
    expect(html.split(hint)).toHaveLength(2);
    // After the untagged message, before the agent's reply; not after the tagged one.
    expect(html.indexOf("第 4 集偏色")).toBeLessThan(html.indexOf("有几集声音对不上"));
    expect(html.indexOf("有几集声音对不上")).toBeLessThan(html.indexOf(hint));
    expect(html.indexOf(hint)).toBeLessThan(html.indexOf("还是没找到"));
  });

  it("the agent could not tell which episodes: asks for them", () => {
    const html = render({ messages: [done("run_u", { results: [], oldFiles: [], unidentified: true }, { id: "m1", episodeTags: [] })] });
    expect(html).toContain("没看出是哪几集——用「选集数」标出来，再发一次");
    expect(html).not.toContain('role="table"');
  });

  it("the rejected list could not be saved: one muted line", () => {
    const html = render({
      messages: [
        done(
          "run_r",
          { results: [{ episode: "S01E05", outcome: "replaced", label: "x 05", note: "" }], oldFiles: [], rejectedNotSaved: true },
          { id: "m1", episodeTags: ["S01E05"] },
        ),
      ],
    });
    expect(html).toContain('<p class="um-note is-faint">这次拒掉的版本没能记下来，之后搜索时可能还会看到它</p>');
  });

  it("a replace run looking for 待换 episodes without any new message still shows the agent at work", () => {
    const html = render({ pending: ["S01E24"], run: { running: true, activity: "正在搜索资源：第 24 集", waitsForRun: true } });
    expect(html).toContain("正在处理");
    expect(html).toContain("正在搜索资源：第 24 集");
  });

  it("while a replace run of the work is processing, 不换了 is disabled and says why (its bookkeeping would undo the choice)", () => {
    const answered = done(
      "run_c",
      { results: [{ episode: "S01E24", outcome: "not_found", note: "没找到" }], oldFiles: [] },
      { id: "m1", episodeTags: ["S01E24"] },
    );
    const idle = render({ messages: [answered], pending: ["S01E24"] });
    // data-keep-episode: how the card finds the row's 不换了 to hand the focus back after 撤销.
    expect(idle).toMatch(/<button type="button" class="um-keep" data-keep-episode="S01E24" aria-label="E24 不换了">不换了<\/button>/);

    const html = render({ messages: [answered], pending: ["S01E24"], run: { running: true, activity: "正在搜索资源：第 24 集", waitsForRun: true } });
    const button = /<button[^>]*class="um-keep"[^>]*>不换了<\/button>/.exec(html)?.[0] ?? "";
    expect(button).toContain('disabled=""');
    expect(button).toContain('title="处理中，完了再操作"');
    const describedBy = /aria-describedby="([^"]+)"/.exec(button)?.[1];
    expect(describedBy).toBeTruthy();
    expect(html).toContain(`<span id="${describedBy}" hidden="">处理中，完了再操作</span>`);
  });

  it("a film's 不换了 on the red bar is disabled the same way while its run holds the message", () => {
    const html = render({
      mediaType: "movie",
      messages: [msg({ id: "m2", status: "processing", episodeTags: [] })],
      pending: ["MOVIE"],
      run: { running: true, activity: null, waitsForRun: true },
    });
    const button = /<div class="um-movie-state">[\s\S]*?<button[^>]*>不换了<\/button>/.exec(html)?.[0] ?? "";
    expect(button).toContain('disabled=""');
    expect(button).toContain('title="处理中，完了再操作"');
  });

  it("the undo toast is not in the server markup: it portals into <body> once mounted, above every card", () => {
    const html = render({ messages: [done("run_c", { results: [{ episode: "S01E24", outcome: "not_found", note: "" }], oldFiles: [] }, { id: "m1" })], pending: ["S01E24"] });
    expect(html).not.toContain("um-toast");
  });

  it("an older reply's episode that a newer reply replaced reads 后来换好了; one no longer 待换 otherwise reads 不再待换", () => {
    const html = render({
      messages: [
        done("run_b", { results: [{ episode: "S01E24", outcome: "replaced", label: "[x] 24", note: "" }], oldFiles: [] }, { id: "m2", processedAt: "2026-09-27T07:00:00.000Z" }),
        done(
          "run_a",
          { results: [{ episode: "S01E24", outcome: "not_found", note: "" }, { episode: "S01E13", outcome: "not_found", note: "" }], oldFiles: [] },
          { id: "m1", createdAt: "2026-09-25T06:00:00.000Z", processedAt: "2026-09-25T06:30:00.000Z" },
        ),
      ],
      pending: [],
    });
    const earlier = html.slice(html.indexOf('class="um-earlier"'));
    expect(earlier).toMatch(/E24<\/span>[\s\S]*?<span class="um-out is-off" role="cell">后来换好了<\/span>/);
    expect(earlier).toMatch(/E13<\/span>[\s\S]*?<span class="um-out is-off" role="cell">不再待换<\/span>/);
    expect(html).not.toContain("不找了");
  });
});
