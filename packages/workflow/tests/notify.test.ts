import { describe, expect, it } from "vitest";
import {
  buildNotifyMessage,
  createBarkChannel,
  createNotifyChannelsFromEnv,
  createServerChanChannel,
  createWebhookChannel,
  createWeComChannel,
  dispatchNotifications,
  type NotificationReport,
  type NotifyFetch,
} from "../src/index.js";

interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

function recordingFetch(requests: RecordedRequest[], ok = true): NotifyFetch {
  return async (url, init) => {
    requests.push({
      url,
      method: init.method,
      headers: init.headers ?? {},
      body: init.body ?? "",
    });
    return { ok, status: ok ? 200 : 500 };
  };
}

const message = {
  title: "黑袍纠察队 更新",
  text: "S05E08 已入库",
  markdown: "**S05E08** 已入库",
};

describe("notify channels", () => {
  it("bark posts JSON to api.day.app with the device key", async () => {
    const requests: RecordedRequest[] = [];
    const channel = createBarkChannel({ key: "device_key", fetchImpl: recordingFetch(requests) });
    await channel.send(message);

    expect(requests[0]?.url).toBe("https://api.day.app/device_key");
    const body = JSON.parse(requests[0]!.body);
    expect(body).toMatchObject({ title: message.title, body: message.text, group: "media-track" });
  });

  it("serverchan posts title/desp with markdown preferred", async () => {
    const requests: RecordedRequest[] = [];
    const channel = createServerChanChannel({
      sendKey: "SCT_KEY",
      fetchImpl: recordingFetch(requests),
    });
    await channel.send(message);

    expect(requests[0]?.url).toBe("https://sctapi.ftqq.com/SCT_KEY.send");
    const body = new URLSearchParams(requests[0]!.body);
    expect(body.get("title")).toBe(message.title);
    expect(body.get("desp")).toBe(message.markdown);
  });

  it("wecom posts markdown msgtype when markdown is present, text otherwise", async () => {
    const requests: RecordedRequest[] = [];
    const channel = createWeComChannel({
      webhookUrl: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=K",
      fetchImpl: recordingFetch(requests),
    });
    await channel.send(message);
    await channel.send({ title: "t", text: "plain" });

    expect(JSON.parse(requests[0]!.body)).toEqual({
      msgtype: "markdown",
      markdown: { content: `**${message.title}**\n${message.markdown}` },
    });
    expect(JSON.parse(requests[1]!.body)).toEqual({
      msgtype: "text",
      text: { content: "t\nplain" },
    });
  });

  it("bark uses the poster as the icon and adds the tap-through url", async () => {
    const requests: RecordedRequest[] = [];
    const channel = createBarkChannel({ key: "k", fetchImpl: recordingFetch(requests) });
    await channel.send({ title: "热辣滚烫", text: "已入库", imageUrl: "https://img/p.jpg", url: "https://app/show/1" });
    expect(JSON.parse(requests[0]!.body)).toMatchObject({ icon: "https://img/p.jpg", url: "https://app/show/1" });
  });

  it("wecom uses a news card (poster + link) when an image and url are present", async () => {
    const requests: RecordedRequest[] = [];
    const channel = createWeComChannel({ webhookUrl: "https://q/send?key=K", fetchImpl: recordingFetch(requests) });
    await channel.send({ title: "热辣滚烫", text: "已入库", markdown: "**热辣滚烫**", imageUrl: "https://img/p.jpg", url: "https://app/show/1" });
    expect(JSON.parse(requests[0]!.body)).toEqual({
      msgtype: "news",
      news: { articles: [{ title: "热辣滚烫", description: "已入库", url: "https://app/show/1", picurl: "https://img/p.jpg" }] },
    });
  });

  it("generic webhook posts the whole message as JSON", async () => {
    const requests: RecordedRequest[] = [];
    const channel = createWebhookChannel({
      url: "https://example.com/hook",
      fetchImpl: recordingFetch(requests),
    });
    await channel.send(message);

    expect(requests[0]?.url).toBe("https://example.com/hook");
    expect(JSON.parse(requests[0]!.body)).toMatchObject({
      title: message.title,
      text: message.text,
      markdown: message.markdown,
    });
  });

  it("builds only the channels configured in env", () => {
    const channels = createNotifyChannelsFromEnv({
      MEDIA_TRACK_PUSH_BARK_KEY: "bk",
      MEDIA_TRACK_PUSH_WEBHOOK_URL: "https://example.com/h",
    });
    expect(channels.map((channel) => channel.id).sort()).toEqual(["bark", "webhook"]);
    expect(createNotifyChannelsFromEnv({})).toEqual([]);
  });
});

describe("dispatchNotifications", () => {
  it("sends every notification to every channel and reports failures without throwing", async () => {
    const okRequests: RecordedRequest[] = [];
    const ok = createBarkChannel({ key: "k", fetchImpl: recordingFetch(okRequests) });
    const failing = createWebhookChannel({
      url: "https://down.example.com/hook",
      fetchImpl: recordingFetch([], false),
    });

    const result = await dispatchNotifications({
      channels: [ok, failing],
      notifications: [
        {
          id: "n1",
          workflowRunId: "r1",
          kind: "episodes_restored",
          title: "翘楚 episodes restored",
          body: "2 episodes restored",
          createdAt: "2026-06-13T00:00:00.000Z",
        },
        {
          id: "n2",
          workflowRunId: "r1",
          kind: "already_current",
          title: "翘楚 already current",
          body: "0 episodes restored",
          createdAt: "2026-06-13T00:00:01.000Z",
        },
      ],
    });

    expect(okRequests).toHaveLength(2);
    expect(result.sent).toBe(2);
    expect(result.failures).toHaveLength(2);
    expect(result.failures[0]?.channelId).toBe("webhook");
  });

  it("builds a RICH message from the report (poster + markdown + link) via buildNotifyMessage", async () => {
    const requests: RecordedRequest[] = [];
    const channel = createWebhookChannel({ url: "https://hook", fetchImpl: recordingFetch(requests) });
    await dispatchNotifications({
      channels: [channel],
      notifications: [
        {
          id: "n",
          workflowRunId: "r",
          kind: "movie_init",
          title: "热辣滚烫",
          body: "📺 热辣滚烫\n✅ 已获取入库",
          createdAt: "2026-06-16T00:00:00.000Z",
          report: {
            titleName: "热辣滚烫",
            seasonLabel: null,
            status: "acquired",
            lines: ["已获取入库"],
            newlyObtained: [],
            realMissing: [],
            posterPath: "/p.jpg",
            tmdbId: 1184918,
            mediaType: "movie",
            year: 2024,
          },
        },
      ],
      opts: { webBaseUrl: "https://app.example.com" },
    });
    const sent = JSON.parse(requests[0]!.body);
    expect(sent.imageUrl).toBe("https://image.tmdb.org/t/p/w500/p.jpg");
    expect(sent.url).toBe("https://app.example.com/show/1184918");
    expect(sent.markdown).toContain("![](https://image.tmdb.org/t/p/w500/p.jpg)");
  });

  it("falls back to plain {title, text} when a notification has no report", async () => {
    const requests: RecordedRequest[] = [];
    const channel = createWebhookChannel({ url: "https://hook", fetchImpl: recordingFetch(requests) });
    await dispatchNotifications({
      channels: [channel],
      notifications: [{ id: "n", workflowRunId: "r", kind: "x", title: "T", body: "B", createdAt: "2026-06-16T00:00:00.000Z" }],
    });
    expect(JSON.parse(requests[0]!.body)).toMatchObject({ title: "T", text: "B" });
  });
});

describe("buildNotifyMessage — rich per-channel push payload (L2)", () => {
  function movieReport(extra: Partial<NotificationReport> = {}): NotificationReport {
    return {
      titleName: "热辣滚烫",
      seasonLabel: null,
      status: "acquired",
      lines: ["已获取入库"],
      newlyObtained: [],
      realMissing: [],
      quality: "2160p",
      posterPath: "/abc.jpg",
      tmdbId: 1184918,
      mediaType: "movie",
      year: 2024,
      ...extra,
    };
  }

  it("builds title/text/markdown/imageUrl/url from an enriched report", () => {
    const msg = buildNotifyMessage(movieReport(), { webBaseUrl: "https://app.example.com" });
    expect(msg.title).toBe("热辣滚烫 (2024)");
    expect(msg.text).toContain("已获取入库"); // plain-text fallback unchanged
    expect(msg.imageUrl).toBe("https://image.tmdb.org/t/p/w500/abc.jpg"); // TMDB CDN — no self-hosting
    expect(msg.url).toBe("https://app.example.com/show/1184918");
    expect(msg.markdown).toContain("![](https://image.tmdb.org/t/p/w500/abc.jpg)");
    expect(msg.markdown).toContain("热辣滚烫 (2024)");
    expect(msg.markdown).toContain("2160p");
    expect(msg.markdown).toContain("https://app.example.com/show/1184918");
  });

  it("degrades gracefully with NO webBaseUrl (local dev, no domain) — poster stays, no link", () => {
    const msg = buildNotifyMessage(movieReport());
    expect(msg.url).toBeUndefined();
    expect(msg.markdown).not.toContain("查看详情");
    expect(msg.imageUrl).toBe("https://image.tmdb.org/t/p/w500/abc.jpg"); // poster works without a domain
  });

  it("omits the poster when the title has no posterPath", () => {
    const msg = buildNotifyMessage(movieReport({ posterPath: null }), { webBaseUrl: "https://app.example.com" });
    expect(msg.imageUrl).toBeUndefined();
    expect(msg.markdown).not.toContain("![](");
  });

  it("a TV season carries the season label, not a movie year, in the title", () => {
    const msg = buildNotifyMessage(
      movieReport({ seasonLabel: "第 1 季", mediaType: "tv", year: 2026, status: "airing", lines: ["已获取至最新第 6 集"] }),
    );
    expect(msg.title).toBe("热辣滚烫 第 1 季");
  });
});
