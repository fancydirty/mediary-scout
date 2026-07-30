/**
 * Resend 通用发信器(到期提醒等非登录邮件)。
 *
 * 与 magic-link-sender 分开:那个是为登录链接定做的(硬编码 subject/文案/按钮),
 * 到期提醒的文案完全不同,硬塞会让两边都不像样。复用的是**同一个 Resend 端点
 * 与超时/错误纪律**,不是同一个文案。
 */
const RESEND_ENDPOINT = "https://api.resend.com/emails";
const FROM = "Mediary Connect <noreply@mediaryconnect.app>";

export type EmailSender = (input: { to: string; subject: string; text: string }) => Promise<void>;

export function createEmailSender(apiKey: string): EmailSender {
  return async ({ to, subject, text }) => {
    const res = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      // 外部 HTTP 一律带超时(同仓所有外部调用的硬纪律),否则上游抖动挂住 Worker。
      signal: AbortSignal.timeout(5_000),
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: FROM,
        to: [to],
        // 到期提醒是**事务性**邮件,不该退订也不能带营销样式 —— 纯文本最稳,
        // 也能躲开 spam 过滤器对重 HTML 事务邮件的判罚。
        subject,
        text,
      }),
    });
    if (!res.ok) {
      // 沿用 magic-link-sender 的纪律:异常留可诊断日志,不含密钥/正文。
      console.error("resend email failed, status:", res.status);
      throw new Error(`resend failed: ${res.status}`);
    }
  };
}

/** 到期提醒文案(纯文本)。
 *  用占位符而非模板库:只有三个变量(日期/天数/地址),引模板引擎不值。 */
export function expiryReminderText(input: {
  expiryDate: string;
  daysLeft: number;
  hostname: string | null;
}): string {
  const where = input.hostname === null ? "" : `你的专属地址 ${input.hostname} `;
  return (
    `你好,\n\n` +
    `${where}将于 ${input.expiryDate} 到期（还有 ${input.daysLeft} 天）。\n\n` +
    `到期后有 7 天宽限期,服务照常;宽限期满后域名会停止解析并回收隧道。` +
    `你的 slug 永久保留——随时回来续期,地址原样恢复(需重跑一次一行接入命令)。\n\n` +
    `续期:https://mediaryconnect.app/pricing\n` +
    `控制台:https://mediaryconnect.app/login\n\n` +
    `—— Mediary Connect(由 DF Digital 运营,付款由 Paddle 处理)\n` +
    `如非你本人,忽略此邮件即可。`
  );
}
