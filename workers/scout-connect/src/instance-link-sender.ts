const RESEND_ENDPOINT = "https://api.resend.com/emails";
const FROM = "Mediary Connect <noreply@mediaryconnect.app>";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}

export interface InstanceLinkEmailDetails {
  url: string;
  verifyCode: string;
  requestIp: string;
  requestedAt: string;
}

/** Sends the instance-link confirmation email through Resend. */
export function createInstanceLinkSender(
  apiKey: string,
): (to: string, details: InstanceLinkEmailDetails) => Promise<void> {
  return async (to, details) => {
    const safeUrl = escapeHtml(details.url);
    const safeCode = escapeHtml(details.verifyCode);
    const safeIp = escapeHtml(details.requestIp || "未知");
    const safeAt = escapeHtml(details.requestedAt);
    const res = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      signal: AbortSignal.timeout(5_000),
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: FROM,
        to: [to],
        subject: "确认连接你的 Mediary Scout 实例",
        text:
          `有人请求连接你的 Mediary Scout 实例。\n\n` +
          `验证码：${details.verifyCode}\n` +
          `请求 IP：${details.requestIp || "未知"}\n` +
          `请求时间：${details.requestedAt}\n\n` +
          `请在 30 分钟内打开下面的链接确认连接：\n${details.url}\n\n` +
          `不是你发起的请忽略这封邮件。`,
        html:
          `<div style="font-family:system-ui,sans-serif;line-height:1.7;color:#222">` +
          `<h2 style="font-size:18px">确认连接你的 Mediary Scout 实例</h2>` +
          `<p>有人请求把一个 Mediary Scout 实例连接到你的 Mediary Connect 账户。</p>` +
          `<p>验证码：<strong style="font-size:26px;letter-spacing:4px">${safeCode}</strong></p>` +
          `<p>请求 IP：${safeIp}<br>请求时间：${safeAt}</p>` +
          `<p><a href="${safeUrl}" style="display:inline-block;padding:10px 18px;border-radius:999px;background:#1ed760;color:#06210f;font-weight:700;text-decoration:none">确认连接</a></p>` +
          `<p style="color:#666;font-size:13px">链接 30 分钟内有效。不是你发起的请忽略这封邮件。</p></div>`,
      }),
    });
    if (!res.ok) {
      console.error("resend instance link failed, status:", res.status);
      throw new Error(`resend failed: ${res.status}`);
    }
  };
}
