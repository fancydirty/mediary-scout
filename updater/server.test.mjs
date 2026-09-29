import { createServer, request as httpRequest } from "node:http";
import { once } from "node:events";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { parseReleaseTag } from "../apps/web/lib/release-version.ts";
import { createUpdater, createUpdaterHttp, interpretBusyResponse, isReleaseTag, readLimitedBody } from "./server.mjs";

const SAMPLES = [
  "v2026.09.28",
  "v2026.09.28.2",
  "v2026.09.28.10",
  "v2028.02.29",
  "v1.4.1",
  "2026.09.28",
  "v2026.9.28",
  "v2026.13.01",
  "v2026.09.28.0",
  "v2026.09.28.02",
  "main",
  "v2026.09.28;rm -rf /",
  "",
  "v2026.02.31",
  "v2026.02.29",
  "v2026.04.31",
  "v2026.11.31",
  "v0000.02.29",
  "v0008.02.29",
  "v1999.12.31",
  "v2100.01.01",
  "v2000.02.29",
  "v2099.12.31",
];

function fakeRunner(lines, code) {
  return (_tag, onLine) =>
    new Promise((resolve) => {
      for (const line of lines) onLine(line);
      resolve(code);
    });
}

function make(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), "updater-"));
  const updater = createUpdater({
    stateDir: dir,
    runUpdate:
      opts.runUpdate ??
      fakeRunner(
        ["==> STEP backing_up", "==> STEP building", "==> STEP switching", "==> STEP verifying", "==> DONE v2026.10.02"],
        0,
      ),
    acquisitionsRunning: opts.acquisitionsRunning ?? (async () => false),
    sleep: async () => {},
    now: () => "2026-10-02T20:00:00.000Z",
    waitPollMs: 1,
    waitLimitMs: opts.waitLimitMs ?? 1000,
    repoCommit: () => "a".repeat(40),
  });
  return { updater, dir };
}

function call(port, { method, path, token, body }) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: "127.0.0.1",
        port,
        method,
        path,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function withServer(updater, token, fn) {
  const server = createServer(createUpdaterHttp(updater, token));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  try {
    return await fn(typeof address === "object" && address ? address.port : 0);
  } finally {
    server.close();
    await once(server, "close");
  }
}

describe("updater", () => {
  it("accepts the same tags as the web release parser", () => {
    for (const sample of SAMPLES) {
      expect(isReleaseTag(sample)).toBe(parseReleaseTag(sample) !== null);
    }
  });

  it("runs an update to done and persists the status", async () => {
    const { updater, dir } = make();
    expect(updater.start("v2026.10.02").accepted).toBe(true);
    await updater.idle();
    expect(updater.status()).toMatchObject({ phase: "done", targetTag: "v2026.10.02" });
    expect(JSON.parse(readFileSync(join(dir, "status.json"), "utf8")).phase).toBe("done");
  });

  it("reports the deploy folder's commit with every status", () => {
    const { updater } = make();
    expect(updater.status().repoCommit).toBe("a".repeat(40));
  });

  it("refuses a non-release ref", () => {
    const { updater } = make();
    expect(updater.start("main")).toEqual({ accepted: false, reason: "bad_tag" });
    expect(updater.start("v2026.10.02; rm -rf /")).toEqual({ accepted: false, reason: "bad_tag" });
    for (const sample of SAMPLES) {
      if (parseReleaseTag(sample)) continue;
      expect(updater.start(sample)).toEqual({ accepted: false, reason: "bad_tag" });
    }
  });

  it("refuses a second update while one is running", async () => {
    const { updater } = make();
    updater.start("v2026.10.02");
    expect(updater.start("v2026.10.02")).toEqual({ accepted: false, reason: "busy" });
    await updater.idle();
  });

  it("maps exit 10 to rolled_back, and says the old version never stopped when the build failed", async () => {
    const { updater } = make({ runUpdate: fakeRunner(["==> STEP building", "==> BUILD_FAILED"], 10) });
    updater.start("v2026.10.02");
    await updater.idle();
    expect(updater.status()).toMatchObject({
      phase: "rolled_back",
      message: "新版本构建没成功，原来的版本一直在运行，没有受影响。",
    });
  });

  it("maps a failed check after the swap to rolled_back with the rollback message", async () => {
    const { updater } = make({
      runUpdate: fakeRunner(["==> STEP switching", "==> STEP verifying", "==> VERIFY_FAILED", "==> ROLLED_BACK"], 10),
    });
    updater.start("v2026.10.02");
    await updater.idle();
    expect(updater.status()).toMatchObject({
      phase: "rolled_back",
      message: "新版本没通过自检，已自动回到原来的版本，一切照常。",
    });
  });

  it("maps exit 30 (edited files in the deploy folder) to a failed update that says why", async () => {
    const { updater } = make({ runUpdate: fakeRunner(["==> LOCAL_CHANGES", " M docker-compose.yml"], 30) });
    updater.start("v2026.10.02");
    await updater.idle();
    expect(updater.status().phase).toBe("failed");
    expect(updater.status().message).toContain("部署目录里有改过的文件");
  });

  it("waits for tasks, and gives up after the limit", async () => {
    const { updater } = make({ acquisitionsRunning: async () => true, waitLimitMs: 0 });
    updater.start("v2026.10.02");
    await updater.idle();
    expect(updater.status()).toMatchObject({ phase: "failed", message: "有任务一直没结束，这次先不更新了。" });
  });

  it("says a task is in progress while it waits", async () => {
    let updater;
    let seen = "";
    const made = make({
      waitLimitMs: 10_000,
      acquisitionsRunning: async () => {
        if (!seen) {
          seen = updater.status().message;
          return true;
        }
        return false;
      },
    });
    updater = made.updater;
    updater.start("v2026.10.02");
    await updater.idle();
    expect(seen).toBe("有任务在进行，等它结束再继续。");
    expect(updater.status().phase).toBe("done");
  });

  it("loads a status persisted as building as failed", () => {
    const dir = mkdtempSync(join(tmpdir(), "updater-"));
    writeFileSync(
      join(dir, "status.json"),
      JSON.stringify({
        phase: "building",
        targetTag: "v2026.10.02",
        fromCommit: "c".repeat(40),
        startedAt: "2026-10-02T19:00:00.000Z",
        finishedAt: null,
        message: "正在构建新版本，构建期间一切照常。",
        logTail: "",
      }),
    );
    const updater = createUpdater({
      stateDir: dir,
      runUpdate: fakeRunner([], 0),
      acquisitionsRunning: async () => false,
      sleep: async () => {},
      now: () => "2026-10-02T20:00:00.000Z",
      waitPollMs: 1,
      waitLimitMs: 1000,
      repoCommit: () => "a".repeat(40),
    });
    expect(updater.status()).toMatchObject({
      phase: "failed",
      message: "更新被中断了，原来的版本仍在运行。",
      finishedAt: "2026-10-02T20:00:00.000Z",
    });
    expect(JSON.parse(readFileSync(join(dir, "status.json"), "utf8")).phase).toBe("failed");
  });

  it("after a restart during the swap, goes back to the recorded commit", async () => {
    for (const phase of ["switching", "verifying"]) {
      const dir = mkdtempSync(join(tmpdir(), "updater-"));
      writeFileSync(
        join(dir, "status.json"),
        JSON.stringify({ phase, targetTag: "v2026.10.02", fromCommit: "c".repeat(40), startedAt: "x", finishedAt: null, message: "", logTail: "" }),
      );
      const calls = [];
      const updater = createUpdater({
        stateDir: dir,
        runUpdate: (args, onLine) => {
          calls.push(args);
          onLine("==> ROLLED_BACK");
          return Promise.resolve(10);
        },
        acquisitionsRunning: async () => false,
        sleep: async () => {},
        now: () => "2026-10-02T20:00:00.000Z",
        waitPollMs: 1,
        waitLimitMs: 1000,
        repoCommit: () => "a".repeat(40),
      });
      // Busy while the rollback runs: a new update must not start on top of it.
      expect(updater.start("v2026.10.03")).toEqual({ accepted: false, reason: "busy" });
      await updater.idle();
      expect(calls).toEqual([["rollback", "c".repeat(40)]]);
      expect(updater.status()).toMatchObject({
        phase: "rolled_back",
        message: "更新中途被打断，已自动回到原来的版本，一切照常。",
        finishedAt: "2026-10-02T20:00:00.000Z",
      });
      expect(updater.status().logTail).toContain("==> ROLLED_BACK");
    }
  });

  it("keeps the phase past the swap when the rollback prints a waiting step, so a restart still rolls back", async () => {
    const dir = mkdtempSync(join(tmpdir(), "updater-"));
    let fed = () => {};
    const feeding = new Promise((resolve) => {
      fed = resolve;
    });
    const options = {
      stateDir: dir,
      acquisitionsRunning: async () => false,
      sleep: async () => {},
      now: () => "2026-10-02T20:00:00.000Z",
      waitPollMs: 1,
      waitLimitMs: 1000,
      repoCommit: () => "a".repeat(40),
    };
    const first = createUpdater({
      ...options,
      runUpdate: (_tag, onLine) => {
        for (const line of [
          `==> FROM ${"c".repeat(40)}`,
          "==> STEP backing_up",
          "==> STEP building",
          "==> STEP switching",
          "==> STEP verifying",
          "==> VERIFY_FAILED — rolling back to c",
          "==> STEP waiting",
          "==> STEP building",
        ]) {
          onLine(line);
        }
        fed();
        // The updater is killed here: the runner never finishes.
        return new Promise(() => {});
      },
    });
    first.start("v2026.10.02");
    await feeding;
    expect(first.status().phase).toBe("switching");
    expect(JSON.parse(readFileSync(join(dir, "status.json"), "utf8")).phase).toBe("switching");
    const calls = [];
    const second = createUpdater({
      ...options,
      runUpdate: (args, onLine) => {
        calls.push(args);
        onLine("==> ROLLED_BACK");
        return Promise.resolve(10);
      },
    });
    await second.idle();
    expect(calls).toEqual([["rollback", "c".repeat(40)]]);
  });

  it("saves the log tail after every line, so a restart keeps the lines right before it", async () => {
    let seen = null;
    let updater;
    const made = make({
      runUpdate: (_tag, onLine) => {
        onLine("==> STEP building");
        onLine("#12 [web 4/9] RUN npm ci");
        onLine("==> BUSY_CHECK busy");
        seen = JSON.parse(readFileSync(join(made.dir, "status.json"), "utf8"));
        return new Promise(() => {});
      },
    });
    updater = made.updater;
    updater.start("v2026.10.02");
    for (let tries = 0; tries < 50 && !seen; tries += 1) await new Promise((resolve) => setTimeout(resolve, 1));
    // Neither line is a step: both must already be in the file a restart would read.
    expect(seen.logTail.split("\n").slice(-2)).toEqual(["#12 [web 4/9] RUN npm ci", "==> BUSY_CHECK busy"]);
    expect(updater.status().logTail.endsWith("==> BUSY_CHECK busy")).toBe(true);
  });

  it("says the old version is coming back as soon as the new one fails its check or its start", async () => {
    for (const failure of ["==> VERIFY_FAILED — rolling back to c", "==> UP_FAILED — rolling back to c"]) {
      let seen = null;
      let updater;
      const made = make({
        runUpdate: (_tag, onLine) => {
          onLine(`==> FROM ${"c".repeat(40)}`);
          onLine("==> STEP switching");
          onLine("==> STEP verifying");
          onLine(failure);
          seen = updater.status();
          return new Promise(() => {});
        },
      });
      updater = made.updater;
      updater.start("v2026.10.02");
      for (let tries = 0; tries < 50 && !seen; tries += 1) await new Promise((resolve) => setTimeout(resolve, 1));
      expect(seen).toMatchObject({
        phase: "switching",
        message: "新版本没通过自检，正在回到原来的版本，网页会短暂打不开。",
      });
    }
  });

  it("says a person is needed when that rollback fails too", async () => {
    const dir = mkdtempSync(join(tmpdir(), "updater-"));
    writeFileSync(
      join(dir, "status.json"),
      JSON.stringify({ phase: "verifying", targetTag: "v2026.10.02", fromCommit: "c".repeat(40), startedAt: "x", finishedAt: null, message: "", logTail: "" }),
    );
    const updater = createUpdater({
      stateDir: dir,
      runUpdate: () => Promise.resolve(20),
      acquisitionsRunning: async () => false,
      sleep: async () => {},
      now: () => "2026-10-02T20:00:00.000Z",
      waitPollMs: 1,
      waitLimitMs: 1000,
      repoCommit: () => "a".repeat(40),
    });
    await updater.idle();
    expect(updater.status()).toMatchObject({
      phase: "failed",
      message: "更新中途被打断，自动回退也没成功。请在部署目录运行 ./scripts/deploy.sh 恢复。",
    });
  });

  it("passes the commit an interrupted update was moving to when it resumes a rollback", async () => {
    const dir = mkdtempSync(join(tmpdir(), "updater-"));
    writeFileSync(
      join(dir, "status.json"),
      JSON.stringify({ phase: "verifying", targetTag: "v2026.10.02", fromCommit: "c".repeat(40), toCommit: "d".repeat(40), startedAt: "x", finishedAt: null, message: "", logTail: "" }),
    );
    const calls = [];
    const updater = createUpdater({
      stateDir: dir,
      runUpdate: (args) => {
        calls.push(args);
        return Promise.resolve(10);
      },
      acquisitionsRunning: async () => false,
      sleep: async () => {},
      now: () => "2026-10-02T20:00:00.000Z",
      waitPollMs: 1,
      waitLimitMs: 1000,
      repoCommit: () => "a".repeat(40),
    });
    await updater.idle();
    expect(calls).toEqual([["rollback", "c".repeat(40), "d".repeat(40)]]);
  });

  it("maps a resumed rollback that finds the folder changed to failed, needing a person", async () => {
    const dir = mkdtempSync(join(tmpdir(), "updater-"));
    writeFileSync(
      join(dir, "status.json"),
      JSON.stringify({ phase: "switching", targetTag: "v2026.10.02", fromCommit: "c".repeat(40), toCommit: "d".repeat(40), startedAt: "x", finishedAt: null, message: "", logTail: "" }),
    );
    const updater = createUpdater({
      stateDir: dir,
      runUpdate: () => Promise.resolve(60),
      acquisitionsRunning: async () => false,
      sleep: async () => {},
      now: () => "2026-10-02T20:00:00.000Z",
      waitPollMs: 1,
      waitLimitMs: 1000,
      repoCommit: () => "a".repeat(40),
      servingCommit: async () => null,
    });
    await updater.idle();
    expect(updater.status()).toMatchObject({
      phase: "failed",
      needsManualRecovery: true,
      message: "更新中途部署目录被人手动换过版本，更新助手没有再改动它。如果网页不正常，请在部署目录运行 ./scripts/deploy.sh。",
    });
  });

  it("maps an update that finds the folder changed to a plain failed, no person needed", async () => {
    const { updater } = make({
      runUpdate: (_tag, onLine) => {
        onLine(`==> FROM ${"a".repeat(40)}`);
        onLine(`==> TO ${"b".repeat(40)}`);
        return Promise.resolve(60);
      },
    });
    updater.start("v2026.10.02");
    await updater.idle();
    expect(updater.status()).toMatchObject({
      phase: "failed",
      toCommit: "b".repeat(40),
      message: "更新途中部署目录被人手动换过版本，这次先不更新了，更新助手没有再改动它。",
    });
    expect(updater.status().needsManualRecovery).toBeUndefined();
    // The container was not swapped, so the folder HEAD is not what serves.
    expect(updater.status().servingUnknown).toBe(true);
  });

  it("clears servingUnknown once a recheck sees the web serving the folder HEAD", async () => {
    let serving = "f".repeat(40);
    const calls = [];
    const dir = mkdtempSync(join(tmpdir(), "updater-"));
    const updater = createUpdater({
      stateDir: dir,
      runUpdate: (args) => {
        calls.push(args);
        return Promise.resolve(calls.length === 1 ? 60 : 0);
      },
      acquisitionsRunning: async () => false,
      sleep: async () => {},
      now: () => "2026-10-02T20:00:00.000Z",
      waitPollMs: 1,
      waitLimitMs: 1000,
      repoCommit: () => "a".repeat(40),
      servingCommit: async () => serving,
    });
    updater.start("v2026.10.02");
    await updater.idle();
    expect(updater.status().servingUnknown).toBe(true);
    await updater.recheckRecovery(); // the web still serves another commit
    expect(updater.status().servingUnknown).toBe(true);
    serving = "a".repeat(40); // the person's deploy.sh finished
    await updater.recheckRecovery();
    expect(updater.status().servingUnknown).toBeUndefined();
  });

  it("refuses a new update while servingUnknown, and accepts one once a recheck cleared it", async () => {
    let serving = "f".repeat(40);
    const calls = [];
    const dir = mkdtempSync(join(tmpdir(), "updater-"));
    const updater = createUpdater({
      stateDir: dir,
      runUpdate: (args) => {
        calls.push(args);
        return Promise.resolve(calls.length === 1 ? 60 : 0);
      },
      acquisitionsRunning: async () => false,
      sleep: async () => {},
      now: () => "2026-10-02T20:00:00.000Z",
      waitPollMs: 1,
      waitLimitMs: 1000,
      repoCommit: () => "a".repeat(40),
      servingCommit: async () => serving,
    });
    updater.start("v2026.10.02");
    await updater.idle();
    expect(updater.status().servingUnknown).toBe(true);
    // The folder is on somebody's own checkout: an update would check a release tag out over it.
    expect(updater.start("v2026.10.03")).toEqual({ accepted: false, reason: "serving_unknown" });
    expect(calls).toHaveLength(1);
    expect(updater.status().servingUnknown).toBe(true);
    serving = "a".repeat(40); // the person's deploy.sh finished
    await updater.recheckRecovery();
    expect(updater.start("v2026.10.03")).toEqual({ accepted: true });
    await updater.idle();
    expect(updater.status()).toMatchObject({ phase: "done", targetTag: "v2026.10.03" });
    expect(updater.status().servingUnknown).toBeUndefined();
  });

  it("answers 409 serving_unknown over HTTP", async () => {
    const dir = mkdtempSync(join(tmpdir(), "updater-"));
    writeFileSync(
      join(dir, "status.json"),
      JSON.stringify({ phase: "failed", targetTag: "v2026.10.02", fromCommit: null, startedAt: "x", finishedAt: "y", message: "", logTail: "", servingUnknown: true }),
    );
    const updater = createUpdater({
      stateDir: dir,
      runUpdate: () => Promise.resolve(0),
      acquisitionsRunning: async () => false,
      sleep: async () => {},
      now: () => "2026-10-02T20:00:00.000Z",
      waitPollMs: 1,
      waitLimitMs: 1000,
      repoCommit: () => "a".repeat(40),
      servingCommit: async () => null,
    });
    const handler = createUpdaterHttp(updater, "t0k3n");
    const req = new PassThrough();
    req.method = "POST";
    req.url = "/update";
    req.headers = { authorization: "Bearer t0k3n" };
    const res = { code: 0, body: "", writeHead(code) { this.code = code; return this; }, end(body) { this.body = body ?? ""; this.done?.(); } };
    const done = new Promise((resolve) => (res.done = resolve));
    handler(req, res);
    req.end(JSON.stringify({ tag: "v2026.10.03" }));
    await done;
    expect(res.code).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ accepted: false, reason: "serving_unknown" });
  });

  it("a cut-off update whose restore finds the folder changed by hand is done with it: servingUnknown, nothing retried", async () => {
    const dir = mkdtempSync(join(tmpdir(), "updater-"));
    writeFileSync(
      join(dir, "status.json"),
      JSON.stringify({ phase: "building", targetTag: "v2026.10.02", fromCommit: "c".repeat(40), startedAt: "x", finishedAt: null, message: "", logTail: "" }),
    );
    const boot = (calls) =>
      createUpdater({
        stateDir: dir,
        runUpdate: (args) => {
          calls.push(args);
          return Promise.resolve(60);
        },
        acquisitionsRunning: async () => false,
        sleep: async () => {},
        now: () => "2026-10-02T20:00:00.000Z",
        waitPollMs: 1,
        waitLimitMs: 1000,
        repoCommit: () => "a".repeat(40),
      });
    const first = [];
    const updater = boot(first);
    await updater.idle();
    expect(first).toEqual([["restore", "c".repeat(40)]]);
    expect(updater.status()).toMatchObject({
      phase: "failed",
      servingUnknown: true,
      message: "更新被中断了，之后部署目录被人手动换过版本，更新助手没有再改动它。等它跑起来后再更新。",
    });
    expect(updater.status().pendingRestore).toBeUndefined();
    expect(updater.status().needsManualRecovery).toBeUndefined();
    // The flag survives a restart, and the restore is not tried again.
    const second = [];
    const restarted = boot(second);
    await restarted.idle();
    expect(second).toEqual([]);
    expect(restarted.status().servingUnknown).toBe(true);
    expect(restarted.start("v2026.10.03")).toEqual({ accepted: false, reason: "serving_unknown" });
  });

  it("exit 50 whose immediate restore finds the folder changed by hand ends in servingUnknown, not a retry loop", async () => {
    const calls = [];
    const { updater } = make({
      runUpdate: (args, onLine) => {
        calls.push(args);
        if (Array.isArray(args)) return Promise.resolve(60);
        onLine(`==> FROM ${"c".repeat(40)}`);
        onLine("==> RESTORE_FAILED");
        return Promise.resolve(50);
      },
    });
    updater.start("v2026.10.02");
    await updater.idle();
    expect(calls).toEqual(["v2026.10.02", ["restore", "c".repeat(40)]]);
    expect(updater.status()).toMatchObject({ phase: "failed", servingUnknown: true });
    expect(updater.status().pendingRestore).toBeUndefined();
    expect(updater.start("v2026.10.03")).toEqual({ accepted: false, reason: "serving_unknown" });
  });

  it("a new update whose pending restore finds the folder changed by hand does not run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "updater-"));
    writeFileSync(
      join(dir, "status.json"),
      JSON.stringify({
        phase: "failed",
        targetTag: "v2026.10.02",
        fromCommit: "c".repeat(40),
        startedAt: "x",
        finishedAt: "y",
        message: "更新被中断了，原来的版本仍在运行。",
        logTail: "",
        pendingRestore: true,
      }),
    );
    const calls = [];
    let restoreCode = 1;
    const updater = createUpdater({
      stateDir: dir,
      runUpdate: (args) => {
        calls.push(args);
        return Promise.resolve(Array.isArray(args) ? restoreCode : 0);
      },
      acquisitionsRunning: async () => false,
      sleep: async () => {},
      now: () => "2026-10-02T20:00:00.000Z",
      waitPollMs: 1,
      waitLimitMs: 1000,
      repoCommit: () => "a".repeat(40),
    });
    await updater.idle(); // the start-up retry: fails, still pending
    calls.length = 0;
    restoreCode = 60; // somebody checked something else out meanwhile
    expect(updater.start("v2026.10.03")).toEqual({ accepted: true });
    await updater.idle();
    expect(calls).toEqual([["restore", "c".repeat(40)]]); // no update ran
    expect(updater.status()).toMatchObject({
      phase: "failed",
      servingUnknown: true,
      message: "更新被中断了，之后部署目录被人手动换过版本，更新助手没有再改动它。等它跑起来后再更新。",
    });
    expect(updater.status().pendingRestore).toBeUndefined();
    expect(updater.start("v2026.10.04")).toEqual({ accepted: false, reason: "serving_unknown" });
  });

  it("maps a failed download to a failed update that points at the proxy setting", async () => {
    const { updater } = make({ runUpdate: () => Promise.resolve(70) });
    updater.start("v2026.10.02");
    await updater.idle();
    expect(updater.status()).toMatchObject({
      phase: "failed",
      message:
        "没能从 GitHub 下载新版本，原来的版本一直在运行。网络不通时，可以在 .env 里设置 HTTPS_PROXY，在部署目录运行 docker compose up -d 让它生效，再点更新。",
    });
  });

  it("maps a manual-deploy lock clash (exit 80) to a failed update that says a deploy is running", async () => {
    const { updater } = make({ runUpdate: () => Promise.resolve(80) });
    updater.start("v2026.10.02");
    await updater.idle();
    expect(updater.status()).toMatchObject({
      phase: "failed",
      message: "正在进行一次手动部署，这次先不更新了，原来的版本一直在运行。手动部署完成后可以再点更新。",
    });
    expect(updater.status().needsManualRecovery).toBeUndefined();
  });

  it("after a restart before the swap, only checks the old commit back out", async () => {
    const dir = mkdtempSync(join(tmpdir(), "updater-"));
    writeFileSync(
      join(dir, "status.json"),
      JSON.stringify({ phase: "building", targetTag: "v2026.10.02", fromCommit: "c".repeat(40), startedAt: "x", finishedAt: null, message: "", logTail: "" }),
    );
    const calls = [];
    const updater = createUpdater({
      stateDir: dir,
      runUpdate: (args) => {
        calls.push(args);
        return Promise.resolve(0);
      },
      acquisitionsRunning: async () => false,
      sleep: async () => {},
      now: () => "2026-10-02T20:00:00.000Z",
      waitPollMs: 1,
      waitLimitMs: 1000,
      repoCommit: () => "a".repeat(40),
    });
    await updater.idle();
    expect(calls).toEqual([["restore", "c".repeat(40)]]);
    expect(updater.status()).toMatchObject({ phase: "failed", message: "更新被中断了，原来的版本仍在运行。" });
  });

  it("retries a cut-off restore on the next start, and stops once it succeeded", async () => {
    const dir = mkdtempSync(join(tmpdir(), "updater-"));
    writeFileSync(
      join(dir, "status.json"),
      JSON.stringify({ phase: "building", targetTag: "v2026.10.02", fromCommit: "c".repeat(40), startedAt: "x", finishedAt: null, message: "", logTail: "" }),
    );
    const boot = (code, calls) =>
      createUpdater({
        stateDir: dir,
        runUpdate: (args) => {
          calls.push(args);
          return code === "hang" ? new Promise(() => {}) : Promise.resolve(code);
        },
        acquisitionsRunning: async () => false,
        sleep: async () => {},
        now: () => "2026-10-02T20:00:00.000Z",
        waitPollMs: 1,
        waitLimitMs: 1000,
        repoCommit: () => "a".repeat(40),
      });
    // First start: the restore is killed before it finishes.
    const first = [];
    boot("hang", first);
    expect(first).toEqual([["restore", "c".repeat(40)]]);
    expect(JSON.parse(readFileSync(join(dir, "status.json"), "utf8"))).toMatchObject({ phase: "failed", pendingRestore: true });
    // Second start: tried again, and it works.
    const second = [];
    const updater = boot(0, second);
    await updater.idle();
    expect(second).toEqual([["restore", "c".repeat(40)]]);
    expect(JSON.parse(readFileSync(join(dir, "status.json"), "utf8")).pendingRestore).toBeUndefined();
    // Third start: nothing left to do.
    const third = [];
    await boot(0, third).idle();
    expect(third).toEqual([]);
  });

  it("a new update first retries a pending restore, and does not start while it keeps failing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "updater-"));
    writeFileSync(
      join(dir, "status.json"),
      JSON.stringify({
        phase: "failed",
        targetTag: "v2026.10.02",
        fromCommit: "c".repeat(40),
        startedAt: "x",
        finishedAt: "y",
        message: "更新被中断了，原来的版本仍在运行。",
        logTail: "",
        pendingRestore: true,
      }),
    );
    const calls = [];
    const restoreMessages = [];
    let restoreCode = 1;
    const updater = createUpdater({
      stateDir: dir,
      runUpdate: (args) => {
        calls.push(args);
        if (Array.isArray(args)) {
          // Read from disk to avoid the closure touching `updater` before it is assigned
          // (the constructor runs the start-up retry synchronously).
          restoreMessages.push(JSON.parse(readFileSync(join(dir, "status.json"), "utf8")).message);
          return Promise.resolve(restoreCode);
        }
        return Promise.resolve(0);
      },
      acquisitionsRunning: async () => false,
      sleep: async () => {},
      now: () => "2026-10-02T20:00:00.000Z",
      waitPollMs: 1,
      waitLimitMs: 1000,
      repoCommit: () => "a".repeat(40),
    });
    await updater.idle(); // the start-up retry, which fails
    calls.length = 0;
    restoreMessages.length = 0;
    expect(updater.start("v2026.10.03")).toEqual({ accepted: true });
    await updater.idle();
    expect(calls).toEqual([["restore", "c".repeat(40)]]); // failed again: no update ran
    expect(restoreMessages).toEqual(["正在把部署目录切回原来的版本…"]); // the message shown while it tries
    expect(updater.status()).toMatchObject({
      phase: "failed",
      pendingRestore: true,
      message: "部署目录没能切回原来的版本，这次先不更新了。请在部署目录运行 ./scripts/deploy.sh。",
    });

    restoreCode = 0;
    calls.length = 0;
    updater.start("v2026.10.03");
    await updater.idle();
    expect(calls).toEqual([["restore", "c".repeat(40)], "v2026.10.03"]);
    expect(updater.status()).toMatchObject({ phase: "done", targetTag: "v2026.10.03" });
    expect(updater.status().pendingRestore).toBeUndefined();
  });

  it("exit 50 records a pending restore and retries it right away", async () => {
    const calls = [];
    let restoreCode = 1;
    const { updater } = make({
      runUpdate: (args, onLine) => {
        calls.push(args);
        if (Array.isArray(args)) return Promise.resolve(restoreCode);
        onLine(`==> FROM ${"c".repeat(40)}`);
        onLine("==> RESTORE_FAILED");
        return Promise.resolve(50);
      },
    });
    updater.start("v2026.10.02");
    await updater.idle();
    expect(calls).toEqual(["v2026.10.02", ["restore", "c".repeat(40)]]);
    expect(updater.status()).toMatchObject({ phase: "failed", pendingRestore: true, message: "更新被中断了，原来的版本仍在运行。" });

    restoreCode = 0;
    calls.length = 0;
    updater.start("v2026.10.03");
    await updater.idle();
    expect(calls[0]).toEqual(["restore", "c".repeat(40)]);
    expect(updater.status().pendingRestore).toBeUndefined();
  });

  it("after a failed rollback, refuses new updates until a recheck finds the web serving the deploy folder HEAD again", async () => {
    let serving = "b".repeat(40);
    const calls = [];
    const dir = mkdtempSync(join(tmpdir(), "updater-"));
    const updater = createUpdater({
      stateDir: dir,
      runUpdate: (args) => {
        calls.push(args);
        return Promise.resolve(calls.length === 1 ? 20 : 0);
      },
      acquisitionsRunning: async () => false,
      sleep: async () => {},
      now: () => "2026-10-02T20:00:00.000Z",
      waitPollMs: 1,
      waitLimitMs: 1000,
      repoCommit: () => "a".repeat(40),
      servingCommit: async () => serving,
    });
    updater.start("v2026.10.02");
    await updater.idle();
    expect(updater.status()).toMatchObject({ phase: "failed", needsManualRecovery: true });
    expect(updater.start("v2026.10.03")).toEqual({ accepted: false, reason: "needs_recovery" });
    expect(calls).toHaveLength(1);
    // A person ran deploy.sh: the web now serves the deploy folder's HEAD. Starting an update
    // does not look at that; only the recheck does.
    serving = "a".repeat(40);
    expect(updater.start("v2026.10.03")).toEqual({ accepted: false, reason: "needs_recovery" });
    expect(calls).toHaveLength(1);
    await updater.recheckRecovery();
    expect(updater.status().needsManualRecovery).toBeUndefined();
    expect(updater.status()).toMatchObject({ phase: "failed", message: "上次更新没成功，之后已经恢复正常，可以再次更新。" });
    expect(updater.start("v2026.10.03")).toEqual({ accepted: true });
    await updater.idle();
    expect(calls).toEqual(["v2026.10.02", "v2026.10.03"]);
  });

  it("a recheck leaves the recovery flag alone until the web really serves the deploy folder HEAD", async () => {
    const dir = mkdtempSync(join(tmpdir(), "updater-"));
    const message = "新版本没通过自检，自动回退也没成功。请在部署目录运行 ./scripts/deploy.sh 恢复。";
    writeFileSync(
      join(dir, "status.json"),
      JSON.stringify({ phase: "failed", targetTag: "v2026.10.02", fromCommit: null, startedAt: "x", finishedAt: "y", message, logTail: "", needsManualRecovery: true }),
    );
    let head = "a".repeat(40);
    let serving = "b".repeat(40);
    const updater = createUpdater({
      stateDir: dir,
      runUpdate: () => Promise.resolve(0),
      acquisitionsRunning: async () => false,
      sleep: async () => {},
      now: () => "2026-10-02T20:00:00.000Z",
      waitPollMs: 1,
      waitLimitMs: 1000,
      repoCommit: () => head,
      servingCommit: async () => serving,
    });
    const stillFlagged = () => expect(updater.status()).toMatchObject({ needsManualRecovery: true, message });
    await updater.recheckRecovery(); // the web serves another commit
    stillFlagged();
    serving = null; // the web does not answer
    await updater.recheckRecovery();
    stillFlagged();
    head = null; // neither side is known: two nulls are not a match
    await updater.recheckRecovery();
    stillFlagged();
    head = "a".repeat(40);
    serving = "a".repeat(40);
    await updater.recheckRecovery();
    expect(updater.status().needsManualRecovery).toBeUndefined();
  });

  it("a recheck does nothing while a job runs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "updater-"));
    // Cut off mid-rollback with a flag left from an earlier failure: the resumed rollback is
    // the running job, and a probe now could see the web half way through its swap.
    writeFileSync(
      join(dir, "status.json"),
      JSON.stringify({ phase: "verifying", targetTag: "v2026.10.02", fromCommit: "c".repeat(40), startedAt: "x", finishedAt: null, message: "", logTail: "", needsManualRecovery: true }),
    );
    let release = () => {};
    const blocked = new Promise((resolve) => (release = resolve));
    let probes = 0;
    const updater = createUpdater({
      stateDir: dir,
      runUpdate: () => blocked.then(() => 20),
      acquisitionsRunning: async () => false,
      sleep: async () => {},
      now: () => "2026-10-02T20:00:00.000Z",
      waitPollMs: 1,
      waitLimitMs: 1000,
      repoCommit: () => "a".repeat(40),
      servingCommit: async () => {
        probes += 1;
        return "a".repeat(40);
      },
    });
    await updater.recheckRecovery();
    expect(probes).toBe(0);
    expect(updater.status().needsManualRecovery).toBe(true);
    release();
    await updater.idle();
  });

  it("a recheck asks the web nothing when no recovery flag is set", async () => {
    let probes = 0;
    const dir = mkdtempSync(join(tmpdir(), "updater-"));
    const updater = createUpdater({
      stateDir: dir,
      runUpdate: () => Promise.resolve(0),
      acquisitionsRunning: async () => false,
      sleep: async () => {},
      now: () => "2026-10-02T20:00:00.000Z",
      waitPollMs: 1,
      waitLimitMs: 1000,
      repoCommit: () => "a".repeat(40),
      servingCommit: async () => {
        probes += 1;
        return "a".repeat(40);
      },
    });
    await updater.recheckRecovery();
    expect(probes).toBe(0);
  });

  it("two rechecks at once ask the web once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "updater-"));
    writeFileSync(
      join(dir, "status.json"),
      JSON.stringify({ phase: "failed", targetTag: "v2026.10.02", fromCommit: null, startedAt: "x", finishedAt: "y", message: "", logTail: "", needsManualRecovery: true }),
    );
    let probes = 0;
    let answer = (_commit) => {};
    const answered = new Promise((resolve) => (answer = resolve));
    const updater = createUpdater({
      stateDir: dir,
      runUpdate: () => Promise.resolve(0),
      acquisitionsRunning: async () => false,
      sleep: async () => {},
      now: () => "2026-10-02T20:00:00.000Z",
      waitPollMs: 1,
      waitLimitMs: 1000,
      repoCommit: () => "a".repeat(40),
      servingCommit: async () => {
        probes += 1;
        return answered;
      },
    });
    const first = updater.recheckRecovery();
    const second = updater.recheckRecovery();
    answer("a".repeat(40));
    await Promise.all([first, second]);
    expect(probes).toBe(1);
    expect(updater.status().needsManualRecovery).toBeUndefined();
  });

  it("marks a resumed rollback that fails as needing a person too", async () => {
    const dir = mkdtempSync(join(tmpdir(), "updater-"));
    writeFileSync(
      join(dir, "status.json"),
      JSON.stringify({ phase: "verifying", targetTag: "v2026.10.02", fromCommit: "c".repeat(40), startedAt: "x", finishedAt: null, message: "", logTail: "" }),
    );
    const updater = createUpdater({
      stateDir: dir,
      runUpdate: () => Promise.resolve(20),
      acquisitionsRunning: async () => false,
      sleep: async () => {},
      now: () => "2026-10-02T20:00:00.000Z",
      waitPollMs: 1,
      waitLimitMs: 1000,
      repoCommit: () => "a".repeat(40),
      servingCommit: async () => null,
    });
    await updater.idle();
    expect(updater.status().needsManualRecovery).toBe(true);
    expect(updater.start("v2026.10.03")).toEqual({ accepted: false, reason: "needs_recovery" });
  });

  it("answers 409 needs_recovery over HTTP", async () => {
    const dir = mkdtempSync(join(tmpdir(), "updater-"));
    writeFileSync(
      join(dir, "status.json"),
      JSON.stringify({ phase: "failed", targetTag: "v2026.10.02", fromCommit: null, startedAt: "x", finishedAt: "y", message: "", logTail: "", needsManualRecovery: true }),
    );
    const updater = createUpdater({
      stateDir: dir,
      runUpdate: () => Promise.resolve(0),
      acquisitionsRunning: async () => false,
      sleep: async () => {},
      now: () => "2026-10-02T20:00:00.000Z",
      waitPollMs: 1,
      waitLimitMs: 1000,
      repoCommit: () => "a".repeat(40),
      servingCommit: async () => null,
    });
    const handler = createUpdaterHttp(updater, "t0k3n");
    const req = new PassThrough();
    req.method = "POST";
    req.url = "/update";
    req.headers = { authorization: "Bearer t0k3n" };
    const res = { code: 0, body: "", writeHead(code) { this.code = code; return this; }, end(body) { this.body = body ?? ""; this.done?.(); } };
    const done = new Promise((resolve) => (res.done = resolve));
    handler(req, res);
    req.end(JSON.stringify({ tag: "v2026.10.03" }));
    await done;
    expect(res.code).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ accepted: false, reason: "needs_recovery" });
  });

  it("keeps the saved log tail through a restart recovery, and starts it over for a new update", async () => {
    const dir = mkdtempSync(join(tmpdir(), "updater-"));
    writeFileSync(
      join(dir, "status.json"),
      JSON.stringify({
        phase: "verifying",
        targetTag: "v2026.10.02",
        fromCommit: "c".repeat(40),
        startedAt: "x",
        finishedAt: null,
        message: "",
        logTail: "==> STEP building\n==> STEP switching\n==> STEP verifying",
      }),
    );
    const updater = createUpdater({
      stateDir: dir,
      runUpdate: (args, onLine) => {
        onLine(Array.isArray(args) ? "==> ROLLED_BACK" : "==> DONE v2026.10.03");
        return Promise.resolve(Array.isArray(args) ? 10 : 0);
      },
      acquisitionsRunning: async () => false,
      sleep: async () => {},
      now: () => "2026-10-02T20:00:00.000Z",
      waitPollMs: 1,
      waitLimitMs: 1000,
      repoCommit: () => "a".repeat(40),
    });
    await updater.idle();
    expect(updater.status().logTail.split("\n")).toEqual([
      "==> STEP building",
      "==> STEP switching",
      "==> STEP verifying",
      "==> ROLLED_BACK",
    ]);
    updater.start("v2026.10.03");
    await updater.idle();
    expect(updater.status().logTail).toBe("==> DONE v2026.10.03");
  });

  it("writes status.json atomically, leaving no temp file behind", async () => {
    const { updater, dir } = make();
    updater.start("v2026.10.02");
    await updater.idle();
    expect(readdirSync(dir).sort()).toEqual(["status.json"]);
  });

  it("maps exit 40 (could not pause new tasks) to a failed update that says nothing was swapped", async () => {
    const { updater } = make({ runUpdate: fakeRunner(["==> HOLD_FAILED"], 40) });
    updater.start("v2026.10.02");
    await updater.idle();
    expect(updater.status()).toMatchObject({
      phase: "failed",
      message: "替换前没能让网页暂停开始新任务，这次先不更新了，原来的版本一直在运行。",
    });
  });

  it("keeps a finished status across a restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "updater-"));
    writeFileSync(
      join(dir, "status.json"),
      JSON.stringify({
        phase: "done",
        targetTag: "v2026.10.02",
        fromCommit: null,
        startedAt: "2026-10-02T19:00:00.000Z",
        finishedAt: "2026-10-02T19:10:00.000Z",
        message: "更新完成。",
        logTail: "",
      }),
    );
    const updater = createUpdater({
      stateDir: dir,
      runUpdate: fakeRunner([], 0),
      acquisitionsRunning: async () => false,
      sleep: async () => {},
      now: () => "2026-10-02T20:00:00.000Z",
      waitPollMs: 1,
      waitLimitMs: 1000,
      repoCommit: () => null,
    });
    expect(updater.status().phase).toBe("done");
    expect(updater.status().message).toBe("更新完成。");
  });

  it("keeps waiting through failed and unparsable busy answers, logging each once, then updates", async () => {
    const replies = [
      { status: 500, body: "nope" },
      { status: 500, body: "nope" },
      { status: 200, body: "<html>login</html>" },
      { status: 0, body: "" },
      { status: 200, body: '{"busy":false}' },
    ];
    let n = 0;
    let started = false;
    const { updater } = make({
      acquisitionsRunning: async () => replies[n++],
      runUpdate: (_tag, onLine) => {
        started = true;
        onLine("==> DONE v2026.10.02");
        return Promise.resolve(0);
      },
    });
    updater.start("v2026.10.02");
    await updater.idle();
    expect(n).toBe(5);
    expect(started).toBe(true);
    expect(updater.status().phase).toBe("done");
    const checks = updater.status().logTail.split("\n").filter((line) => line.startsWith("==> BUSY_CHECK"));
    expect(checks).toEqual(["==> BUSY_CHECK http 500", "==> BUSY_CHECK unparsable", "==> BUSY_CHECK unreachable"]);
  });

  it("gives up with a web-service message when the probe never works", async () => {
    let started = false;
    const { updater } = make({
      acquisitionsRunning: async () => ({ status: 0, body: "" }),
      waitLimitMs: 0,
      runUpdate: () => {
        started = true;
        return Promise.resolve(0);
      },
    });
    updater.start("v2026.10.02");
    await updater.idle();
    expect(started).toBe(false);
    expect(updater.status()).toMatchObject({ phase: "failed", message: "连不上网页服务，这次先不更新了。" });
  });

  it("gives up with the busy message when the web keeps saying busy", async () => {
    const { updater } = make({ acquisitionsRunning: async () => ({ status: 200, body: '{"busy":true}' }), waitLimitMs: 0 });
    updater.start("v2026.10.02");
    await updater.idle();
    expect(updater.status()).toMatchObject({ phase: "failed", message: "有任务一直没结束，这次先不更新了。" });
  });
});

describe("interpretBusyResponse", () => {
  it("trusts only a 200 JSON boolean; everything else counts as busy and is logged", () => {
    expect(interpretBusyResponse(200, '{"busy":true}')).toEqual({ busy: true, failed: false });
    expect(interpretBusyResponse(200, '{"busy":false}')).toEqual({ busy: false, failed: false });
    expect(interpretBusyResponse(401, '{"busy":false}')).toMatchObject({ busy: true, failed: true, log: "==> BUSY_CHECK http 401" });
    expect(interpretBusyResponse(302, "")).toMatchObject({ busy: true, failed: true, log: "==> BUSY_CHECK http 302" });
    expect(interpretBusyResponse(200, '<html>{"busy":false}')).toMatchObject({ busy: true, failed: true, log: "==> BUSY_CHECK unparsable" });
    expect(interpretBusyResponse(200, '{"busy":"no"}')).toMatchObject({ busy: true, failed: true });
    expect(interpretBusyResponse(0, "")).toMatchObject({ busy: true, failed: true, log: "==> BUSY_CHECK unreachable" });
  });
});

describe("readLimitedBody", () => {
  it("rejects once the running total passes the cap, even when each chunk is smaller", async () => {
    const stream = new PassThrough();
    const pending = readLimitedBody(stream, 1024);
    stream.write(Buffer.alloc(600, 0x61));
    stream.write(Buffer.alloc(600, 0x62));
    stream.end();
    await expect(pending).resolves.toEqual({ error: "too_big" });
  });

  it("returns a body that fits", async () => {
    const stream = new PassThrough();
    const pending = readLimitedBody(stream, 1024);
    stream.end('{"tag":"v2026.10.02"}');
    await expect(pending).resolves.toEqual({ body: '{"tag":"v2026.10.02"}' });
  });
});

describe("updater http", () => {
  it("rejects a missing or wrong token, including one of a different length", async () => {
    const { updater } = make();
    await withServer(updater, "t0k3n", async (port) => {
      expect((await call(port, { method: "GET", path: "/status" })).status).toBe(401);
      expect((await call(port, { method: "GET", path: "/status", token: "nope" })).status).toBe(401);
      expect((await call(port, { method: "GET", path: "/status", token: "t0k3n-longer" })).status).toBe(401);
      const ok = await call(port, { method: "GET", path: "/status", token: "t0k3n" });
      expect(ok.status).toBe(200);
      expect(JSON.parse(ok.body).repoCommit).toBe("a".repeat(40));
    });
  });

  it("does not start an update when the POST body exceeds the cap", async () => {
    let runs = 0;
    const { updater } = make({
      runUpdate: () => {
        runs += 1;
        return Promise.resolve(0);
      },
    });
    const body = JSON.stringify({ tag: "v2026.10.02", padding: "x".repeat(2000) });
    await withServer(updater, "t0k3n", async (port) => {
      const response = await call(port, { method: "POST", path: "/update", token: "t0k3n", body });
      expect(response.status).toBe(400);
    });
    await updater.idle();
    expect(runs).toBe(0);
    expect(updater.status().phase).toBe("idle");
  });

  it("starts an update for a release tag and refuses a second one", async () => {
    let release = () => {};
    const { updater } = make({
      // Hold the job open: a fast fake would finish before the second POST is sent.
      runUpdate: (_tag, onLine) =>
        new Promise((resolve) => {
          release = () => {
            onLine("==> STEP building");
            resolve(0);
          };
        }),
    });
    await withServer(updater, "t0k3n", async (port) => {
      const accepted = await call(port, {
        method: "POST",
        path: "/update",
        token: "t0k3n",
        body: JSON.stringify({ tag: "v2026.10.02" }),
      });
      expect(accepted.status).toBe(202);
      const again = await call(port, {
        method: "POST",
        path: "/update",
        token: "t0k3n",
        body: JSON.stringify({ tag: "v2026.10.02" }),
      });
      expect(again.status).toBe(409);
      release();
    });
    await updater.idle();
    expect(updater.status().phase).toBe("done");
  });
});
