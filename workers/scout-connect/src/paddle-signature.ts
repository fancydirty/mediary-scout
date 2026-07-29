/**
 * Paddle webhook 签名验证(HMAC-SHA256)。
 *
 * 手写而非用官方 SDK:`@paddle/paddle-node-sdk` 的 `webhooks.unmarshal` 依赖
 * Node 的 `crypto` 模块,Workers 运行时没有。这里用 WebCrypto 实现同一算法。
 *
 * 算法(官方文档 developer.paddle.com/webhooks/about/signature-verification/):
 *   1. 取 `Paddle-Signature` 头,格式 `ts=<unix秒>;h1=<hex>`
 *   2. 签名对象是 **`{ts}:{raw_body}`** —— 漏掉 `ts:` 前缀是最常见的实现错误,
 *      HMAC 代码完全正确但签名永远对不上
 *   3. HMAC-SHA256(signedPayload, secret),与 h1 做**常量时间**比较
 *   4. 检查 ts 与当下的差值,防重放
 *
 * **raw body 绝不可解析或改动后再验签** —— 加一个空格、重排 JSON 字段都会让
 * 签名失配。调用方必须传原始文本。
 */

/** 时间窗。官方 SDK 默认 5 秒,这里放宽到 5 分钟:worker 冷启动加上 CF 边缘
 *  排队可能有秒级延迟,5 秒太紧会误拒真实投递 —— 而误拒的后果是用户付了钱
 *  拿不到时长(Paddle 会重试,但重试也可能同样超时)。5 分钟对重放攻击仍足够窄。 */
export const SIGNATURE_TOLERANCE_MS = 5 * 60_000;

export interface ParsedSignature {
  /** Unix 秒。 */
  ts: number;
  /** 可能多个:密钥轮换期 Paddle 会同时发新旧两个签名,任一匹配即通过。 */
  h1: string[];
}

/** 解析 `Paddle-Signature` 头。任何畸形输入返回 null(绝不抛错——
 *  webhook 端点会被随机扫描,不该因为一个垃圾头就 500)。 */
export function parsePaddleSignature(header: string): ParsedSignature | null {
  if (header === "") return null;
  let ts: number | null = null;
  const h1: string[] = [];
  for (const part of header.split(";")) {
    // 只按**第一个** = 切分:hex 里不会有 =,但真出现畸形值时不该静默截断。
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (value === "") continue;
    if (key === "ts") {
      // 必须是纯数字:parseInt("abc123") 会得 NaN,但 parseInt("12abc") 会得 12,
      // 后者是静默接受畸形值,所以用正则先卡形状。
      if (!/^\d+$/.test(value)) return null;
      ts = Number(value);
    } else if (key === "h1") {
      h1.push(value);
    }
  }
  if (ts === null || h1.length === 0) return null;
  return { ts, h1 };
}

/** 常量时间比较 hex 字符串。长度不同直接 false(长度本身不是秘密)。 */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface VerifyInput {
  /** **原始**请求体文本,未经任何解析或格式化。 */
  rawBody: string;
  /** `Paddle-Signature` 头的值。 */
  header: string;
  /** notification destination 的 endpoint secret(pdl_ntfset_ 前缀)。 */
  secret: string;
  nowMs: number;
  toleranceMs?: number;
}

/** 验签 + 时间窗。任何失败都返回 false,不抛错、不区分原因(不给攻击者信息)。 */
export async function verifyPaddleSignature(input: VerifyInput): Promise<boolean> {
  // fail closed:密钥没配时绝不"通过"。调用方另有 503 处理,但这一层自身
  // 也必须安全 —— 否则将来有人复用这个函数就会裸奔。
  if (input.secret === "") return false;
  const parsed = parsePaddleSignature(input.header);
  if (parsed === null) return false;

  // **nowMs 必须先卡 finite**:NaN 会让下面的时间窗检查被静默绕过 ——
  // `Math.abs(NaN - x) > tolerance` 恒为 false,于是任何重放都放行。
  // 调用方传的是 Date.parse(deps.now()),now() 若返回坏值就是 NaN。
  if (!Number.isFinite(input.nowMs)) return false;
  const tolerance = input.toleranceMs ?? SIGNATURE_TOLERANCE_MS;
  if (!Number.isFinite(tolerance) || tolerance < 0) return false;
  // 双向都要卡:太旧是重放,太新则意味着时钟漂移或伪造。
  if (Math.abs(input.nowMs - parsed.ts * 1000) > tolerance) return false;

  // WebCrypto 会抛(如密钥长度不被支持)。本函数的契约是「任何失败返回 false,
  // 不抛错」—— webhook 端点会被随机扫描,一个畸形输入不该变成 500。
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(input.secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = await crypto.subtle.sign(
      "HMAC",
      key,
      // 签名对象:ts 与 body 用冒号连接。ts 用头里的原始值(而非重新格式化),
      // 否则前导零之类的差异会让签名对不上。
      new TextEncoder().encode(`${parsed.ts}:${input.rawBody}`),
    );
    const expected = toHex(mac);
    // hex 大小写不敏感:统一小写后再常量时间比较。
    return parsed.h1.some((candidate) => timingSafeEqualHex(candidate.toLowerCase(), expected));
  } catch {
    return false;
  }
}
