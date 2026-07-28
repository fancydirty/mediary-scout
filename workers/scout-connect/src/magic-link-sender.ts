/**
 * Resend 发信(魔法链接)。实测过 QQ/163/126 三家均进收件箱且快
 * (见交接文档 P3 决策 #7)。注入到 RouteDeps.sendMagicLink,测试不打真 API。
 */

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const FROM = "Mediary Connect <noreply@mediaryconnect.app>";

export function createMagicLinkSender(apiKey: string): (to: string, url: string) => Promise<void> {
  return async (to: string, url: string) => {
    const res = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      // project 硬规则:外部 HTTP 一律带超时(同 routes.ts 的 siteverify),
      // 否则上游抖动会挂住 Worker、占用并发。
      signal: AbortSignal.timeout(5_000),
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: FROM,
        to: [to],
        subject: "Mediary Connect 登录链接",
        text:
          `点击下面的链接登录 Mediary Connect 控制台（30 分钟内有效）：\n\n${url}\n\n` +
          `如果不是你本人操作，忽略此邮件即可。`,
        html:
          `<div style="font-family:system-ui,sans-serif;line-height:1.7;color:#222">` +
          `<h2 style="font-size:18px">Mediary Connect 登录</h2>` +
          `<p>点击下面的按钮登录控制台（30 分钟内有效）：</p>` +
          `<p><a href="${url}" style="display:inline-block;padding:10px 18px;` +
          `border-radius:999px;background:#1ed760;color:#06210f;font-weight:700;` +
          `text-decoration:none">登录控制台</a></p>` +
          `<p style="color:#666;font-size:13px">如果不是你本人操作，忽略此邮件即可。</p></div>`,
      }),
    });
    if (!res.ok) {
      // 发信失败不暴露给用户(魔法链接请求固定 202),但要留可诊断日志。
      // 沿用 PR #184 的分类记录法:基础设施异常留痕,不含密钥。
      console.error("resend magic link failed, status:", res.status);
      throw new Error(`resend failed: ${res.status}`);
    }
  };
}
