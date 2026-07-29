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
