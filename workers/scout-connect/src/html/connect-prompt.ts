// P6 接入提示词——控制台的主角。用户把它整段交给自己的 AI 助手
// (Claude Code / Codex / opencode),助手负责「智能的那部分」:找到部署
// Mediary Scout 的那台机器、SSH 过去、进部署目录,然后跑 connect.sh 那一条
// 命令(「确定性的那部分」由脚本负责——凭码换 token、原子写 .env、起隧道、
// 轮询验证)。
//
// 与旧的 buildAgentPrompt(agent-prompt.ts)本质不同:那版把 tunnel token
// 直接烤进 shell 脚本(邀请制、token 落库时代);现在 token 不落库,提示词里
// 只带「取件码」(claim code,15 分钟签名令牌),真正的 token 由 connect.sh
// 现场凭码向 worker 换取。提示词里绝不出现 token。
//
// 取件码走 curl 命令行(sh -s -- <code>);签名令牌本身是 [A-Za-z0-9_.-],
// hostname 来自 slug(DNS 字符集)。两者都按白名单校验后才拼进命令,
// 不信任、不转义硬插。

const SAFE_HOSTNAME = /^[a-zA-Z0-9.-]+$/;
// 取件码:signed-token 字符集(base64url + '.' 分隔)。控制台注入用的占位符
// __MEDIARY_CLAIM_CODE__ 也落在这个集合内,同一校验即可放行。
const SAFE_CLAIM_CODE = /^[A-Za-z0-9_.-]+$/;

/** 控制台客户端注入真实取件码用的占位符(见 console-page.ts)。 */
export const CLAIM_CODE_PLACEHOLDER = "__MEDIARY_CLAIM_CODE__";

export function buildConnectPrompt(input: {
  hostname: string;
  claimCode: string;
  baseUrl: string;
}): string {
  if (!SAFE_HOSTNAME.test(input.hostname)) {
    throw new Error("hostname contains characters that cannot be embedded");
  }
  if (!SAFE_CLAIM_CODE.test(input.claimCode)) {
    throw new Error("claimCode contains characters that cannot be embedded");
  }
  // baseUrl 只取 origin(协议+主机),杜绝把路径/查询拼进命令。
  let origin: string;
  try {
    origin = new URL(input.baseUrl).origin;
  } catch {
    throw new Error("baseUrl is not a valid URL");
  }
  const url = `${origin}/connect.sh`;
  return `你在帮我把自托管的 Mediary Scout 接入 Mediary Connect 远程访问。

# 拓扑:你现在多半在我的电脑上,而 Mediary Scout 部署在另一台机器
# (NAS / 小主机 / 软路由)。先搞清楚它在哪,不要在本机瞎跑。

1. 先问我:Mediary Scout 部署在哪台机器?怎么 SSH 过去?
   (不确定就问;连不上就停下来问我——绝不猜地址乱试。)
2. SSH 到那台机器,\`docker ps\` 找到 web 容器,
   \`docker inspect\` 拿到它的 compose 部署目录,\`cd\` 进去。
3. 在那个部署目录执行这一条(脚本会凭码换取隧道凭据、原子写入 .env、
   带 --profile tunnel 起 cloudflared、并轮询到隧道真通才报成功):
   curl -fsSL ${url} | sh -s -- ${input.claimCode}
4. 脚本轮询到 https://${input.hostname} 就绪才算成功;
   若失败,它会打印分级诊断,请把输出原样贴回给我,我们一起看。

安全红线:
- 取件码 15 分钟内有效,只用于换取隧道凭据;隧道 token 是机密,
  connect.sh 只把它写进那台机器的 .env,绝不打印、不提交 git、不贴日志。
- 全程只在部署目录里操作,不要碰任何 git 源码克隆(那是源码,不是部署)。

完成后用简短中文告诉我:隧道是否连通、https://${input.hostname} 能否打开
(首次打开会要求设置访问密码,这就是远程访问的门禁)。`;
}
