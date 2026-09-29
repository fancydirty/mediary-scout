import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./run-update.sh", import.meta.url));
const FROM = "a".repeat(40);
const TAG_COMMIT = "b".repeat(40);
const FOREIGN = "f".repeat(40); // a commit the updater did not put there (someone else's)
const TAG = "v2026.10.02";

function writeExe(dir, name, body) {
  const path = join(dir, name);
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

/** One line per invocation: `name arg arg ...`. Shared by every stub via STUB_LOG. */
const LOG_FN = `
log_call() {
  printf '%s' "$1" >> "$STUB_LOG"
  shift
  for arg in "$@"; do
    printf ' %s' "$arg" >> "$STUB_LOG"
  done
  printf '\\n' >> "$STUB_LOG"
}
`;

function installStubs(bin) {
  writeExe(bin, "stat", `#!/bin/sh\n${LOG_FN}\nlog_call stat "$@"\nif [ "\${1-}" = "-c" ]; then printf '%s:%s\\n' "$(id -u)" "$(id -g)"; fi\n`);
  writeExe(bin, "hostname", `#!/bin/sh\n${LOG_FN}\nlog_call hostname "$@"\nprintf '%s\\n' updater-test\n`);
  // A fake clock: sleep moves it forward, `date +%s` reads it. Other date calls are real.
  writeExe(
    bin,
    "sleep",
    `#!/bin/sh\nt=0\nif [ -f "$STUB_DIR/clock" ]; then t=$(cat "$STUB_DIR/clock"); fi\nprintf '%s\\n' "$((t + \${1:-0}))" > "$STUB_DIR/clock"\n`,
  );
  writeExe(
    bin,
    "date",
    `#!/bin/sh\nif [ "\${1-}" = "+%s" ]; then t=0; if [ -f "$STUB_DIR/clock" ]; then t=$(cat "$STUB_DIR/clock"); fi; printf '%s\\n' "$((1000000 + t))"; exit 0; fi\nexec /bin/date "$@"\n`,
  );
  writeExe(bin, "chown", `#!/bin/sh\n${LOG_FN}\nlog_call chown "$@"\nexit 0\n`);
  // busybox timeout: SECS PROG ARGS. macOS has none, so stub it — drop the SECS and exec the
  // rest, or (hang-build) exit 124 as a timeout would, without running the build at all.
  // flock stub (macOS has none): with -n, fail when a manual deploy "holds" the lock
  // (marker file), else succeed. The script's `exec 9>>LOCK` is real fd redirection the
  // stub need not model; it only decides the exit code from the marker.
  writeExe(
    bin,
    "flock",
    `#!/bin/sh\n${LOG_FN}\nlog_call flock "$@"\ncase "$*" in *-n*) [ -f "$STUB_DIR/lock-held" ] && exit 1 ;; esac\nexit 0\n`,
  );
  writeExe(
    bin,
    "timeout",
    `#!/bin/sh\n${LOG_FN}\nlog_call timeout "$@"\nshift\nif [ -f "$STUB_DIR/hang-build" ]; then exit 124; fi\nexec "$@"\n`,
  );
  writeExe(
    bin,
    "su-exec",
    `#!/bin/sh\n${LOG_FN}\nlog_call su-exec "$@"\nshift\nexec "$@"\n`,
  );
  writeExe(
    bin,
    "wget",
    `#!/bin/sh
${LOG_FN}
case "$*" in
  *--post-data*)
    log_call hold "$@"
    if [ -f "$STUB_DIR/fail-hold" ]; then exit 1; fi
    if [ -f "$STUB_DIR/odd-hold" ]; then printf '%s\\n' '<html>login</html>'; exit 0; fi
    hn=0
    if [ -f "$STUB_DIR/hold-n" ]; then hn=$(cat "$STUB_DIR/hold-n"); fi
    hn=$((hn + 1))
    printf '%s\\n' "$hn" > "$STUB_DIR/hold-n"
    if [ -f "$STUB_DIR/fail-hold-after" ] && [ "$hn" -gt "$(cat "$STUB_DIR/fail-hold-after")" ]; then exit 1; fi
    case "$*" in
      *'{"hold":true}'*) printf '%s\\n' '{"hold":true}' ;;
      *) printf '%s\\n' '{"hold":false}' ;;
    esac
    exit 0
    ;;
esac
log_call wget "$@"
# A person changing the deploy folder during the wait: on each busy poll, move HEAD to the
# commit in move-head (one the updater did not put there).
if [ -f "$STUB_DIR/move-head" ]; then cat "$STUB_DIR/move-head" > "$STUB_DIR/head"; fi
if [ -f "$STUB_DIR/move-branch" ]; then : > "$STUB_DIR/on-branch"; fi
n=0
if [ -f "$STUB_DIR/wget-n" ]; then n=$(cat "$STUB_DIR/wget-n"); fi
n=$((n + 1))
printf '%s\\n' "$n" > "$STUB_DIR/wget-n"
if [ -f "$STUB_DIR/wget-lines" ]; then
  line=$(sed -n "\${n}p" "$STUB_DIR/wget-lines" || true)
  if [ -z "$line" ]; then line=$(tail -n 1 "$STUB_DIR/wget-lines" || true); fi
else
  line='{"busy":false}'
fi
if [ "$line" = FAIL ]; then exit 1; fi
if [ "$line" = SLOW ]; then
  t=0; if [ -f "$STUB_DIR/clock" ]; then t=$(cat "$STUB_DIR/clock"); fi
  printf '%s\\n' "$((t + 10))" > "$STUB_DIR/clock"
  exit 1
fi
printf '%s\\n' "$line"
`,
  );
  writeExe(
    bin,
    "git",
    `#!/bin/sh
${LOG_FN}
log_call git "$@"
cmd=""
for arg in "$@"; do
  case "$arg" in
    status|rev-parse|fetch|checkout|symbolic-ref) cmd="$arg" ;;
  esac
done
case "$cmd" in
  status)
    if [ -f "$STUB_DIR/status-out" ]; then cat "$STUB_DIR/status-out"; fi
    ;;
  rev-parse)
    case "$*" in
      *refs/tags/*)
        # rev-parse -q --verify refs/tags/X^{commit}: the tag's commit, or a failure when
        # the tag is missing (fetch did not bring it).
        if [ -f "$STUB_DIR/missing-tag" ]; then exit 1; fi
        printf '%s\\n' "$GIT_TAG_COMMIT"
        ;;
      *)
        # HEAD that git cannot read (a transient index/lock problem).
        if [ -f "$STUB_DIR/unreadable-head" ]; then exit 128; fi
        cat "$STUB_DIR/head"
        ;;
    esac
    ;;
  fetch)
    if [ -f "$STUB_DIR/fail-fetch" ]; then exit 1; fi
    ;;
  symbolic-ref)
    # On a branch only when a test put it there (a person ran deploy.sh, which checks out main).
    if [ -f "$STUB_DIR/on-branch" ]; then printf '%s\\n' refs/heads/main; exit 0; fi
    exit 1
    ;;
  checkout)
    # Checking out a tag or a commit id leaves HEAD detached, as real git does.
    rm -f "$STUB_DIR/on-branch"
    ref=""
    for arg in "$@"; do ref="$arg"; done
    case "$ref" in
      refs/tags/*)
        printf '%s\\n' "$GIT_TAG_COMMIT" > "$STUB_DIR/head"
        # A checkout that dies partway: the tree has moved, git still fails.
        if [ -f "$STUB_DIR/fail-tag-checkout" ]; then exit 1; fi
        ;;
      *)
        if [ -f "$STUB_DIR/fail-checkout-from" ]; then exit 1; fi
        printf '%s\\n' "$ref" > "$STUB_DIR/head"
        ;;
    esac
    ;;
  *)
    echo "unexpected git: $*" >&2
    exit 99
    ;;
esac
`,
  );
  writeExe(
    bin,
    "docker",
    `#!/bin/sh
${LOG_FN}
log_call docker "$@"
if [ "\${1-}" = "inspect" ]; then
  printf '%s\\n' mediary
  exit 0
fi
args="$*"
if printf '%s' "$args" | grep -q pg_dump; then
  if [ -f "$STUB_DIR/fail-pg-dump" ]; then exit 1; fi
  printf '%s\\n' DUMP
  exit 0
fi
if printf '%s' "$args" | grep -q 'build web'; then
  printf '%s\\n' "\${GIT_SHA-}" >> "$STUB_DIR/git-shas"
  if [ -f "$STUB_DIR/branch-during-build" ]; then : > "$STUB_DIR/on-branch"; fi
  if [ -f "$STUB_DIR/unreadable-during-build" ]; then : > "$STUB_DIR/unreadable-head"; fi
  if [ -f "$STUB_DIR/busy-after-build" ]; then printf '%s\n' '{"busy":true}' '{"busy":false}' >> "$STUB_DIR/wget-lines"; fi
  if [ -f "$STUB_DIR/head-during-build" ]; then cat "$STUB_DIR/head-during-build" > "$STUB_DIR/head"; fi
  if [ -f "$STUB_DIR/fail-build" ]; then exit 1; fi
  exit 0
fi
if printf '%s' "$args" | grep -q ' up '; then
  n=0
  if [ -f "$STUB_DIR/up-n" ]; then n=$(cat "$STUB_DIR/up-n"); fi
  n=$((n + 1))
  printf '%s\\n' "$n" > "$STUB_DIR/up-n"
  if [ -f "$STUB_DIR/fail-first-up" ] && [ "$n" = 1 ]; then exit 1; fi
  exit 0
fi
if printf '%s' "$args" | grep -q 'BUILD_COMMIT'; then
  last=""
  if [ -f "$STUB_DIR/git-shas" ]; then last=$(tail -n 1 "$STUB_DIR/git-shas"); fi
  if [ -f "$STUB_DIR/never-report" ]; then
    printf '%s\\n' mismatch
    exit 0
  fi
  if [ -f "$STUB_DIR/hide-shas" ] && grep -qx "$last" "$STUB_DIR/hide-shas"; then
    printf '%s\\n' mismatch
    exit 0
  fi
  printf '%s\\n' "$last"
  exit 0
fi
if printf '%s' "$args" | grep -q 'node -e'; then
  exit 0
fi
echo "unexpected docker: $*" >&2
exit 99
`,
  );
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "run-update-"));
  const repo = join(root, "repo");
  const state = join(root, "state");
  const bin = join(root, "bin");
  const stubDir = join(root, "stub");
  mkdirSync(repo);
  mkdirSync(state);
  mkdirSync(bin);
  mkdirSync(stubDir);
  const log = join(root, "calls.log");
  writeFileSync(log, "");
  writeFileSync(join(stubDir, "head"), `${FROM}\n`);
  writeFileSync(join(state, "token"), "t0k3n\n");
  installStubs(bin);
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    UPDATER_REPO_DIR: repo,
    UPDATER_STATE_DIR: state,
    UPDATER_WEB_BASE: "http://web.test:3000",
    STUB_DIR: stubDir,
    STUB_LOG: log,
    GIT_TAG_COMMIT: TAG_COMMIT,
  };
  return { repo, stubDir, log, env };
}

function run(env, tag = TAG) {
  return runArgs(env, [tag]);
}

function runArgs(env, args) {
  return new Promise((resolve) => {
    const child = spawn("sh", [SCRIPT, ...args], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function linesOf(log) {
  return readFileSync(log, "utf8").split("\n").filter(Boolean);
}

/** docker / git / wget calls, in order, reduced to the step the script meant. */
function signatures(log) {
  return linesOf(log)
    .filter((line) => /^(docker|git|wget|hold) /.test(line))
    .map((line) => {
      if (line.startsWith("hold ")) return line.includes('{"hold":true}') ? "hold" : "release";
      if (line.startsWith("wget ")) return "wget";
      if (line.includes("pg_dump")) return "pg_dump";
      if (line.includes("build web")) return "build";
      if (line.includes(" up ")) return "up";
      if (line.includes("BUILD_COMMIT")) return "cat_commit";
      if (line.includes("node -e") || line.includes(" node ")) return "health";
      if (line.startsWith("docker ") && line.includes(" inspect ")) return "inspect";
      if (line.startsWith("git ") && line.includes(" status ")) return "status";
      if (line.startsWith("git ") && line.includes(" rev-parse ")) return "rev-parse";
      if (line.startsWith("git ") && line.includes(" symbolic-ref ")) return "symbolic-ref";
      if (line.startsWith("git ") && line.includes(" fetch ")) return "fetch";
      if (line.startsWith("git ") && line.includes(" checkout ")) return `checkout ${line.trim().split(" ").at(-1)}`;
      return line;
    });
}

function gitShas(stubDir) {
  return readFileSync(join(stubDir, "git-shas"), "utf8").trim().split("\n");
}

describe("run-update.sh", { timeout: 60_000 }, () => {
  it("updates, backing up before the build and swapping only web", async () => {
    const { repo, stubDir, log, env } = setup();
    const result = await run(env);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(signatures(log)).toEqual([
      "status",
      "inspect",
      "rev-parse",
      "pg_dump",
      "fetch",
      "rev-parse",
      `checkout refs/tags/${TAG}`,
      "rev-parse",
      "build",
      "hold",
      "hold",
      "wget",
      "rev-parse",
      "symbolic-ref",
      "up",
      "cat_commit",
      "health",
    ]);
    const hold = linesOf(log).find((line) => line.startsWith("hold "));
    expect(hold).toContain("http://web.test:3000/api/update/hold");
    expect(hold).toContain("Bearer t0k3n");
    // busybox wget waits forever without a timeout.
    for (const line of linesOf(log).filter((entry) => /^(wget|hold) /.test(entry))) {
      expect(line).toMatch(/ -T 10 /);
    }
    const dockerLines = linesOf(log).filter((line) => line.startsWith("docker "));
    const dumpAt = dockerLines.findIndex((line) => line.includes("pg_dump"));
    const buildAt = dockerLines.findIndex((line) => line.includes("build web"));
    expect(dumpAt).toBeGreaterThanOrEqual(0);
    expect(buildAt).toBeGreaterThan(dumpAt);
    const ups = dockerLines.filter((line) => line.includes(" up "));
    expect(ups).toHaveLength(1);
    expect(ups[0]).toMatch(/up -d --no-deps web$/);
    expect(ups[0]).toContain(`--project-directory ${repo}`);
    const wget = linesOf(log).find((line) => line.startsWith("wget "));
    expect(wget).toContain("http://web.test:3000/api/update/busy");
    expect(wget).toContain("Bearer t0k3n");
    expect(gitShas(stubDir)).toEqual([TAG_COMMIT]);
    const backups = readdirSync(join(repo, "backups"));
    const gz = backups.filter((name) => name.endsWith(".sql.gz"));
    expect(gz).toEqual([expect.stringMatching(/^pre-update-\d{8}-\d{6}\.sql\.gz$/)]);
    expect(backups.some((name) => name.endsWith(".tmp"))).toBe(false);
    expect(result.stdout).toContain(`==> DONE ${TAG}`);
  });

  it("stops before docker or checkout when tracked files are edited", async () => {
    const { stubDir, log, env } = setup();
    writeFileSync(join(stubDir, "status-out"), " M docker-compose.yml\n");
    const result = await run(env);
    expect(result.code).toBe(30);
    expect(result.stdout).toContain("==> LOCAL_CHANGES");
    expect(linesOf(log).some((line) => line.startsWith("docker "))).toBe(false);
    expect(linesOf(log).some((line) => line.includes(" checkout"))).toBe(false);
    expect(signatures(log).every((step) => step === "status")).toBe(true);
  });

  it("checks the previous commit back out when the build fails, and does not swap", async () => {
    const { stubDir, log, env } = setup();
    writeFileSync(join(stubDir, "fail-build"), "1");
    const result = await run(env);
    expect(result.code).toBe(10);
    expect(result.stdout).toContain("==> BUILD_FAILED");
    expect(signatures(log)).toEqual([
      "status",
      "inspect",
      "rev-parse",
      "pg_dump",
      "fetch",
      "rev-parse",
      `checkout refs/tags/${TAG}`,
      "rev-parse",
      "build",
      "rev-parse",
      "symbolic-ref",
      `checkout ${FROM}`,
    ]);
    expect(gitShas(stubDir)).toEqual([TAG_COMMIT]);
  });

  it("rolls back when the new container never reports the target commit", async () => {
    const { stubDir, log, env } = setup();
    writeFileSync(join(stubDir, "hide-shas"), `${TAG_COMMIT}\n`);
    const result = await run(env);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(10);
    expect(result.stdout).toContain("==> ROLLED_BACK");
    expect(result.stdout).not.toContain("ROLLBACK_FAILED");
    const steps = signatures(log);
    expect(steps.filter((step) => step === "cat_commit")).toHaveLength(91);
    expect(steps.filter((step) => step === "build")).toHaveLength(2);
    expect(steps.filter((step) => step === "up")).toHaveLength(2);
    for (const line of linesOf(log).filter((entry) => entry.includes(" up "))) {
      expect(line).toMatch(/up -d --no-deps web$/);
    }
    expect(gitShas(stubDir)).toEqual([TAG_COMMIT, FROM]);
    expect(steps.filter((step) => step.startsWith("checkout "))).toEqual([
      `checkout refs/tags/${TAG}`,
      `checkout ${FROM}`,
    ]);
  });

  it("exits 20 when the rollback never verifies either", async () => {
    const { stubDir, log, env } = setup();
    writeFileSync(join(stubDir, "never-report"), "1");
    const result = await run(env);
    expect(result.code).toBe(20);
    expect(result.stdout).toContain("==> ROLLBACK_FAILED");
    expect(result.stdout).not.toContain("==> ROLLED_BACK");
    const steps = signatures(log);
    expect(steps.filter((step) => step === "cat_commit")).toHaveLength(180);
    expect(steps.filter((step) => step === "health")).toHaveLength(0);
    expect(steps.filter((step) => step === "build")).toHaveLength(2);
    expect(gitShas(stubDir)).toEqual([TAG_COMMIT, FROM]);
    expect(steps).toContain(`checkout ${FROM}`);
  });

  it("accepts only real release tags, the same rule as the web", async () => {
    const accepted = ["v2026.10.02", "v2026.10.02.2", "v2026.10.02.12", "v2028.02.29", "v2000.02.29", "v2026.12.31", "v2099.12.31"];
    const rejected = [
      "main",
      "v2026.10.02;rm -rf /",
      "v2026.10.02.2foo",
      "v2026.10.02.1",
      "v2026.10.02.01",
      "v2026.02.29",
      "v2026.02.30",
      "v2026.04.31",
      "v2026.13.01",
      "v2026.00.10",
      "v1900.02.29",
      "v0000.02.29",
      "v0008.02.29",
      "v1999.12.31",
      "v2100.01.01",
      "v2026.10.02 ",
      "v2026.10.02\nx",
      "",
    ];
    for (const tag of accepted) {
      const { env } = setup();
      const result = await run(env, tag);
      expect({ tag, code: result.code }).toEqual({ tag, code: 0 });
    }
    for (const tag of rejected) {
      const { log, env } = setup();
      const result = await run(env, tag);
      expect({ tag, code: result.code }).toEqual({ tag, code: 2 });
      expect(linesOf(log)).toEqual([]);
    }
  });

  it("rejects a non-release tag before calling anything", async () => {
    for (const tag of ["main", "v2026.10.02;rm -rf /"]) {
      const { log, env } = setup();
      const result = await run(env, tag);
      expect(result.code).not.toBe(0);
      expect(linesOf(log)).toEqual([]);
      expect(result.stdout).toContain("not a release tag");
    }
  });

  it("prints one waiting step, then switches once the busy probe goes idle", async () => {
    const { stubDir, log, env } = setup();
    writeFileSync(join(stubDir, "wget-lines"), '{"busy":true}\n{"busy":true}\n{"busy":false}\n');
    const result = await run(env);
    expect(result.code).toBe(0);
    expect(result.stdout.split("\n").filter((line) => line === "==> STEP waiting")).toHaveLength(1);
    expect(result.stdout.indexOf("==> STEP waiting")).toBeLessThan(result.stdout.indexOf("==> STEP switching"));
    expect(signatures(log).filter((step) => step === "wget")).toHaveLength(3);
  });

  it("keeps waiting while the probe fails or answers something unexpected", async () => {
    const { stubDir, log, env } = setup();
    writeFileSync(
      join(stubDir, "wget-lines"),
      'FAIL\n<html>{"busy":false}</html>\n{"busy":false}garbage\n{"busy":true}\n{"busy":false}\n',
    );
    const result = await run(env);
    expect(result.code).toBe(0);
    const checks = result.stdout.split("\n").filter((line) => line.startsWith("==> BUSY_CHECK"));
    expect(checks).toEqual(["==> BUSY_CHECK unreachable", "==> BUSY_CHECK unexpected", "==> BUSY_CHECK busy"]);
    expect(signatures(log).filter((step) => step === "wget")).toHaveLength(5);
    expect(result.stdout.indexOf("==> BUSY_CHECK busy")).toBeLessThan(result.stdout.indexOf("==> STEP switching"));
  });

  it("switches after the wait limit when the probe never works, and says why", async () => {
    const { stubDir, log, env } = setup();
    writeFileSync(join(stubDir, "wget-lines"), "FAIL\n");
    const result = await run(env);
    expect(result.code).toBe(0);
    // 30 minutes of 30-second waits, measured on the clock.
    expect(signatures(log).filter((step) => step === "wget")).toHaveLength(60);
    expect(result.stdout).toContain("==> STILL_BUSY (unreachable)");
  });

  it("stops without swapping when it cannot take the hold, and checks the old commit back out", async () => {
    for (const how of ["fail", "odd"]) {
      const { stubDir, log, env } = setup();
      writeFileSync(join(stubDir, how === "fail" ? "fail-hold" : "odd-hold"), "1");
      const result = await run(env);
      expect(result.code).toBe(40);
      expect(result.stdout).toContain("==> HOLD_FAILED");
      const steps = signatures(log);
      expect(steps).not.toContain("up");
      expect(steps).not.toContain("wget");
      expect(steps.at(-1)).toBe(`checkout ${FROM}`);
      expect(steps).not.toContain("release");
    }
  });

  it("never takes the hold when the build fails", async () => {
    const { stubDir, log, env } = setup();
    writeFileSync(join(stubDir, "fail-build"), "1");
    await run(env);
    expect(signatures(log).some((step) => step === "hold" || step === "release")).toBe(false);
  });

  it("on an unexpected failure before the swap, releases the hold and checks the old commit back out", async () => {
    const { stubDir, log, env } = setup();
    // An error while waiting after the hold: `sleep` fails, and set -e ends the script.
    writeFileSync(join(stubDir, "wget-lines"), '{"busy":true}\n');
    writeExe(join(stubDir, "..", "bin"), "sleep", "#!/bin/sh\nexit 1\n");
    const result = await run(env);
    expect(result.code).not.toBe(0);
    const steps = signatures(log);
    expect(steps).toContain("hold");
    expect(steps).not.toContain("up");
    // Releases the hold, then checks the old commit back out (a HEAD read sits between them).
    expect(steps.at(-1)).toBe(`checkout ${FROM}`);
    expect(steps).toContain("release");
    expect(steps.indexOf("release")).toBeLessThan(steps.lastIndexOf(`checkout ${FROM}`));
    expect(readFileSync(join(stubDir, "head"), "utf8").trim()).toBe(FROM);
  });

  it("checks the old commit back out when the tag checkout itself fails partway", async () => {
    const { stubDir, log, env } = setup();
    writeFileSync(join(stubDir, "fail-tag-checkout"), "1");
    const result = await run(env);
    expect(result.code).not.toBe(0);
    expect(signatures(log).at(-1)).toBe(`checkout ${FROM}`);
    expect(readFileSync(join(stubDir, "head"), "utf8").trim()).toBe(FROM);
  });

  it("rollback pauses the new version and waits for its running tasks before swapping back", async () => {
    const { stubDir, log, env } = setup();
    writeFileSync(join(stubDir, "hide-shas"), `${TAG_COMMIT}\n`);
    // First probe (before the swap): idle. After the swap the new version is busy once.
    writeFileSync(join(stubDir, "wget-lines"), '{"busy":false}\n{"busy":true}\n{"busy":false}\n');
    const result = await run(env);
    expect(result.code).toBe(10);
    const steps = signatures(log);
    const ups = steps.map((step, index) => [step, index]).filter(([step]) => step === "up").map(([, index]) => index);
    expect(ups).toHaveLength(2);
    // Between the first swap and the rollback swap: a hold is taken, then the rollback
    // waits (two probes: busy, then idle), refreshing the hold on each; after the build it
    // pauses again and checks once more (idle) right before swapping.
    const between = steps.slice(ups[0] + 1, ups[1]);
    expect(between.indexOf("hold")).toBeGreaterThanOrEqual(0);
    expect(between.filter((step) => step === "wget")).toHaveLength(3);
    expect(between.filter((step) => step === "hold")).toHaveLength(5);
    expect(between.indexOf("hold")).toBeLessThan(between.indexOf("wget"));
  });

  it("prints no waiting step once the swap has begun, in a rollback after a failed check or a resumed one", async () => {
    // Update mode: the swap happens, the check fails, the rollback waits on a busy new version.
    {
      const { stubDir, env } = setup();
      writeFileSync(join(stubDir, "hide-shas"), `${TAG_COMMIT}\n`);
      writeFileSync(join(stubDir, "wget-lines"), '{"busy":false}\n{"busy":true}\n{"busy":false}\n');
      const result = await run(env);
      expect(result.code).toBe(10);
      const afterSwap = result.stdout.slice(result.stdout.indexOf("==> STEP switching"));
      expect(afterSwap).toContain("==> BUSY_CHECK busy");
      expect(afterSwap).not.toContain("==> STEP waiting");
    }
    // A rollback resumed after an updater restart.
    {
      const { stubDir, env } = setup();
      writeFileSync(join(stubDir, "head"), `${TAG_COMMIT}\n`);
      writeFileSync(join(stubDir, "wget-lines"), '{"busy":true}\n{"busy":false}\n');
      const result = await runArgs(env, ["rollback", FROM, TAG_COMMIT]);
      expect(result.code).toBe(10);
      expect(result.stdout).toContain("==> BUSY_CHECK busy");
      expect(result.stdout).not.toContain("==> STEP waiting");
    }
  });

  it("in a rollback, stops waiting on a new version that fails to answer twice in a row", async () => {
    for (const answer of ["FAIL", "<html>500</html>"]) {
      const { stubDir, log, env } = setup();
      writeFileSync(join(stubDir, "head"), `${TAG_COMMIT}\n`);
      writeFileSync(join(stubDir, "wget-lines"), `${answer}\n`);
      const result = await runArgs(env, ["rollback", FROM, TAG_COMMIT]);
      expect({ answer, code: result.code }).toEqual({ answer, code: 10 });
      expect(signatures(log).filter((step) => step === "wget")).toHaveLength(2);
      // One 30-second sleep between the two probes, not the 30-minute limit.
      const clock = Number(readFileSync(join(stubDir, "clock"), "utf8"));
      expect(clock).toBeGreaterThanOrEqual(30);
      expect(clock).toBeLessThan(60);
      expect(result.stdout).toContain("==> BUSY_CHECK the new version does not answer");
      expect(result.stdout).toContain("==> ROLLED_BACK");
    }
  });

  it("in a rollback, an explicit busy answer keeps waiting and restarts the count of failures", async () => {
    const { stubDir, log, env } = setup();
    writeFileSync(join(stubDir, "head"), `${TAG_COMMIT}\n`);
    writeFileSync(join(stubDir, "wget-lines"), 'FAIL\n{"busy":true}\nFAIL\n{"busy":true}\n{"busy":true}\n{"busy":false}\n');
    const result = await runArgs(env, ["rollback", FROM, TAG_COMMIT]);
    expect(result.code).toBe(10);
    // Six probes before the build, one more (idle) when it pauses again after the build.
    expect(signatures(log).filter((step) => step === "wget")).toHaveLength(7);
    expect(result.stdout).not.toContain("does not answer");
  });

  it("after the swap in update mode, a new version that cannot answer does not hold the rollback up either", async () => {
    const { stubDir, log, env } = setup();
    // The first probe (before the swap) says idle; every later one fails.
    writeFileSync(join(stubDir, "wget-lines"), '{"busy":false}\nFAIL\n');
    writeFileSync(join(stubDir, "fail-first-up"), "1");
    const result = await run(env);
    expect(result.code).toBe(10);
    expect(signatures(log).filter((step) => step === "wget")).toHaveLength(3);
    expect(result.stdout).toContain("==> BUSY_CHECK the new version does not answer");
    expect(result.stdout).toContain("==> ROLLED_BACK");
  });

  it("rolls back when `up` itself fails instead of exiting through set -e", async () => {
    const { stubDir, log, env } = setup();
    writeFileSync(join(stubDir, "fail-first-up"), "1");
    const result = await run(env);
    expect(result.code).toBe(10);
    expect(result.stdout).toContain("==> UP_FAILED");
    expect(result.stdout).toContain("==> ROLLED_BACK");
    expect(signatures(log).filter((step) => step === "up")).toHaveLength(2);
    expect(gitShas(stubDir)).toEqual([TAG_COMMIT, FROM]);
    // The swap was attempted, so the old process and its hold may be gone: no release.
    expect(signatures(log)).not.toContain("release");
  });

  it("rollback mode rebuilds and swaps back to the given commit, without a backup or a tag", async () => {
    const { stubDir, log, env } = setup();
    writeFileSync(join(stubDir, "head"), `${TAG_COMMIT}\n`);
    const result = await runArgs(env, ["rollback", FROM, TAG_COMMIT]);
    expect(result.code).toBe(10);
    expect(result.stdout).toContain("==> RESUMED_ROLLBACK");
    expect(result.stdout).toContain("==> ROLLED_BACK");
    expect(signatures(log)).toEqual([
      "inspect",
      "rev-parse",
      "symbolic-ref",
      `checkout ${FROM}`,
      "hold",
      "hold",
      "wget",
      "build",
      "hold",
      "hold",
      "wget",
      "up",
      "cat_commit",
      "health",
    ]);
    expect(gitShas(stubDir)).toEqual([FROM]);
  });

  it("restore mode checks the old commit out and releases the hold", async () => {
    const { stubDir, log, env } = setup();
    writeFileSync(join(stubDir, "head"), `${TAG_COMMIT}\n`);
    const result = await runArgs(env, ["restore", FROM, TAG_COMMIT]);
    expect(result.code).toBe(0);
    expect(signatures(log)).toEqual(["inspect", "rev-parse", "rev-parse", "symbolic-ref", `checkout ${FROM}`, "release"]);
  });

  it("restore leaves a folder someone else changed alone, exiting 60 without checking out", async () => {
    const { stubDir, log, env } = setup();
    writeFileSync(join(stubDir, "head"), `${FOREIGN}\n`);
    const result = await runArgs(env, ["restore", FROM, TAG_COMMIT]);
    expect(result.code).toBe(60);
    expect(result.stdout).toContain("==> FOLDER_CHANGED");
    expect(signatures(log).some((step) => step.startsWith("checkout"))).toBe(false);
    expect(signatures(log)).toContain("release");
    expect(readFileSync(join(stubDir, "head"), "utf8").trim()).toBe(FOREIGN);
  });

  it("restore leaves a folder a person put on a branch alone, even at the new commit or before it was known", async () => {
    // deploy.sh checks out main; a release tag usually points at main's HEAD, so the commit
    // alone cannot tell the updater's detached checkout from a person's deploy.
    for (const args of [["restore", FROM, TAG_COMMIT], ["restore", FROM]]) {
      const { stubDir, log, env } = setup();
      writeFileSync(join(stubDir, "head"), `${TAG_COMMIT}\n`);
      writeFileSync(join(stubDir, "on-branch"), "");
      const result = await runArgs(env, args);
      expect({ args, code: result.code }).toEqual({ args, code: 60 });
      expect(result.stdout).toContain("==> FOLDER_CHANGED");
      expect(signatures(log).some((step) => step.startsWith("checkout"))).toBe(false);
      expect(signatures(log)).toContain("release");
    }
  });

  it("rollback leaves a folder a person put on a branch alone, exiting 60 without building", async () => {
    const { stubDir, log, env } = setup();
    writeFileSync(join(stubDir, "head"), `${TAG_COMMIT}\n`);
    writeFileSync(join(stubDir, "on-branch"), "");
    const result = await runArgs(env, ["rollback", FROM, TAG_COMMIT]);
    expect(result.code).toBe(60);
    expect(result.stdout).toContain("==> FOLDER_CHANGED");
    expect(signatures(log)).not.toContain("build");
    expect(signatures(log)).toContain("release");
  });

  it("in update mode, does not swap when a person checks out a branch at the same commit during the wait", async () => {
    const { stubDir, log, env } = setup();
    writeFileSync(join(stubDir, "wget-lines"), '{"busy":true}\n{"busy":false}\n');
    writeFileSync(join(stubDir, "move-branch"), "");
    const result = await run(env);
    expect(result.code).toBe(60);
    expect(result.stdout).toContain("==> FOLDER_CHANGED");
    expect(signatures(log)).not.toContain("up");
    expect(signatures(log)).toContain("release");
    expect(signatures(log)).not.toContain(`checkout ${FROM}`);
  });

  it("a failed build leaves a folder a person put on a branch meanwhile alone", async () => {
    const { stubDir, log, env } = setup();
    writeFileSync(join(stubDir, "fail-build"), "1");
    writeFileSync(join(stubDir, "branch-during-build"), "");
    const result = await run(env);
    expect(result.code).toBe(10);
    expect(result.stdout).toContain("==> BUILD_FAILED");
    expect(result.stdout).toContain("==> FOLDER_CHANGED");
    expect(signatures(log)).not.toContain(`checkout ${FROM}`);
  });

  it("a failed build leaves a branch a person checked out at the old commit alone, not detached", async () => {
    const { stubDir, log, env } = setup();
    writeFileSync(join(stubDir, "fail-build"), "1");
    // deploy.sh ran during the build: main checked out, and main is still the old commit.
    writeFileSync(join(stubDir, "branch-during-build"), "");
    writeFileSync(join(stubDir, "head-during-build"), `${FROM}\n`);
    const result = await run(env);
    expect(result.code).toBe(10);
    expect(result.stdout).toContain("==> FOLDER_CHANGED");
    expect(signatures(log)).not.toContain(`checkout ${FROM}`);
  });

  it("rollback leaves a folder someone else changed alone, exiting 60 without building", async () => {
    const { stubDir, log, env } = setup();
    writeFileSync(join(stubDir, "head"), `${FOREIGN}\n`);
    const result = await runArgs(env, ["rollback", FROM, TAG_COMMIT]);
    expect(result.code).toBe(60);
    expect(result.stdout).toContain("==> FOLDER_CHANGED");
    expect(signatures(log)).not.toContain("build");
    expect(signatures(log)).toContain("release");
    expect(readFileSync(join(stubDir, "head"), "utf8").trim()).toBe(FOREIGN);
  });

  it("in update mode, does not swap when the folder is changed during the wait, exiting 60", async () => {
    const { stubDir, log, env } = setup();
    // Idle so the wait ends, but a person moves HEAD to a third commit during the poll.
    writeFileSync(join(stubDir, "wget-lines"), '{"busy":true}\n{"busy":false}\n');
    writeFileSync(join(stubDir, "move-head"), `${FOREIGN}\n`);
    const result = await run(env);
    expect(result.code).toBe(60);
    expect(result.stdout).toContain("==> FOLDER_CHANGED");
    expect(signatures(log)).not.toContain("up");
    // The hold it took is released, and the changed folder is left as it is.
    expect(signatures(log)).toContain("release");
    expect(readFileSync(join(stubDir, "head"), "utf8").trim()).toBe(FOREIGN);
  });

  it("the EXIT trap and back_to_from leave a folder someone else changed alone", async () => {
    // Trap: an unexpected error (sleep fails) after HEAD was moved during a poll.
    // back_to_from: refreshing the hold fails after HEAD was moved during the first poll.
    for (const how of ["trap", "back_to_from"]) {
      const { stubDir, log, env } = setup();
      writeFileSync(join(stubDir, "move-head"), `${FOREIGN}\n`);
      if (how === "trap") {
        writeFileSync(join(stubDir, "wget-lines"), '{"busy":true}\n');
        writeExe(join(stubDir, "..", "bin"), "sleep", "#!/bin/sh\nexit 1\n");
      } else {
        writeFileSync(join(stubDir, "wget-lines"), '{"busy":true}\n{"busy":false}\n');
        // First hold (take) and first refresh work; the second refresh fails.
        writeFileSync(join(stubDir, "fail-hold-after"), "2");
      }
      const result = await run(env);
      expect({ how, code: result.code }).toEqual({ how, code: how === "trap" ? 1 : 40 });
      expect(result.stdout).toContain("==> FOLDER_CHANGED");
      expect(signatures(log)).not.toContain(`checkout ${FROM}`);
      expect(signatures(log)).toContain("release");
      expect(readFileSync(join(stubDir, "head"), "utf8").trim()).toBe(FOREIGN);
    }
  });

  it("rollback and restore refuse anything but a full commit id", async () => {
    for (const bad of ["main", "abc", `${FROM};id`, `${FROM}0`, ""]) {
      for (const mode of ["rollback", "restore"]) {
        const { log, env } = setup();
        const result = await runArgs(env, [mode, bad]);
        expect({ mode, bad, code: result.code }).toEqual({ mode, bad, code: 2 });
        expect(linesOf(log)).toEqual([]);
      }
    }
    // A present but malformed third argument (the "to" commit) is refused the same way.
    for (const badTo of ["main", `${FROM}0`, `${FROM};id`]) {
      for (const mode of ["rollback", "restore"]) {
        const { log, env } = setup();
        const result = await runArgs(env, [mode, FROM, badTo]);
        expect({ mode, badTo, code: result.code }).toEqual({ mode, badTo, code: 2 });
        expect(linesOf(log)).toEqual([]);
      }
    }
  });

  it("never checks anything out over a HEAD it cannot read, in any recovery path", async () => {
    // Restore: stays pending (non-zero), nothing checked out.
    {
      const { stubDir, log, env } = setup();
      writeFileSync(join(stubDir, "unreadable-head"), "");
      const result = await runArgs(env, ["restore", FROM, TAG_COMMIT]);
      expect(result.code).toBe(50);
      expect(result.stdout).toContain("==> HEAD_UNREADABLE");
      expect(signatures(log).some((step) => step.startsWith("checkout"))).toBe(false);
      expect(signatures(log)).toContain("release");
    }
    // Resumed rollback: no checkout, no build; a person is needed.
    {
      const { stubDir, log, env } = setup();
      writeFileSync(join(stubDir, "unreadable-head"), "");
      const result = await runArgs(env, ["rollback", FROM, TAG_COMMIT]);
      expect(result.code).toBe(20);
      expect(result.stdout).toContain("==> HEAD_UNREADABLE");
      expect(signatures(log).some((step) => step.startsWith("checkout"))).toBe(false);
      expect(signatures(log)).not.toContain("build");
      expect(signatures(log)).toContain("release");
    }
    // A failed build whose HEAD then cannot be read: exit 50 (retried), no checkout of FROM.
    {
      const { stubDir, log, env } = setup();
      writeFileSync(join(stubDir, "fail-build"), "1");
      writeFileSync(join(stubDir, "unreadable-during-build"), "");
      const result = await run(env);
      expect(result.code).toBe(50);
      expect(result.stdout).toContain("==> HEAD_UNREADABLE");
      expect(signatures(log)).not.toContain(`checkout ${FROM}`);
    }
  });

  it("pauses the version being replaced again after the rollback build, and waits for work it started", async () => {
    // The build can outlast the pause (40 minutes): the old version may start a run meanwhile.
    const { stubDir, log, env } = setup();
    writeFileSync(join(stubDir, "head"), `${TAG_COMMIT}\n`);
    writeFileSync(join(stubDir, "wget-lines"), '{"busy":false}\n');
    writeFileSync(join(stubDir, "busy-after-build"), "1");
    const result = await runArgs(env, ["rollback", FROM, TAG_COMMIT]);
    expect(result.code).toBe(10);
    const steps = signatures(log);
    const afterBuild = steps.slice(steps.indexOf("build") + 1, steps.indexOf("up"));
    expect(afterBuild[0]).toBe("hold"); // pause taken again right after the build
    expect(afterBuild.filter((step) => step === "wget")).toHaveLength(2); // busy, then idle
  });

  it("restore releases the pause even when its checkout fails, and stays pending", async () => {
    const { stubDir, log, env } = setup();
    writeFileSync(join(stubDir, "head"), `${TAG_COMMIT}\n`);
    writeFileSync(join(stubDir, "fail-checkout-from"), "1");
    const result = await runArgs(env, ["restore", FROM, TAG_COMMIT]);
    expect(result.code).toBe(50);
    expect(signatures(log).at(-1)).toBe("release");
  });

  it("in rollback and restore modes, proceeds even when tracked files are edited", async () => {
    for (const mode of ["rollback", "restore"]) {
      const { stubDir, log, env } = setup();
      writeFileSync(join(stubDir, "head"), `${TAG_COMMIT}\n`);
      writeFileSync(join(stubDir, "status-out"), " M docker-compose.yml\n");
      const result = await runArgs(env, [mode, FROM, TAG_COMMIT]);
      expect({ mode, code: result.code }).toEqual({ mode, code: mode === "rollback" ? 10 : 0 });
      // The dirty-tree check is update-only: no LOCAL_CHANGES, no exit 30, no `git status`.
      expect(result.stdout).not.toContain("==> LOCAL_CHANGES");
      expect(signatures(log)).not.toContain("status");
    }
  });

  it("refuses to update while a manual deploy holds the repo lock, touching nothing", async () => {
    const { stubDir, log, env } = setup();
    writeFileSync(join(stubDir, "lock-held"), "1"); // deploy.sh holds the lock
    const result = await run(env);
    expect(result.code).toBe(80);
    expect(result.stdout).toContain("==> DEPLOY_IN_PROGRESS");
    const steps = signatures(log);
    // Nothing was touched: no backup, no fetch/checkout, no build, no swap.
    expect(steps).not.toContain("pg_dump");
    expect(steps).not.toContain("build");
    expect(steps).not.toContain("up");
    expect(steps.some((step) => step.startsWith("checkout"))).toBe(false);
  });

  it("takes the repo lock BLOCKING in rollback and restore modes, so it serializes with a deploy", async () => {
    for (const mode of ["rollback", "restore"]) {
      const { stubDir, log, env } = setup();
      writeFileSync(join(stubDir, "head"), `${TAG_COMMIT}\n`);
      const result = await runArgs(env, [mode, FROM, TAG_COMMIT]);
      expect({ mode, code: result.code }).toEqual({ mode, code: mode === "rollback" ? 10 : 0 });
      // Recovery takes the lock blocking (no -n): it waits for any deploy instead of racing it,
      // then re-checks the folder under the lock. update mode uses -n (see the exit-80 test).
      const flockCalls = linesOf(log).filter((line) => line.startsWith("flock "));
      expect(flockCalls.length).toBeGreaterThan(0);
      expect(flockCalls.every((line) => !line.includes(" -n"))).toBe(true);
    }
  });

  it("fails closed when the target commit is unknown: a foreign detached HEAD is left alone", async () => {
    // No `to` argument (an ancient status.json). A person's unrelated detached checkout must
    // not be overwritten: rollback exits 60 without building, restore leaves it and exits 60.
    {
      const { stubDir, log, env } = setup();
      writeFileSync(join(stubDir, "head"), `${FOREIGN}\n`);
      const result = await runArgs(env, ["rollback", FROM]);
      expect(result.code).toBe(60);
      expect(result.stdout).toContain("==> FOLDER_CHANGED");
      expect(signatures(log)).not.toContain("build");
    }
    {
      const { stubDir, log, env } = setup();
      writeFileSync(join(stubDir, "head"), `${FOREIGN}\n`);
      const result = await runArgs(env, ["restore", FROM]);
      expect(result.code).toBe(60);
      expect(result.stdout).toContain("==> FOLDER_CHANGED");
      expect(signatures(log).some((step) => step.startsWith("checkout"))).toBe(false);
    }
  });

  it("refreshes the hold on every busy poll, so a long wait does not let it expire", async () => {
    const { stubDir, log, env } = setup();
    writeFileSync(join(stubDir, "wget-lines"), '{"busy":true}\n{"busy":true}\n{"busy":true}\n{"busy":false}\n');
    const result = await run(env);
    expect(result.code).toBe(0);
    const steps = signatures(log);
    const waitSteps = steps.slice(steps.indexOf("build") + 1, steps.indexOf("up"));
    // One hold to take it, then one refresh before each of the four probes, then the
    // pre-swap HEAD check just before the swap.
    expect(waitSteps).toEqual(["hold", "hold", "wget", "hold", "wget", "hold", "wget", "hold", "wget", "rev-parse", "symbolic-ref"]);
  });

  it("stops before the swap when refreshing the hold fails, and goes back to the old commit", async () => {
    const { stubDir, log, env } = setup();
    writeFileSync(join(stubDir, "wget-lines"), '{"busy":true}\n{"busy":false}\n');
    // The first hold works; the first refresh does not.
    writeFileSync(join(stubDir, "fail-hold-after"), "1");
    const result = await run(env);
    expect(result.code).toBe(40);
    expect(result.stdout).toContain("==> HOLD_FAILED — could not refresh the pause");
    const steps = signatures(log);
    expect(steps).not.toContain("up");
    // Back on the old commit, and the pause released for the old version.
    expect(steps.slice(-2).sort()).toEqual([`checkout ${FROM}`, "release"].sort());
    expect(readFileSync(join(stubDir, "head"), "utf8").trim()).toBe(FROM);
  });

  it("exits 50 when it stops before the swap and cannot check the old commit back out", async () => {
    for (const setupCase of ["build", "hold"]) {
      const { stubDir, env } = setup();
      writeFileSync(join(stubDir, setupCase === "build" ? "fail-build" : "fail-hold"), "1");
      writeFileSync(join(stubDir, "fail-checkout-from"), "1");
      const result = await run(env);
      expect({ setupCase, code: result.code }).toEqual({ setupCase, code: 50 });
      expect(result.stdout).toContain("==> RESTORE_FAILED");
    }
    // An unexpected failure (set -e) after the tag checkout, and the restore fails too.
    const { stubDir, env } = setup();
    writeFileSync(join(stubDir, "wget-lines"), '{"busy":true}\n');
    writeExe(join(stubDir, "..", "bin"), "sleep", "#!/bin/sh\nexit 1\n");
    writeFileSync(join(stubDir, "fail-checkout-from"), "1");
    const result = await run(env);
    expect(result.code).toBe(50);
  });

  it("bounds the wait by the clock, even when each probe is slow", async () => {
    const { stubDir, log, env } = setup();
    // Every probe hangs for its 10-second timeout, then fails.
    writeFileSync(join(stubDir, "wget-lines"), "SLOW\n");
    const result = await run(env);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("==> STILL_BUSY (unreachable)");
    // 40 s per round (10 s timeout + 30 s sleep): 45 rounds fit in 30 minutes, not 60.
    expect(signatures(log).filter((step) => step === "wget")).toHaveLength(45);
  });

  it("in resumed rollback mode, keeps rolling back when refreshing the hold fails", async () => {
    const { stubDir, env } = setup();
    writeFileSync(join(stubDir, "head"), `${TAG_COMMIT}\n`);
    writeFileSync(join(stubDir, "wget-lines"), '{"busy":true}\n{"busy":false}\n');
    writeFileSync(join(stubDir, "fail-hold-after"), "1");
    const result = await runArgs(env, ["rollback", FROM, TAG_COMMIT]);
    expect(result.stderr).not.toContain("unbound");
    expect(result.code).toBe(10);
    expect(result.stdout).toContain("==> ROLLED_BACK");
  });

  it("reaches the rollback-failed state when the rollback checkout itself fails", async () => {
    const { stubDir, env } = setup();
    writeFileSync(join(stubDir, "hide-shas"), `${TAG_COMMIT}\n`);
    writeFileSync(join(stubDir, "fail-checkout-from"), "1");
    const result = await run(env);
    expect(result.code).toBe(20);
    expect(result.stdout).toContain("==> ROLLBACK_FAILED");
  });

  it("releases the hold when the rollback gives up, so the version left up can start runs again", async () => {
    const { stubDir, log, env } = setup();
    writeFileSync(join(stubDir, "head"), `${TAG_COMMIT}\n`);
    writeFileSync(join(stubDir, "fail-build"), "1");
    const result = await runArgs(env, ["rollback", FROM, TAG_COMMIT]);
    expect(result.code).toBe(20);
    expect(result.stdout).toContain("==> ROLLBACK_FAILED");
    expect(signatures(log).at(-1)).toBe("release");
  });

  it("leaves no partial backup when compression fails", async () => {
    const { repo, stubDir, env } = setup();
    writeExe(join(stubDir, "..", "bin"), "gzip", "#!/bin/sh\nprintf partial\nexit 1\n");
    const result = await run(env);
    expect(result.code).not.toBe(0);
    const backups = readdirSync(join(repo, "backups"));
    expect(backups).toEqual([]);
  });

  it("clears leftover temp dumps at the start of the backup, and writes owner-only backups", async () => {
    const { repo, env } = setup();
    mkdirSync(join(repo, "backups"));
    // A backup killed mid-way (SIGKILL, no trap) leaves these behind; they must be cleared.
    writeFileSync(join(repo, "backups", "pre-update-20200101-000000.sql.tmp"), "stale");
    writeFileSync(join(repo, "backups", "pre-update-20200101-000000.sql.tmp.gz"), "stale");
    const result = await run(env);
    expect(result.code).toBe(0);
    const backups = readdirSync(join(repo, "backups"));
    expect(backups.some((name) => name.endsWith(".tmp"))).toBe(false);
    expect(backups.some((name) => name.endsWith(".tmp.gz"))).toBe(false);
    const gz = backups.find((name) => name.endsWith(".sql.gz"));
    expect(gz).toBeDefined();
    // No group or other permission bits: the dump holds the 115 cookie and LLM keys.
    expect(statSync(join(repo, "backups", gz)).mode & 0o077).toBe(0);
  });

  it("treats a build that hangs as a failed build in update mode, and does not swap", async () => {
    const { stubDir, log, env } = setup();
    writeFileSync(join(stubDir, "hang-build"), "1");
    const result = await run(env);
    expect(result.code).toBe(10);
    expect(result.stdout).toContain("==> BUILD_FAILED");
    const steps = signatures(log);
    expect(steps).not.toContain("up"); // never swapped
    expect(steps).not.toContain("build"); // timeout stopped it before it ran
    expect(steps.at(-1)).toBe(`checkout ${FROM}`); // back on the old commit
  });

  it("stops before checkout or build when pg_dump fails, and leaves no temp dump", async () => {
    const { repo, stubDir, log, env } = setup();
    writeFileSync(join(stubDir, "fail-pg-dump"), "1");
    const result = await run(env);
    expect(result.code).not.toBe(0);
    expect(signatures(log)).toEqual(["status", "inspect", "rev-parse", "pg_dump"]);
    const backups = readdirSync(join(repo, "backups"));
    expect(backups.filter((name) => name.endsWith(".sql.tmp"))).toEqual([]);
    expect(backups.filter((name) => name.endsWith(".sql.gz"))).toEqual([]);
  });

  it("fails clearly and touches nothing when the release cannot be downloaded", async () => {
    const { stubDir, log, env } = setup();
    writeFileSync(join(stubDir, "fail-fetch"), "1");
    const result = await run(env);
    expect(result.code).toBe(70);
    expect(result.stdout).toContain("==> FETCH_FAILED");
    const steps = signatures(log);
    expect(steps).not.toContain("build");
    expect(steps).not.toContain("hold");
    expect(steps.some((step) => step.startsWith("checkout"))).toBe(false);
  });

  it("passes a configured proxy to git, and always sets a stall limit on the fetch", async () => {
    // With a proxy configured: the fetch carries it, plus the low-speed settings.
    {
      const { log, env } = setup();
      const result = await run({ ...env, UPDATER_HTTPS_PROXY: "http://proxy.example:8080" });
      expect(result.code).toBe(0);
      const fetch = linesOf(log).find((line) => line.startsWith("git ") && line.includes(" fetch "));
      expect(fetch).toContain("http.proxy=http://proxy.example:8080");
      expect(fetch).toContain("http.lowSpeedLimit=1000");
      expect(fetch).toContain("http.lowSpeedTime=60");
    }
    // Without one: still the stall limit, no proxy setting.
    {
      const { log, env } = setup();
      const result = await run({ ...env, UPDATER_HTTPS_PROXY: "", UPDATER_HTTP_PROXY: "" });
      expect(result.code).toBe(0);
      const fetch = linesOf(log).find((line) => line.startsWith("git ") && line.includes(" fetch "));
      expect(fetch).toContain("http.lowSpeedLimit=1000");
      expect(fetch).toContain("http.lowSpeedTime=60");
      expect(fetch).not.toContain("http.proxy");
    }
  });

  it("keeps calls to the web direct with -Y off, even when a proxy is set", async () => {
    const { log, env } = setup();
    const result = await run({ ...env, UPDATER_HTTPS_PROXY: "http://proxy.example:8080" });
    expect(result.code).toBe(0);
    const calls = linesOf(log).filter((entry) => /^(wget|hold) /.test(entry));
    expect(calls.length).toBeGreaterThan(0);
    for (const line of calls) {
      expect(line).toMatch(/ -Y off /);
    }
  });
});
