# Mediary Connect 全量切换支付宝设计

日期：2026-08-16
状态：已获用户口头确认，待书面规格确认
目标分支：`codex/mediary-connect-alipay`

## 1. 目标

将 Mediary Connect 的 checkout service 从 Paddle 全量切换为支付宝 AI 网页应用收款。所有语言、所有用户和全部售卖档位都只走支付宝；付款成功后获得的时长、续费叠加、宽限期、slug、隧道和自助开通体验保持不变。

固定价格不变：

| 档位 | 金额 | 权益 |
|---|---:|---:|
| 季度 | ¥45.00 | 3 个月 |
| 年度 | ¥108.00 | 12 个月 |
| 两年 | ¥188.00 | 24 个月 |

生产 D1 在设计时有 2 条历史 `source=paddle` 权益和 1 条手工权益。它们不删除、不改月数，继续参与有效期计算；切换后不能再创建新的 Paddle 订单或权益。

## 2. 已确认决策

1. **全支付宝**：不按语言、地区或浏览器保留 Paddle 分支。
2. **直接切换**：删除 Paddle 新单、查询、Webhook、前端 SDK、配置和对客文案；不保留历史 Paddle 通知兼容入口。
3. **权益语义不变**：支付层只负责产出可信的“哪个账号购买了多少个月”事实，现有权益计算继续负责交付。
4. **历史数据保留**：两条 Paddle entitlement 原样保留，但仅作为账本历史。
5. **Connect 自己收款**：支付宝实现落在 `workers/scout-connect`，不在运行时调用 Agent Mentor Worker。
6. **复用模式而非复制秘密**：参考 Agent Mentor 已验证的 Worker Web Crypto RSA2、异步通知、主动查询补偿和幂等路径；不读取、复制或提交其生产私钥。
7. **完整网页收款接口**：覆盖下单、交易查询、关闭交易、退款、退款查询和异步通知。
8. **退款入口不变**：用户继续通过支持邮箱申请，不新增公开的自助退款按钮；退款操作只开放给管理员。

## 3. 非目标

- 不改变 Mediary Connect 的登录、魔法链接、slug 选择、隧道开通、到期巡检或宽限期策略。
- 不改变三档价格、月数或年度主推档。
- 不把支付能力抽成跨产品平台，不让 Connect 依赖 Agent Mentor 的 Worker、KV 或队列。
- 不自动修改支付宝开放平台的签约、应用发布、域名或商家资料。
- 不在本次迁移中清理历史 Paddle 数据，也不顺带升级无关依赖。
- 不主动发起生产真实付款；真实付款必须由非商户本人支付宝完成。

## 4. 架构

```text
登录用户
  -> POST /api/alipay/checkout
       -> 服务端档位白名单解析金额/月数
       -> D1 创建绑定 account_id 的订单
       -> 返回同源 checkout hop URL
  -> GET /alipay/checkout?checkout=<随机能力标识>
       -> Worker 生成 RSA2 alipay.trade.page.pay 表单
       -> 浏览器自动 POST 到支付宝收银台
  -> 支付宝
       -> POST /api/alipay/notify（权威异步通知）
       -> GET /payment-success?order=<随机订单标识>（同步回跳）
  -> 通知或成功页主动查询
       -> 统一校验并标记付款
       -> grantEntitlement（现有权益交付）
       -> 控制台显示原有到期时间/开通入口
```

支付与权益的边界是一个最小合同：

```ts
type TrustedPaymentGrant = {
  accountId: string;
  months: 3 | 12 | 24;
  provider: "alipay";
  providerTransactionId: string;
  paidAt: string;
};
```

浏览器提交的价格、月数、账号邮箱、支付宝交易状态或同步回跳参数均不能构造该合同。只有验签通过的异步通知，或验签通过的 `alipay.trade.query` 响应可以构造它。

## 5. 订单和权益数据

### 5.1 `payment_orders`

新增支付订单表，建议字段如下：

| 字段 | 约束与用途 |
|---|---|
| `id` | 内部随机主键，不使用连续编号 |
| `checkout_token_sha256` | checkout hop 能力标识的哈希，原值只交给浏览器 |
| `account_id` | 创建订单时绑定当前登录账号 |
| `provider` | 固定 `alipay` |
| `out_trade_no` | 商户订单号，唯一 |
| `trade_no` | 支付宝交易号，付款后写入，可空且唯一 |
| `months` | 只允许 3、12、24 |
| `total_amount` | 固定两位小数字符串：`45.00`、`108.00`、`188.00` |
| `status` | `created`、`form_issued`、`pending`、`paid`、`fulfilled`、`closed`、`refunded` |
| `created_at` / `expires_at` | 订单创建时间和收银台有效期 |
| `paid_at` / `fulfilled_at` | 支付证据时间和权益交付时间 |
| `closed_at` / `refunded_at` | 关闭或全额退款时间 |
| `refund_request_no` | 商户退款请求号，可空且唯一 |

订单状态只能单向推进。重复通知、重复查询和重复退款查询必须收敛到同一状态，不能回退，也不能重复增加或扣减时长。

### 5.2 `entitlements`

将支付幂等键从 Paddle 专属命名改为渠道无关命名：

- 新增 `payment_provider` 和 `payment_transaction_id`；
- 将现有非空 `paddle_transaction_id` 回填为 `payment_provider='paddle'` 和同值 `payment_transaction_id`；
- 新支付宝权益写 `payment_provider='alipay'`、`payment_transaction_id=<out_trade_no>`；
- 手工权益保持交易字段为空；
- 对 `(payment_provider, payment_transaction_id)` 建部分唯一索引；
- 新增 `refunded_at`，未退款为 `NULL`。

旧 `paddle_transaction_id` 在迁移验证后不再被业务代码读取。是否物理删除旧列由 D1 安全迁移能力决定；即使保留为历史列，也不能继续出现在 checkout 业务合同中。

### 5.3 权益重算

现有语义保持：未到期续费从旧到期时间叠加，已过期从付款时间重启。为支持全额退款且不破坏并发安全，引入统一账本收敛函数：

1. 按 `created_at, id` 对 `refunded_at IS NULL` 的权益稳定排序；
2. 逐条使用现有 `computeExpiry` 计算每一步到期时间；
3. 把每条有效权益的派生 `expires_at` 更新为该步结果；
4. 所有读路径和 sweep SQL 忽略已退款权益；
5. `MAX(expires_at)` 因此仍等于当前真实到期时间。

需要覆盖退款第一笔、中间一笔、最后一笔，以及通知与查询并发入账。历史 Paddle 权益作为未退款的普通账本行参与同一计算。

## 6. 支付接口

### 6.1 下单

`POST /api/alipay/checkout`

- 必须有有效 session；从 session 取得 `account_id`，不接收客户端邮箱。
- 请求只提交档位标识；服务端白名单映射金额和月数。
- 创建 D1 订单和高熵 checkout capability。
- 返回同源 `/alipay/checkout?checkout=...`，不直接返回可篡改的支付宝参数。
- 支付配置缺失时返回 503；未知档位返回 400；所有响应 `no-store`。

`GET /alipay/checkout?checkout=...`

- 校验 capability、订单未过期且属于可支付状态。
- 使用 `alipay.trade.page.pay` 和 `FAST_INSTANT_TRADE_PAY`。
- 时间戳使用 `yyyy-MM-dd HH:mm:ss`，字符集 UTF-8，签名类型 RSA2。
- `notify_url=https://mediaryconnect.app/api/alipay/notify`。
- `return_url=https://mediaryconnect.app/payment-success?order=<随机订单标识>`。
- 返回只含一个支付宝表单的 HTML，并自动提交；不得把表单当普通 URL 跳转。
- 重复 GET 复用同一 `out_trade_no`，不能创建第二笔订单。

### 6.2 异步通知

`POST /api/alipay/notify`

- 对原始 URL-encoded 表单执行 RSA2 验签；要求 `sign_type=RSA2`。
- 校验 `app_id`、`out_trade_no`、`trade_no`、`total_amount` 和 `trade_status`；若实际通知包含可核验的 seller/PID 字段，也与配置一致性校验。
- 只接受 `TRADE_SUCCESS` / `TRADE_FINISHED` 作为付款证据。
- 订单不存在、金额不符、账号/应用不符或验签失败时拒绝入账。
- 入账与 `grantEntitlement` 以 `payment_transaction_id` 幂等；通知与查询竞态最多发放一次。
- 只有支付事实已安全接受并完成权益交付，或已确认同一订单早已完成时返回纯文本 `success`。
- 暂时性 D1/内部错误不返回 `success`，让支付宝重投。

### 6.3 主动查询与回跳补偿

`GET /api/alipay/orders/:id/status`

- 必须登录且订单 `account_id` 与 session 一致；否则返回 404，避免泄露订单存在性。
- 先读 D1；`fulfilled` 直接返回最小状态。
- 未完成时调用 `alipay.trade.query`，验证支付宝响应签名并校验订单号、金额和状态。
- 查询确认付款后走与通知相同的“标记付款并发权益”函数。
- 返回状态仅为 `pending`、`paid_unfulfilled`、`fulfilled`、`closed`、`expired`，不返回密钥、签名、完整支付宝响应或其他账号信息。
- 对同一订单的高频轮询做短 TTL 合并；`WAIT_BUYER_PAY` 不缓存为终态，避免阻断随后付款。

`GET /payment-success?order=...`

- 不信任支付宝同步回跳参数判定成功。
- 页面只使用随机订单标识和当前 session 查询上述状态端点。
- 通知延迟时显示“正在确认付款”，持续轮询；付款确认后进入原有控制台/开通流程。

### 6.4 关闭订单

实现 `alipay.trade.close`：

- 仅对本账号未付款且未过期订单开放内部关闭动作；
- 新建替代订单前可以关闭旧订单；
- 支付宝返回“已支付”时不强行标记关闭，转入主动查询；
- 重复关闭幂等。

### 6.5 退款与退款查询

管理员接口使用现有 `ADMIN_TOKEN` 门禁，不提供公开退款按钮：

- `POST /api/admin/alipay/refund` 调用 `alipay.trade.refund`；本次只支持对应订单的全额退款；
- `GET /api/admin/alipay/refund/:requestNo` 调用 `alipay.trade.fastpay.refund.query`；
- 退款响应和查询响应都要验签，并校验原订单号、退款请求号和金额；
- 全额退款确认后标记订单和对应 entitlement 为 refunded，运行统一账本收敛；
- 若剩余有效期已结束，立即走现有安全撤销路径停止远程入口；slug 和账号记录保留；
- 退款接口重试不能重复扣减权益。

14 天政策仍由支持人员判断；代码不根据客户端输入自动批准退款。超过 14 天的现行例外仍由管理员人工决定。

## 7. 密钥与安全边界

Connect Worker 新增以下 bindings：

| Binding | 用途 |
|---|---|
| `ALIPAY_APP_ID` | 当前生产应用 ID |
| `ALIPAY_PRIVATE_KEY` | 商户 RSA2 私钥，只用于请求签名 |
| `ALIPAY_ALIPAY_PUBLIC_KEY` | 支付宝平台公钥，只用于通知/响应验签 |
| `ALIPAY_SELLER_ID` | 可选；通知存在对应字段时做商户一致性校验 |

要求：

- 不进入 Git、普通日志、审计详情、HTML、客户端 JSON 或测试 fixture。
- Agent Mentor Worker 的 secret 只证明 binding 已配置；Cloudflare 不允许导出值。
- 生产密钥由用户重新写入 Connect Worker secret bindings。
- 测试使用运行时生成的测试 RSA 密钥对，不使用真实密钥。
- 配置缺失或密钥无法导入时 fail closed，checkout 返回 503，通知不入账。
- Worker 使用 Web Crypto，按当前 Cloudflare Worker 运行时验证导入方式；不为了支付引入 Node-only SDK。

## 8. 页面与合规文案

### 8.1 购买体验

- `/buy` 保留现有登录门槛、三档卡片、年度主推和价格。
- 所有按钮统一为支付宝支付，不按语言保留银行卡/Paddle。
- 下单后显示窄幅“正在打开支付宝 / 几秒后自动跳转，请稍候”过渡状态，再自动提交表单。
- 状态页覆盖：等待确认、付款已收到正在入账、权益已到账、订单关闭/过期、暂时无法查询。
- 支付完成后的核心结果仍是控制台里出现相同月份和相同开通入口。

### 8.2 删除 Paddle 痕迹

- 删除 Paddle.js、Paddle API 客户端、Paddle webhook/signature/event parser 和专属测试。
- 删除 `PADDLE_*` Env 字段、wrangler 配置、部署注释和 `/api/paddle/webhook`、Paddle transaction status 路由。
- 删除只为 Paddle 放行的 CSP 来源，增加严格的 `form-action https://openapi.alipay.com`；其他页面维持原有最小 CSP。
- 定价、条款、退款、联系、购买、成功页删除 Paddle、Merchant of Record、Paddle 收据、银行卡、Apple Pay、Google Pay 和“Paddle 内微信支付”等描述。
- 中英文都明确价格以人民币计，由支付宝处理；运营主体仍是 DF Digital。
- 重新运行内容生成脚本，使 Markdown 来源与生成的合规内容一致。

## 9. 错误与可恢复性

- **未配置**：下单 503，页面明确“结账暂未开放”，不回退 Paddle。
- **支付宝上游超时/5xx**：服务端请求设置 10 秒超时；查询可有限重试，下单不重复创建商户订单。
- **验签或业务校验失败**：拒绝入账，日志只记脱敏原因和内部订单 ID。
- **通知晚于回跳**：成功页主动查询补偿；同一函数完成入账。
- **查询先于通知**：查询成功可发权益；后到通知命中幂等记录。
- **付款已确认但权益写入失败**：订单保持 `paid`，通知返回非 success 或状态轮询继续补偿，直到 `fulfilled`。
- **用户关闭页面**：异步通知仍可完成权益发放；再次登录控制台即可看到。
- **订单关闭/过期**：用户创建新订单，旧订单不能复活或重复提交。
- **退款后重试**：退款请求号与 entitlement 状态共同保证只撤销一次。

## 10. 测试策略

严格按 TDD 推进，每个生产改动先有能正确失败的测试。

### 10.1 纯函数与协议

- 三档白名单金额/月数，拒绝任意价格和未知档位；
- RSA2 请求签名、通知验签、支付宝查询/退款响应验签；
- `sign_type`、时间戳格式、UTF-8、金额标准化；
- 页面支付表单 action 只能是 `https://openapi.alipay.com/gateway.do`；
- 表单字段 HTML 转义与 CSP；
- 支付状态映射和单向状态机。

### 10.2 路由与账本

- 未登录下单拒绝，订单强绑定 session account；
- checkout capability 不可猜、过期、串账号或复用创建第二订单；
- 通知坏签名、错 app、错订单、错金额、未付款状态全部不发权益；
- 合法通知按 3/12/24 月发放；
- 重复通知、查询重复、通知与查询并发只发一次；
- 回跳参数不能伪造成功；
- 付款已确认但首次权益写入失败后可恢复；
- 关闭未付款订单与已付款竞态；
- 全额退款、退款查询和重复退款；
- 退款第一/中间/最后一笔后权益重算正确；
- 历史 `source=paddle` 的两类数据库实现（D1 与 memory）仍参与有效期计算；
- 现有 slug、开通、到期和宽限期测试保持通过。

### 10.3 页面与内容

- `/buy` 三档价格字节级保持 ¥45/¥108/¥188；
- 所有购买分支只出现支付宝，不加载 Paddle.js；
- opening/pending/paid/fulfilled/closed/error 文案与 DOM；
- 合规 Markdown 和生成文件不再出现 Paddle/Merchant of Record/旧支付方式；
- 非支付页面 CSP 不被无关放宽。

## 11. 验证与发布

### 11.1 自动护栏

1. 支付相关定向 Vitest；
2. `npx vitest run`；
3. `npm run typecheck`；
4. `npx tsc -p workers/scout-connect/tsconfig.json`；
5. 若修改 `apps/web/**`，额外运行 `npx tsc -p apps/web/tsconfig.json` 和 `npm run build:web`；
6. 支付宝 Skill 的当前产品 checklist；
7. `rg` 验证活跃 checkout 代码和对客内容不存在 Paddle 残留，历史 spec/迁移数据除外。

### 11.2 沙箱

- 使用支付宝 Skill 生成并校验的项目级沙箱配置；
- 启动真实 Worker 本地服务，浏览器进入真实沙箱收银台；
- 验证回跳页壳、异步通知代码、主动查询和 D1/本地订单状态；
- 沙箱付款入口和两种体验方式交给用户，不能以 `curl` 返回表单冒充付款体验；
- 本地没有公网 HTTPS notify 时，将公网通知联调明确标记为待生产验证。

### 11.3 GitHub 与生产

1. 所有代码经 commit、push、PR；
2. 等 CI 通过；
3. 请求 Copilot 对当前 HEAD 评审，逐条核验 inline 和折叠意见；
4. 评审通过后合并；
5. 合并后通过 `workers/scout-connect/scripts/deploy.sh` 或项目既有 GitHub 发布路径部署，绝不直接修改线上源码；
6. 用户在 Connect Worker 重新写入支付宝生产 secrets；
7. 验证公开 HTTPS 的 notify、return 和查询端点；
8. 由非商户本人支付宝完成一笔真实付款，确认通知或查询入账、控制台权益、slug 开通和日志；
9. 验证管理员关闭/退款查询路径；如用真实订单验退款，先取得用户对该笔精确订单的明确授权。

生产真实付款完成前，只能宣称“代码与沙箱验证完成”，不能宣称“生产支付宝支付已验收”。

## 12. 完成标准

- 新订单没有任何 Paddle 路径，所有语言和档位只走支付宝。
- ¥45/¥108/¥188 与 3/12/24 月映射不变且仅由服务端决定。
- 通知和主动查询都能安全、幂等地交付现有权益。
- 同步回跳不能伪造成功，通知延迟不会让用户永久卡住。
- 下单、查询、关闭、退款、退款查询、异步通知全部实现并有测试。
- 历史 Paddle entitlement 保留并继续正确计算；生产没有删除数据。
- Paddle 运行时代码、配置、CSP 和对客文案全部移除。
- 自动测试、沙箱体验、PR/CI/Copilot 和生产人工门禁均有新鲜证据。

## 13. 已知人工门禁

以下事项不能由代码静态检查代替：

1. 用户把同一生产应用的 `ALIPAY_APP_ID`、商户私钥、支付宝公钥重新写入 Connect Worker secrets；
2. 若支付宝应用限制 return/notify 域名，用户在开放平台为 `mediaryconnect.app` 完成相应应用配置与发布；
3. 非商户本人支付宝完成真实付款；商户账号自付可能被风控拒绝；
4. 任何生产真实退款都需要对精确订单另行授权。
