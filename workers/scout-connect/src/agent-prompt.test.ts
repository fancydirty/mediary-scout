import { describe, it, expect } from "vitest";
import {
  buildAgentPrompt,
  buildAgentPromptOrManual,
  canEmbedTunnelToken,
} from "./agent-prompt.js";

const INPUT = {
  hostname: "kiki-connect.example.com",
  tunnelToken: "eyJsecret-tunnel-token-value",
};

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("buildAgentPrompt", () => {
  it("contains the hostname in the goal, verification, and closing steps", () => {
    const out = buildAgentPrompt(INPUT);
    // goal (https://…), 第 5 步 verification, 第 6 步 closing — 3 occurrences
    expect(countOccurrences(out, INPUT.hostname)).toBe(3);
  });

  it("contains the tunnel token exactly once", () => {
    const out = buildAgentPrompt(INPUT);
    expect(countOccurrences(out, INPUT.tunnelToken)).toBe(1);
  });

  it("contains key fixed phrases", () => {
    const out = buildAgentPrompt(INPUT);
    expect(out).toContain("Scout Connect");
    expect(out).toContain("docker compose --profile tunnel up -d");
    expect(out).toContain("TUNNEL_TRANSPORT_PROTOCOL=http2");
    expect(out).toContain("Registered tunnel connection");
    expect(out).toContain("docker compose ls");
    expect(out).toContain("docker compose logs cloudflared --tail 30");
  });

  it("covers the audited failure modes", () => {
    const out = buildAgentPrompt(INPUT);
    // image-pull retry (OrbStack e2e finding)
    expect(out).toContain("docker compose --profile tunnel pull");
    // backup discipline: mandatory cp + verification that the backup exists
    expect(out).toContain('BACKUP_FILE=".env.bak-');
    expect(out).toContain('if ! cp .env "$BACKUP_FILE"');
    expect(out).toContain('if [ ! -f "$BACKUP_FILE" ]');
    // backup must not be a truncated file (disk-full still creates the dest)
    expect(out).toContain('"$(wc -c < .env)" != "$(wc -c < "$BACKUP_FILE")"');
    // atomic write: printf with a literal format string, never shell expansion
    expect(out).toContain("printf 'TUNNEL_TOKEN=%s\\n'");
    // permissions inherited via cp -p. Never parse stat: on GNU coreutils
    // `stat -f %Lp` prints filesystem info and exits 0, so the `|| stat -c %a`
    // fallback never runs and a 0600 .env silently becomes 0644.
    expect(out).toContain("if ! cp -p .env .env.new");
    // permissions are actually compared against the backup, not just printed
    expect(out).toContain('if [ "$ENV_MODE" != "$BAK_MODE" ]');
    // (the phrase appears in an explanatory comment; assert no assignment
    //  from stat and no chmod of the temp file, i.e. no executable use)
    expect(out).not.toContain("ORIG_PERMS=");
    expect(out).not.toContain("chmod \"$ORIG_PERMS\"");
    // grep exit code must be classified: 1 is legal (no non-token lines),
    // >=2 is an error. Without this, a failed grep leaves .env.new truncated
    // by '>' and mv silently wipes every other key out of .env.
    // one regex for filter/count/check; must cover the forms compose accepts
    // (leading space, spaces around =, export prefix), otherwise a stale
    // secret line survives and the line-count self-check miscounts
    expect(out).toContain(
      "TOKEN_RE='^[[:space:]]*(export[[:space:]]+)?TUNNEL_TOKEN[[:space:]]*='",
    );
    // (the strict form appears in an explanatory comment; assert it is not
    //  used as an actual grep argument anywhere)
    expect(out).not.toContain("grep -v '^TUNNEL_TOKEN='");
    expect(out).not.toContain("grep -cv '^TUNNEL_TOKEN='");
    expect(out).not.toContain("grep -q '^TUNNEL_TOKEN='");
    expect(out).toContain("GREP_RC=$?");
    expect(out).toContain('if [ "$GREP_RC" -ge 2 ]');
    // pre-replace self-check: kept-line count must match
    expect(out).toContain('if [ "$OLD_KEPT" != "$NEW_KEPT" ]');
    // rollback must use stop + rm -f + up -d (down can't target a service,
    // restart doesn't re-read .env) and pass the tunnel profile
    expect(out).toContain("docker compose --profile tunnel stop cloudflared");
    expect(out).toContain("docker compose --profile tunnel rm -f cloudflared");
    // rollback's own cp is verified too
    expect(out).toContain('if ! cp "$RESTORE_FROM" .env');
    // mv is checked; a read-only fs must not look like a successful write
    expect(out).toContain("if ! mv .env.new .env");
    // rollback re-verifies before claiming the service is back
    expect(out).toContain('if [ "$RB_REGISTERED" -ge 1 ]');
    // verification polls instead of a fixed sleep (avoids false negatives)
    expect(out).toContain("MAX_WAIT=60");
    // success requires the documented 4 connections, not just one
    expect(out).toContain('grep -c "Registered tunnel connection"');
    // logs must also pass the profile, and every recreate is forced
    expect(out).toContain("--profile tunnel logs cloudflared");
    expect(out).not.toContain("up -d cloudflared");
    expect(out).toContain('if [ "$REGISTERED" -ge 4 ]');
    // but only 0 connections triggers rollback — never roll back a working tunnel
    expect(out).toContain('if [ "$REGISTERED" -eq 0 ]');
    // the container must be recreated before verifying, otherwise up -d can
    // reuse the old container and its stale Registered lines pass a bad token
    expect(out).toContain("up -d --force-recreate cloudflared");
    // rollback restores this run's backup, not whatever ls -t happens to pick
    expect(out).toContain('RESTORE_FROM="$BACKUP_FILE"');
    expect(out).toContain('cp "$RESTORE_FROM" .env');
    // not "restart" (restart doesn't re-read .env)
    expect(out).toContain("restart 不会重读 .env");
    // Access verification is done by the human, not the agent
    expect(out).toContain("不要自行声称验证结果");
  });

  it("braces every shell var that precedes a non-ASCII char", () => {
    // `echo "rc $GREP_RC）"` makes the shell absorb the full-width paren's
    // bytes into the variable name, printing mojibake. The prompt is Chinese,
    // so bare $VAR before CJK punctuation is a live bug -- it corrupted both
    // the grep-failure error and the success message.
    const out = buildAgentPrompt(INPUT);
    // eslint-disable-next-line no-control-regex
    const bare = out.match(/\$[A-Za-z_][A-Za-z0-9_]*(?=[^\x00-\x7F])/g);
    expect(bare).toBeNull();
  });

  it("cannot be shell-injected via the token", () => {
    // Regression: the token used to be embedded as printf ... '<token>'.
    // A single quote closed the quoting and the remainder ran as a command.
    const evil = "AB@Cq3'; rm -rf /tmp/PWNED; echo '";
    const out = buildAgentPrompt({ hostname: "h.example.com", tunnelToken: evil });
    // never interpolated into a single-quoted argument
    expect(out).not.toContain(`'${evil}'`);
    // delivered through a quoted heredoc, so the body is fully literal
    expect(out).toContain("TOKEN_VALUE=$(cat <<'MEDIARY_TUNNEL_TOKEN_EOF'");
    expect(out).toContain('printf \'TUNNEL_TOKEN=%s\\n\' "$TOKEN_VALUE"');
    // the token still appears verbatim exactly once (inside the heredoc)
    expect(countOccurrences(out, evil)).toBe(1);
  });

  it("rejects input that could break out of the heredoc", () => {
    expect(() =>
      buildAgentPrompt({ hostname: "h.example.com", tunnelToken: "a\nb" }),
    ).toThrow(/cannot be embedded/);
    expect(() =>
      buildAgentPrompt({
        hostname: "h.example.com",
        tunnelToken: "x\nMEDIARY_TUNNEL_TOKEN_EOF\nrm -rf /",
      }),
    ).toThrow(/cannot be embedded/);
    expect(() =>
      buildAgentPrompt({ hostname: "h.example.com; rm -rf /", tunnelToken: "t" }),
    ).toThrow(/cannot be embedded/);
  });

  it("gives every backup a collision-proof name", () => {
    const out = buildAgentPrompt(INPUT);
    // same-second or concurrent runs must not overwrite an earlier backup
    expect(out).toContain('BACKUP_FILE=".env.bak-$(date +%Y%m%d-%H%M%S)-$$"');
    expect(out).toContain('while [ -e "$BACKUP_FILE" ]');
  });

  it("never blocks token delivery for an unusual token", () => {
    // A multi-line token can't produce a valid single-line .env entry, but
    // refusing to build anything would deny the user their token entirely.
    const multiline = "tok-line1\nline2";
    expect(canEmbedTunnelToken(multiline)).toBe(false);
    expect(() => buildAgentPrompt({ hostname: "h.example.com", tunnelToken: multiline })).toThrow();
    const manual = buildAgentPromptOrManual({
      hostname: "h.example.com",
      tunnelToken: multiline,
    });
    expect(manual).toContain("自动脚本无法安全生成");
    expect(manual).toContain("h.example.com");
    // the manual fallback must not leak the token into the instructions
    expect(manual).not.toContain(multiline);
    // and it must not hand the user a shell command to run by hand
    expect(manual).not.toContain("printf 'TUNNEL_TOKEN=");
  });

  it("accepts realistic cloudflared tokens", () => {
    // base64url payloads contain + / = and must not be rejected
    expect(canEmbedTunnelToken("eyJhIjoiMTY1YSIsInQiOiI5ZjcyIn0=+/")).toBe(true);
    expect(canEmbedTunnelToken("plain-token")).toBe(true);
  });

  it("is deterministic for the same input", () => {
    expect(buildAgentPrompt(INPUT)).toBe(buildAgentPrompt(INPUT));
  });
});
