# 六盘余量接口实测（2026-10-27）

六个品牌全部探通，用生产凭证真打过。这份是 C2 的实现依据，不用再猜。

## 结果

| 盘 | 接口 | 总量 | 已用 | 剩余 |
|---|---|---|---|---|
| 115 | `GET https://webapi.115.com/user/space` | 40.01 TB | 18.94 TB | 21.07 TB |
| 夸克 | `GET https://drive-pc.quark.cn/1/clouddrive/member` | 10.00 GB | 1378.22 GB | **-1368 GB** |
| UC | `GET https://pc-api.uc.cn/1/clouddrive/member` | 6.00 TB | 615.43 GB | 5.40 TB |
| 光鸭 | `POST https://api.guangyapan.com/assets/v1/get_assets` | 500.00 TB | 710.55 GB | 499.31 TB |
| 123 | `GET https://yun.123pan.com/b/api/user/info` | 21.56 TB | 1.99 TB | 19.58 TB |
| 天翼 | `GET https://cloud.189.cn/api/open/user/getUserInfo.action` | 30.00 GB | 71.11 GB | **-41.11 GB** |

**两块盘已经超配额**（夸克、天翼）。这不是 bug，是真实状态：夸克的 SVIP 在 2026-07-18 到期后总额度降回 10 GB，文件还占着 1.38 TB；天翼个人云 30 GB 装了 71 GB。余量为负时必须原样告诉 agent，不能 clamp 到 0。

## 逐盘细节

### 115

```http
GET https://webapi.115.com/user/space
Cookie: <cookie>
Referer: https://115.com/
```

```json
{ "state": true, "data": {
  "all_total":  { "size": 43996571238400, "size_format": "40.01TB" },
  "all_remain": { "size": 23166891805517, "size_format": "21.07TB" },
  "all_use":    { "size": 20829679432883, "size_format": "18.94TB" }
}}
```

`/files` 和 `/user/info` **不带**空间字段（试过，都没有）。只有 `/user/space` 有。

### 夸克 / UC（同一套协议）

```http
GET https://drive-pc.quark.cn/1/clouddrive/member?pr=ucpro&fr=pc&uc_param_str=
GET https://pc-api.uc.cn/1/clouddrive/member?pr=UCBrowser&fr=pc&sys=darwin&ve=1.8.6
```

`data.total_capacity` / `data.use_capacity`。UC 的 query **不能**套夸克的 `pr=ucpro&fr=pc`（会 403 41027，已有记忆条目）。

- 夸克还有 `secret_total_capacity` / `secret_use_capacity`（"隐藏空间"），当前和生产值完全相同，用普通的那对即可。
- `extend_capacity_composition` 是空对象 `{}`，不要指望它给扩展容量。
- 夸克的 AVIP 过期后 `total_capacity` 降回 10 GB，但 `use_capacity` 不跟着降 —— 所以会算出负数。**这不是解析错误。**

### 光鸭

```http
POST https://api.guangyapan.com/assets/v1/get_assets
Authorization: Bearer <accessToken>
Did: <deviceId>
Content-Type: application/json

{}
```

```json
{ "code": 0, "msg": "success", "data": {
  "totalSpaceSize": 549755813888000,
  "usedSpaceSize": 762947115439,
  "vipStatus": 2, "svipStatus": 1,
  "vipExpireTime": 1793274670, "systemTime": 1793109894
}}
```

**怎么找到的**：`api.guangyapan.com` 是路径白名单网关，猜路径一律 `410 {"code":128,"msg":"路径不允许访问"}`。正确做法是从官网 JS 包里 grep —— `POST /assets/v1/get_assets` 在 `index.70c55385.js` 里，前端用它的 `usedSpaceSize` / `totalSpaceSize` 渲染侧栏空间条。

`accessToken` 会过期，先 POST `/v1/auth/token` 用 `client_id=aMe-8VSlkrbQXpUR` + `grant_type=refresh_token` 换新的（`guangya-client.ts` 已有这套）。

### 123

```http
GET https://yun.123pan.com/b/api/user/info
authorization: Bearer <token>
platform: web
app-version: 3
```

走 `signPath()` 签名（`pan123-client.ts:47` 已有）。

`data.SpacePermanent` / `data.SpaceUsed`，另有 `SpacePermanentTotal` / `SpaceTemp` / `SpaceTempExpr`（临时空间和到期时间）。

**坑**：裸 fetch 不带 `platform: web` + `app-version: 3` + 签名会返回 `code 8006 "当前的版本过低"`，看起来像接口不通，其实是请求头不对。

### 天翼

```http
GET https://cloud.189.cn/api/open/user/getUserInfo.action?sessionKey=<key>&noCach=<ts>
```

`capacity` / `available`。**`available` 可以是负数**（超配额）。

两个坑：

1. 路径是 `/api/open/...`，**不是** `/v2/...`。`/v2/getUserSizeInfo.action` 会被路由到 `/portal/v2/...` 返回 404。
2. **sessionKey 绑定 IPv4 出口**。`cookiesIp=125.71.94.132`，本地探会拿到 `InvalidSessionKey: check ip error`。必须强制 IPv4（`https.Agent({ family: 4 })`）并在生产网络的出口上跑。
3. 传 `familySessionKey` 打同一接口得到的是**同一份个人云数字**（家庭云容量不在这里）。要不要单独报家庭云，等做的时候再看——当前 tianyi 盘只写个人云。

## 实现约定

- `getSpace(): Promise<{ totalBytes: number; usedBytes: number } | null>`
- **允许负数剩余**：`totalBytes - usedBytes` 可能是负的，原样返回，不 clamp。
- **六个都必须实现**，没有"查不到返回 null"这一档。查询失败（网络/鉴权）返回 null 由缓存层沿用旧值。
- 缓存 TTL 30 分钟，写 `drive_space_cache`。
- 给 agent 的上下文里，超配额盘明确写「已超配额，不要再往里写」。

## 复现

探针在 `scratchpad/space-probe/`（已 gitignore）：`space-probe.mjs` 起手、`probe-final.mjs` 四盘汇总、`probe-123.mts` 123、天翼那支需要 `family:4` 并在生产出口跑。
