/**
 * 容量闸门常量。
 *
 * CF 隧道上限是 **1000/账号,且所有套餐一致(含 Enterprise)** —— 官方
 * account-limits 页面与 CF 员工社区回复双重确认,买套餐也提不了,只能联系 Sales。
 * 另外 hostname routes 也是 1000/账号且**与 tunnel 共享配额**,而我们每个用户
 * 消耗 1 条 tunnel + 1 条 hostname route,所以真实上限就是 1000 个用户。
 *
 * 留 10 条余量给运维:故障重建、作者自用、以及「删了 CF 侧但 DB 还没写成功」
 * 的中间态。撞上真上限的后果不是降级,而是**收了钱交不了货**——用户付款、过了
 * entitlement 门禁,在 createTunnel 才拿到 CF 报错。
 */
export const CAPACITY_LIMIT = 990;

/** provisionEndpoint 在容量满时抛出的确切 message。
 *  两条 provision 路由(自助 /api/provision 与 admin invite)都要能识别它并映射
 *  503,所以常量化——字符串字面量散在两处迟早对不上。 */
export const AT_CAPACITY_MESSAGE = "at capacity";

/** 把「容量已满」映射成 503。
 *
 *  503 而非 4xx:这是**我方**容量问题(CF 隧道 1000 硬上限),用户的请求本身
 *  完全合法。4xx 会让用户以为自己填错了。
 *
 *  两条路由共用同一个 helper,而不是各写一遍 includes 判断 —— provisionEndpoint
 *  是共享函数,任何调用方漏掉这个映射都会让容量满变成 500(Copilot round-4
 *  指出 admin invite 路径正是如此)。 */
export function isAtCapacityError(e: unknown): boolean {
  return e instanceof Error && e.message === AT_CAPACITY_MESSAGE;
}
