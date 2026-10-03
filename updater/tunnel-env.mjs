const MANAGED = /^[\t ]*(export[\t ]+)?(TUNNEL_TOKEN|MEDIARY_CONNECT_HOSTNAME)[\t ]*=/;

export function rewriteEnvForTunnel(content, { token, hostname }) {
  const lines = content.length === 0 ? [] : content.replace(/\n$/, "").split("\n");
  const kept = lines.filter((line) => !MANAGED.test(line));
  return [...kept, `TUNNEL_TOKEN=${token}`, `MEDIARY_CONNECT_HOSTNAME=${hostname}`].join("\n") + "\n";
}
