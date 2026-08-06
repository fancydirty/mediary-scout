import { describe, expect, it } from "vitest";
import { classifySearchSourceFault } from "../src/acquisition-v2/search-source-fault.js";
import type { AuditEvent } from "../src/domain.js";

function refusedEvent(over: Partial<AuditEvent["data"]> = {}): AuditEvent {
  return {
    type: "no_coverage_refused_source_unhealthy",
    message: "拒绝无覆盖上报",
    data: { status: "unreachable", unhealthySources: ["自建搜索源"], snapshotCount: 2, ...over },
  };
}

describe("classifySearchSourceFault", () => {
  it("returns null with no audit events at all", () => {
    expect(classifySearchSourceFault(undefined)).toBeNull();
    expect(classifySearchSourceFault([])).toBeNull();
  });

  it("returns null for an ordinary run — a genuine absence must stay reportable", () => {
    // THE critical control. Over-classifying would mean the product can never
    // honestly say 「确实没有」 again, which is worse than the bug being fixed.
    const events: AuditEvent[] = [
      { type: "no_coverage_reported", message: "agent 上报无覆盖：搜遍了没有" },
    ];
    expect(classifySearchSourceFault(events)).toBeNull();
  });

  it("classifies a refused report as a source fault and names the source", () => {
    const fault = classifySearchSourceFault([refusedEvent()]);
    expect(fault).not.toBeNull();
    expect(fault!.sources).toEqual(["自建搜索源"]);
    expect(fault!.reason).toContain("自建搜索源");
    // Must NOT imply the resource is absent.
    expect(fault!.reason).not.toContain("暂未找到");
  });

  it("does NOT classify a lone mid-run unhealthy warning as a source fault", () => {
    // One flaky search that later succeeded is not a source outage — the agent
    // may well have found candidates afterwards. Only a refused report proves
    // the whole evidence base was unusable.
    const events: AuditEvent[] = [
      { type: "search_source_unhealthy", message: "搜索时源不健康", data: { unhealthySources: ["x"] } },
      { type: "no_coverage_reported", message: "后来搜到了但仍缺集" },
    ];
    expect(classifySearchSourceFault(events)).toBeNull();
  });

  it("gives protocol_error a different remedy than a plain outage", () => {
    const outage = classifySearchSourceFault([refusedEvent({ status: "unreachable" })]);
    const wrongThing = classifySearchSourceFault([refusedEvent({ status: "protocol_error" })]);
    expect(outage!.reason).toContain("连不上");
    expect(wrongThing!.reason).toContain("不是 PanSou");
    expect(wrongThing!.reason).not.toEqual(outage!.reason);
  });

  it("treats a mixed status as an outage (no single actionable remedy)", () => {
    const fault = classifySearchSourceFault([
      refusedEvent({ status: "protocol_error/unreachable" }),
    ]);
    expect(fault!.reason).toContain("连不上");
  });

  it("falls back to a generic name when the source list is missing", () => {
    const fault = classifySearchSourceFault([refusedEvent({ unhealthySources: [] })]);
    expect(fault!.reason).toContain("搜索源");
  });
});
