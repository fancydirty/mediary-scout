/**
 * 魔法链接发信器：支持 Cloudflare Email Service (`env.EMAIL`) 原生绑定与 Resend API key。
 * 注入到 RouteDeps.sendMagicLink，测试不打真 API。
 */

import { dispatchTransactionalEmail, type EmailTransport } from "./email-sender.js";

/** HTML 属性转义:URL 里的引号/尖括号在邮件客户端里不能破坏 href 属性。 */
function escapeAttr(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}
const SUBJECT = "Mediary Connect 登录链接";

export function createMagicLinkSender(
  transport: EmailTransport,
): (to: string, url: string) => Promise<void> {
  return async (to: string, url: string) => {
    const text =
      `点击下面的链接登录 Mediary Connect 控制台（30 分钟内有效）：\n\n${url}\n\n` +
      `如果不是你本人操作，忽略此邮件即可。`;
    const html =
      `<div style="font-family:system-ui,sans-serif;line-height:1.7;color:#222">` +
      `<h2 style="font-size:18px">Mediary Connect 登录</h2>` +
      `<p>点击下面的按钮登录控制台（30 分钟内有效）：</p>` +
      `<p><a href="${escapeAttr(url)}" style="display:inline-block;padding:10px 18px;` +
      `border-radius:999px;background:#1ed760;color:#06210f;font-weight:700;` +
      `text-decoration:none">登录控制台</a></p>` +
      `<p style="color:#666;font-size:13px">如果不是你本人操作，忽略此邮件即可。</p></div>`;

    await dispatchTransactionalEmail(
      transport,
      { to, subject: SUBJECT, text, html },
      "magic link",
    );
  };
}
