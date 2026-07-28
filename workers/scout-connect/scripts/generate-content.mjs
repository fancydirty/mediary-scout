#!/usr/bin/env node
/**
 * 把 src/content/*.md 生成为 src/html/compliance-content.gen.ts。
 *
 * 为什么生成而不是 import .md:wrangler 的 rules(text 模块)和 vitest 的
 * 转换器要各配一份,两套构建管线为五个静态页面不值得。生成 .ts 后,
 * worker 与测试用完全相同的普通 import,零配置差异。
 *
 * 生成文件进 git(带 DO NOT EDIT 头);CI 里由 schema.test.ts 同款思路的
 * 新鲜度测试守护:content/*.md 变了但没重新生成 → 测试红。
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const contentDir = join(root, "..", "src", "content");
const outFile = join(root, "..", "src", "html", "compliance-content.gen.ts");

const files = readdirSync(contentDir)
  .filter((f) => f.endsWith(".md"))
  .sort();

const entries = files.map((f) => {
  const key = f.replace(/\.md$/, "");
  const raw = readFileSync(join(contentDir, f), "utf8");
  return `  ${JSON.stringify(key)}: ${JSON.stringify(raw)},`;
});

const banner = `// DO NOT EDIT — generated from src/content/*.md by scripts/generate-content.mjs
// Regenerate: node scripts/generate-content.mjs
`;

writeFileSync(
  outFile,
  `${banner}
export const COMPLIANCE_MARKDOWN: Record<string, string> = {
${entries.join("\n")}
};
`,
);

console.log(`generated ${outFile} from ${files.length} md files: ${files.join(", ")}`);

// assets/*.sh(如 connect.sh)也内联进 .ts,worker 直接 serving,无需额外托管。
const assetsDir = join(root, "..", "assets");
const assetOut = join(root, "..", "src", "html", "assets.gen.ts");
const assetFiles = readdirSync(assetsDir).filter((f) => f.endsWith(".sh")).sort();
const assetEntries = assetFiles.map((f) => {
  const raw = readFileSync(join(assetsDir, f), "utf8");
  return `  ${JSON.stringify(f)}: ${JSON.stringify(raw)},`;
});
writeFileSync(
  assetOut,
  `${banner}
export const RAW_ASSETS: Record<string, string> = {
${assetEntries.join("\n")}
};
`,
);
console.log(`generated ${assetOut} from ${assetFiles.length} asset(s): ${assetFiles.join(", ")}`);
