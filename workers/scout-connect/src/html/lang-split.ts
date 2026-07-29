/**
 * 把双语 .md 拆成中文页与英文页。
 *
 * 背景:五个合规页原先是「英文块 + 中文块」交替排在同一页(为照顾 Paddle
 * 审核员)。但真人读者中英交叉着看非常累——用户明确反馈。所以改成各自一页,
 * 用切换按钮互跳。
 *
 * 为什么不发明新语法(如 `<!-- en -->` 分隔符):内容已经是「先英文块、
 * 再中文块」的成对结构,而 renderMarkdown 早就靠同一判据正确区分
 * 两者(合规页已上线验证过)。复用同一判据拆分,.md 一个字都不用改,也不会
 * 出现「作者忘了写分隔符」这类新故障模式。
 *
 * 判据由本模块单一实现并导出,markdown.ts 直接 import 复用(它用同一判据给
 * 块挂 class="zh")。**曾经两边各有一份**,审计实测出 4 处判定不一致(带链接
 * 的中文段在 lang-split 判中文、在 markdown 判英文),已合并为一处——注释
 * 声称"单一实现"而代码不是,比没有注释更糟。
 */

/**
 * 计数前先剔除「语种无关的拉丁字母来源」:URL、Markdown 链接的 href、
 * 行内代码。
 *
 * 这不是洁癖,是真 bug:refund.md 里那段中文
 * 「这一承诺与…Paddle 的 [Buyer Terms](https://www.paddle.com/legal/…) 一致…」
 * 中文 52 字,但 URL + 专名带进来 78 个拉丁字母 → 被判成英文块。后果是
 * 该段同时出现在英文页(本该只有英文版),又从中文页消失。terms.md 里
 * 含 `<你选的名字>.mediaryconnect.app` 的段落同理(59 vs 61)。
 * 域名/代码不表达语种,计数时必须排除。
 */
function stripLangNeutralTokens(text: string): string {
  return text
    // 行内代码:`...`
    .replace(/`[^`]*`/g, " ")
    // Markdown 链接只保留可见文字,丢掉 href
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    // 裸 URL
    .replace(/https?:\/\/\S+/gi, " ")
    // 裸域名(如 foo.mediaryconnect.app)
    .replace(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\b/gi, " ");
}

/** CJK **专属**全角标点。出现即中文侧——这是比"数字数"更强的信号:
 *  「如有争议,以 Paddle Buyer Terms 与适用法律为准。」中文 12 字但英文专名
 *  16 个字母,靠数量判会翻车;而全角逗号/句号只会出现在中文写作里。
 *
 *  **刻意不收 `—`(em dash)与 `…`(ellipsis)**:这两个在英文排版里同样常用
 *  ——本仓 content/*.md 里就有 10 个纯英文块用了 em dash。早先把它们算进
 *  中文信号,导致「No conditions, no exceptions, no deductions — …」这段
 *  英文正文被判成中文块,直接从英文页消失(测试抓到)。
 *  只保留中日韩排版专属的那些。 */
const CJK_PUNCT_RE = /[，。；：、！？（）「」『』《》〈〉【】〔〕·]/;

/** 块内是否为中文块。
 *
 *  名字刻意不叫 isCjkMajority:它**不做**多数/数量对比(改过判据后语义已变),
 *  沿用旧名会误导调用方。
 *
 *  判据:**剔除 URL/代码/域名后仍含任何 CJK 表意文字 → 中文**。
 *
 *  为什么不是"数汉字多于拉丁字母":实测会漏。contact.md 的
 *  「支持与商务:**support@mediaryconnect.app**」中文 5 字、拉丁 7 字(邮箱本地
 *  部分),按数量判成英文 → 中文联系页直接看不到支持邮箱,而联系方式是 Paddle
 *  域名审核的硬性检查项。「Mediary Scout 是开源项目:[github.com/...]」同理
 *  (5 vs 34,链接可见文字里的路径段计进了拉丁)。
 *
 *  本仓的双语约定是"英文块与中文块成对出现",所以中文块必然含汉字、英文块
 *  必然不含。既然如此,"含 CJK 即中文"才是与约定同构的判据;数量比较是个
 *  更弱的近似,只会在专名/URL/邮箱多的块上翻车。
 *
 *  URL/代码/域名仍要先剔除:它们可能含 CJK 吗?域名不会,但行内代码里可能
 *  写中文占位符(如 `<你选的名字>.mediaryconnect.app`)。那种块的**语种由其余
 *  正文决定**,不该被代码里的占位符绑定,故剔除后再判。 */
export function isZhBlock(text: string): boolean {
  const cleaned = stripLangNeutralTokens(text);
  for (const ch of cleaned) {
    const code = ch.codePointAt(0)!;
    if (code >= 0x4e00 && code <= 0x9fff) return true;
  }
  // 无汉字但有 CJK 专属标点(如整块只有「、」「。」)也算中文侧。
  // em dash「——」与省略号「…」**不算**(见 CJK_PUNCT_RE:英文排版同样常用)。
  return CJK_PUNCT_RE.test(cleaned);
}

export type Lang = "en" | "zh";

/**
 * 取出 md 中属于指定语言的块。
 *
 * 规则:
 * - 含汉字(或 CJK 专属标点)的块 → 中文页;其余 → 英文页。
 * - **语言中立的块两页都留**:`---`(hr)、纯 URL、纯代码、纯数字/符号。
 *   这类块 `isZhBlock` 返回 false(既无汉字也无 CJK 标点),若简单按 false 归给
 *   英文页,中文页就会丢掉分隔线之类的结构元素,版式塌掉。
 */
export function extractLang(md: string, lang: Lang): string {
  const blocks = md.replace(/\r\n/g, "\n").split(/\n{2,}/);
  const kept: string[] = [];
  for (const block of blocks) {
    const trimmed = block.trim();
    if (trimmed === "") continue;
    if (isLangNeutral(trimmed)) {
      kept.push(trimmed);
      continue;
    }
    const blockLang: Lang = isZhBlock(trimmed) ? "zh" : "en";
    if (blockLang === lang) kept.push(trimmed);
  }
  return lang === "zh" ? promoteFirstHeading(kept).join("\n\n") : kept.join("\n\n");
}

/**
 * 中文页:把首个 `## X` 提升为 `# X`。
 *
 * 本仓的双语约定是「`# English Title` + `## 中文标题`」——并排时中文作次级
 * 标题是对的。但单语成页后,中文页就**没有 h1 了**(实测五页 zh h1 全为 0),
 * 首个元素是 h2:文档缺主标题,SEO 与审核员观感都差。
 *
 * 只提升第一个标题块,且只在它确实是 h2 时;其余层级一律不动(否则会把正文
 * 里的小节标题也拔上来,搞乱层级)。找不到 h2 就原样返回——宁可不动也不猜。
 */
function promoteFirstHeading(blocks: string[]): string[] {
  const idx = blocks.findIndex((b) => /^#{1,6}\s+/.test(b));
  if (idx === -1) return blocks;
  const first = blocks[idx]!;
  if (!/^##\s+/.test(first)) return blocks;
  const out = blocks.slice();
  out[idx] = first.replace(/^##\s+/, "# ");
  return out;
}

/** 语言中立块:既无汉字、无 CJK 专属标点,也无 ASCII 字母(同样先剔除
 *  URL/代码/域名——一个只有链接的块不表达语种,两页都该留)。
 *  例:`---`、`2026-07-28`、纯符号行。
 *
 *  **必须把 CJK 专属标点计入**:否则「只含全角标点、无汉字」的块(如整块
 *  只有「。。。」)会被判成中立而**同时出现在中英两页**(实测确认),且与
 *  isZhBlock「全角标点算中文侧」的规则自相矛盾。 */
function isLangNeutral(text: string): boolean {
  const cleaned = stripLangNeutralTokens(text);
  if (CJK_PUNCT_RE.test(cleaned)) return false;
  let cjk = 0;
  let latin = 0;
  for (const ch of cleaned) {
    const code = ch.codePointAt(0)!;
    if (code >= 0x4e00 && code <= 0x9fff) cjk++;
    else if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) latin++;
  }
  return cjk === 0 && latin === 0;
}
