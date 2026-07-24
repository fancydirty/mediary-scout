export function buildAgentPrompt(input: {
  hostname: string;
  tunnelToken: string;
}): string {
  return `你是在帮用户配置 Mediary Scout 的「Scout Connect」远程访问。

目标:让用户的自托管实例经 Cloudflare Tunnel 发布到:
  https://${input.hostname}
门禁是 Cloudflare Access 邮箱 OTP(用户浏览器打开时会要求邮箱验证码)。
不要修改获取/网盘/LLM 业务逻辑。

安全:
- TUNNEL_TOKEN 是机密,不要提交到 git,不要写进 README,不要出现在截图 issue 里。
- 只写入实例目录的 .env(该文件应已被 gitignore)。

步骤:
1. 进入用户的 mediary-scout 部署目录(常见 docker compose 项目根)。
2. 确保 .env 中有且仅有一行有效:
     TUNNEL_TOKEN=${input.tunnelToken}
   若已有旧 TUNNEL_TOKEN,先备份再替换。
3. 可选:若用户网络不稳定/UDP 受限,追加:
     TUNNEL_TRANSPORT_PROTOCOL=http2
4. 执行:
     docker compose --profile tunnel up -d
5. 查看日志直到出现 Registered tunnel connection 一类成功字样:
     docker compose logs -f cloudflared
6. 让用户在浏览器打开 https://${input.hostname}
   - 应先看到 Cloudflare Access 邮箱验证
   - 通过后进入 Mediary Scout UI
7. 若失败:检查 compose 服务名是否仍为 web、cloudflared 是否与 web 同网络、
   token 是否完整一行、防火墙是否拦截出站。

完成后用简短中文汇报:是否 up、Access 是否出现、打开面板是否成功。
`;
}
