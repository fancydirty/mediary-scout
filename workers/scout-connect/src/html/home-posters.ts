/**
 * Hero 海报墙的**兜底**图片路径(TMDB poster_path)。
 *
 * 数据源:主站 `site/data/posters-fallback.json` —— 刻意复用同一份而不是新造。
 * 两份海报兜底数据会漂移(更新一份忘了另一份就是静默的不一致)。
 *
 * 为什么内联成常量:worker 没有静态资源目录,但海报路径只是字符串,
 * 直接烤进 bundle 即可(28 条约 1KB)。主站的三层降级
 * (实时拉代理 → 本地 fallback → 空着)在这里退化成两层:
 * 内联兜底总是可用,所以海报墙**永远不会空**。
 *
 * 图片本身走 tmdb-proxy(与主站同一个代理),失败时浏览器显示 alt 为空的占位,
 * 而遮罩会盖住大部分区域 —— 视觉退化可接受,不会破版。
 */
export const FALLBACK_POSTERS: readonly string[] = [
  "/mW8QTP2wNE1LF0MtHAyTTjhzg3L.jpg",
  "/xoM3lntYJzZwOBJJs5O1ix0jyfe.jpg",
  "/fqwwPwdpKpgTWXmo16wjleJDalX.jpg",
  "/w5iFwPk6h9fv3zxLN2QkxVEVyBw.jpg",
  "/zGQyw7v2dvb2FNDdVUJFcaPrD5y.jpg",
  "/q0aZ89NDGXxzJeJtJIvpxZmD5e3.jpg",
  "/7flxvNLk48fvJel8zHDGqMFvQ9C.jpg",
  "/f9AFdxegmmWOghgw9E6ebICkstl.jpg",
  "/y4JWxHZ1dMisqbHhX7ytOAK3wwv.jpg",
  "/jRINbGiI9wjM9gwxw4IT5G0ErlU.jpg",
  "/oo46YfPuMcV9t7KsTiaMVUVRjvJ.jpg",
  "/pmNPP4TdwTXl6FgCY8ppOIu096A.jpg",
  "/l9YUbeh0W8B4NjLJee7bsLqdQL1.jpg",
  "/qhQDBIuzNHru06O3q3Q9IC0Nam3.jpg",
  "/mTfjvvBUaDmexYEPwVqBFsYYh8.jpg",
  "/5flBkpyqwxyq69HzRnV6XL8nOUa.jpg",
  "/3O6ufZBBjLB29NpJOe8awMzQ4XN.jpg",
  "/wMSO4QgEyUhnf1XLIpz5w371xtb.jpg",
  "/n4hv5lQvuXBdNyJAAelDnwv6Emw.jpg",
  "/7y1ibpkTwlKYrxFbq3lh2RgIB1k.jpg",
  "/1hPSbiyfAhtWAIBf2XtDPA0NyvS.jpg",
  "/kWlGge7cWOTp0qZnYCRfUo0BTP9.jpg",
  "/9BnjnrfoZbeNjwXICd8Sax8zKeH.jpg",
  "/6yRBwqaKcFlp9TBIuZgLvJip8hA.jpg",
  "/ydEgw9vDABo4hiHsP29BVtMRTfS.jpg",
  "/nbLginNBtPaqz12tSvMjzvxuPFJ.jpg",
  "/9zFVOpQ0QSg0pOHQdFtNj7NDamp.jpg",
  "/zrE9zyK2iikJ8F2ls8YRCZD8wEi.jpg"
];

/** TMDB 图片代理(与主站同源,w342 是海报墙够用的最小尺寸)。 */
export const POSTER_BASE = "https://tmdb-proxy.mediaryscout.app/img/t/p/w342";
