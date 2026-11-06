/**
 * 通用发信器：支持 Cloudflare Email Service (`env.EMAIL`) 与 Resend。
 *
 * 承载底层发送协议（`send_email` binding vs Resend HTTP API）、5s 超时与诊断日志纪律，
 * 供到期提醒 (`createEmailSender`)、登录魔法链接 (`magic-link-sender`) 与实例绑定确认
 * (`instance-link-sender`) 共同复用。
 */
import type { SendEmailBinding } from "./env.js";

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const FROM_STRING = "Mediary Connect <noreply@mediaryconnect.app>";
const FROM_ADDRESS = { email: "noreply@mediaryconnect.app", name: "Mediary Connect" };

export type EmailTransport = string | SendEmailBinding;

export interface TransactionalEmailInput {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export type EmailSender = (input: TransactionalEmailInput) => Promise<void>;

function extractBindingErrorDetail(err: unknown): string {
  if (err && typeof err === "object") {
    const code = "code" in err && typeof (err as { code?: unknown }).code === "string"
      ? (err as { code: string }).code.trim()
      : "";
    const message = err instanceof Error && err.message.trim() !== "" ? err.message.trim() : "";
    if (code && message) return `${code} (${message})`;
    if (code) return code;
    if (message) return message;
  }
  return "unknown";
}

export async function dispatchTransactionalEmail(
  transport: EmailTransport,
  input: TransactionalEmailInput,
  logContext = "email",
): Promise<void> {
  const { to, subject, text, html } = input;
  if (typeof transport !== "string") {
    try {
      await transport.send({
        from: FROM_ADDRESS,
        to,
        subject,
        text,
        ...(html !== undefined ? { html } : {}),
      });
      return;
    } catch (err) {
      const detail = extractBindingErrorDetail(err);
      console.error(`cf ${logContext} failed, code:`, detail);
      throw new Error(`cf email failed: ${detail}`);
    }
  }

  const res = await fetch(RESEND_ENDPOINT, {
    method: "POST",
    // 外部 HTTP 一律带超时(同仓所有外部调用的硬纪律),否则上游抖动挂住 Worker。
    signal: AbortSignal.timeout(5_000),
    headers: {
      authorization: `Bearer ${transport}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: FROM_STRING,
      to: [to],
      subject,
      text,
      ...(html !== undefined ? { html } : {}),
    }),
  });
  if (!res.ok) {
    // 沿用 PR #184 的分类记录法:异常留可诊断日志,不含密钥/正文。
    console.error(`resend ${logContext} failed, status:`, res.status);
    throw new Error(`resend failed: ${res.status}`);
  }
}

export function createEmailSender(transport: EmailTransport): EmailSender {
  return async (input) => {
    await dispatchTransactionalEmail(transport, input, "email");
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
    `到期后有 7 天宽限期,服务照常;宽限期满前续期,一切照旧。` +
    // 提醒在到期前发出，那时地址还在用：恢复只说给宽限期满、地址已被收回的情形。
    `宽限期满后域名会停止解析并回收隧道,但地址永久为你保留——` +
    `那之后续期,在控制台点「恢复原地址」，再接入一次即可` +
    `（容器版也可以在实例的 设置 → 远程访问 里完成）。\n\n` +
    `续期:https://mediaryconnect.app/pricing\n` +
    `控制台:https://mediaryconnect.app/login\n\n` +
    `—— Mediary Connect(由 DF Digital 运营,订单由 Waffo.com Limited 处理,使用微信支付)\n` +
    `如非你本人,忽略此邮件即可。`
  );
}
