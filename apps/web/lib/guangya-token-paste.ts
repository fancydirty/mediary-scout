/**
 * 光鸭 token 智能粘贴 + 清洗 —— 纯函数,客户端安全(不引入任何 server 模块,
 * 故意不从 @media-track/workflow 引入 sanitizeLlmApiKey:那条 barrel 会把
 * postgres/worker 等服务端代码拖进客户端 bundle)。这里复刻 agent-model.ts 里
 * sanitizeLlmApiKey 用的同一套不可见码点集。
 *
 * 用户在光鸭 Console 跑的 snippet 会把
 * `{"accessToken":"…","refreshToken":"…"}`(JSON)拷进剪贴板。把整块 JSON 粘进
 * 任一 token 框,parseTokenPaste 会自动拆成两个字段;粘裸 token 则走 sanitizeToken。
 */

// 不被正则 \s 类覆盖的零宽码点:零宽空格(200b)、零宽非连字(200c)、零宽连字(200d)。
// 这三个 \s 抓不到,必须显式列出。BOM(FEFF)与 NBSP(00A0)本身已在 \s 内、会被
// sanitizeToken 的 \s 分支剥掉;FEFF 仍冗余列出一份纯属保险,无害。
const INVISIBLE_CODEPOINTS = new Set([0x200b, 0x200c, 0x200d, 0xfeff]);

/**
 * 从粘贴的 token 里剥掉所有空白 + 不可见字符(token 本身不含空白)。防御网页复制
 * 带进来的空格/制表/换行/NBSP/零宽字符/BOM——否则会静默存错值,让用户以为 token 坏了。
 */
export function sanitizeToken(raw: string): string {
  let out = "";
  for (const ch of raw) {
    if (/\s/.test(ch)) continue;
    if (INVISIBLE_CODEPOINTS.has(ch.codePointAt(0) ?? -1)) continue;
    out += ch;
  }
  return out;
}

function pickString(obj: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string") return value;
  }
  return null;
}

/**
 * 试着把粘贴内容当成光鸭 Console snippet 拷出的 JSON 块解析。若对象同时含
 * accessToken|access_token 和 refreshToken|refresh_token,返回两者(已清洗);
 * 否则返回 null(不是 JSON 块,按裸 token 处理)。
 */
export function parseTokenPaste(raw: string): { accessToken: string; refreshToken: string } | null {
  // 便宜的前置守卫:onChange 是热路径,绝大多数输入是裸 token(非 `{` 开头)。
  // 先 startsWith("{") 短路,避免对每次按键都 JSON.parse-抛错-catch(白白制造抖动)。
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  const access = pickString(obj, "accessToken", "access_token");
  const refresh = pickString(obj, "refreshToken", "refresh_token");
  if (access === null || refresh === null) {
    return null;
  }
  return { accessToken: sanitizeToken(access), refreshToken: sanitizeToken(refresh) };
}
