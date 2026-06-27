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
 * 只剥掉零宽/不可见码点,保留普通空白。提取器用它做正则前处理:零宽字符会打断
 * 值捕获(gy.<ZWSP>RT → 只剩 gy.),但普通空白/换行是 label↔值 的有用边界,必须留。
 */
function stripInvisible(raw: string): string {
  let out = "";
  for (const ch of raw) {
    if (INVISIBLE_CODEPOINTS.has(ch.codePointAt(0) ?? -1)) continue;
    out += ch;
  }
  return out;
}

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

// 光鸭 refresh token 以 `gy.` 开头(启发式锚点)。
const REFRESH_HEURISTIC = /\bgy\.[A-Za-z0-9._~+/=-]+/;
// JWT(access token)启发式:三段点分,字符集不含点本身(避免吃进后面的 refreshToken: 等噪声)。
const JWT_HEURISTIC = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/;
// 标签 + 值:标签(access_token / accessToken …)后跟 :/引号/空白,再抓值。值字符集
// 不含点之外的 token 合法字符;用 sanitizeToken 兜底去掉尾巴噪声。
const ACCESS_LABEL = /access[_\s]*token["':\s]+([A-Za-z0-9._~+/=-]+)/i;
const REFRESH_LABEL = /refresh[_\s]*token["':\s]+([A-Za-z0-9._~+/=-]+)/i;

/**
 * 鲁棒提取光鸭 access + refresh token —— parseTokenPaste(纯 JSON)的超集。按序尝试:
 *   1) JSON 块(复用 parseTokenPaste)。
 *   2) 标签文本:`access_token: …` / `refresh_token: …`(容忍 :/引号/空白)。
 *   3) 启发式:access = 第一个 JWT(eyJ…三段);refresh = 第一个 `gy.…`。
 * 仅当 access 与 refresh 都找到才返回(两者都过 sanitizeToken,去空白/零宽/尾部噪声);
 * 否则 null。永不抛错(供 onClick 直接调用)。
 *
 * 为什么先定位 refresh、再在其之前找 access:粘贴常是
 * `…eyJa.b.crefreshToken:gy.…`(换行被吞),JWT 启发式会贪婪吃进 `refreshToken`,
 * 故 access 只在 refresh 标记之前的片段里找。
 */
export function extractGuangYaTokens(raw: string): { accessToken: string; refreshToken: string } | null {
  // 1) JSON 优先(用原文,JSON.parse 自己容忍空白)。
  const json = parseTokenPaste(raw);
  if (json) return json;

  // 2/3) 在「去零宽、保留普通空白」的副本上跑正则:零宽字符会打断值捕获(gy.<ZWSP>RT
  // 只剩 gy.),必须先去掉;但普通空白/换行是 label 与值之间的有用边界,保留。
  const text = stripInvisible(raw);

  // 先定位 refresh(标签优先,回退 gy. 启发式),记下它在文本里的起点。
  let refresh: string | null = null;
  let refreshIndex = text.length;
  const refreshLabel = text.match(REFRESH_LABEL);
  if (refreshLabel && refreshLabel[1]) {
    refresh = refreshLabel[1];
    refreshIndex = refreshLabel.index ?? text.length;
  } else {
    const refreshHeur = text.match(REFRESH_HEURISTIC);
    if (refreshHeur) {
      refresh = refreshHeur[0];
      refreshIndex = refreshHeur.index ?? text.length;
    }
  }

  // access 只在 refresh 标记之前的片段(head)里找——无论标签还是启发式。否则在「换行被
  // onChange 清洗吞掉」的真实粘贴里(accessToken:<JWT>refreshToken:gy.<rt>),access 的值
  // 捕获会越过下一个 refreshToken 标签、把它一并吃进去(实测踩坑)。
  const head = text.slice(0, refreshIndex);
  let access: string | null = null;
  const accessLabel = head.match(ACCESS_LABEL);
  if (accessLabel && accessLabel[1]) {
    access = accessLabel[1];
  } else {
    const jwt = head.match(JWT_HEURISTIC);
    if (jwt) access = jwt[0];
  }

  if (access === null || refresh === null) {
    return null;
  }
  const accessToken = sanitizeToken(access);
  const refreshToken = sanitizeToken(refresh);
  if (accessToken === "" || refreshToken === "") {
    return null;
  }
  return { accessToken, refreshToken };
}
