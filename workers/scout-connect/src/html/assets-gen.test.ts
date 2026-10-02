import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RAW_ASSETS } from "./assets.gen.js";

describe("generated asset freshness", () => {
  it("assets.gen.ts matches assets/*.sh byte-for-byte", () => {
    // 生成文件进 git；assets/*.sh 改了但忘了重新生成 → 这里红。
    // worker 直接 serving RAW_ASSETS["connect.sh"]，漂移会让生产发陈旧脚本
    // （#220 改了 assets/connect.sh 但没重跑生成器，线上一直发旧版）。
    // import.meta.url 而非 __dirname：对齐 compliance-page.test.ts，ESM 下稳。
    const assetsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "assets");
    const files = readdirSync(assetsDir).filter((f) => f.endsWith(".sh")).sort();
    expect(files).toEqual(Object.keys(RAW_ASSETS).sort());
    for (const f of files) {
      expect(RAW_ASSETS[f], `${f} 与生成文件不一致——跑 node scripts/generate-content.mjs`).toBe(
        readFileSync(join(assetsDir, f), "utf8"),
      );
    }
  });
});
