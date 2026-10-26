import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The provider factory is the only place haisou gets mounted, and it had NO test.
// That gap is exactly how the original haisou PanSou plugin died unnoticed (it was
// configured for months and never loaded). These tests pin the mounting rule:
// present when a key exists, absent when it doesn't, and per-brand type filtering.
const ORIGINAL_ADAPTER = process.env.MEDIA_TRACK_WORKFLOW_ADAPTER;

vi.mock("./demo-mode", () => ({ isDemoMode: () => false }));

function settingsWith(entries: Record<string, string>) {
  return {
    getSetting: async (key: string) => entries[key] ?? null,
  };
}

describe("getWorkerResourceProvider — haisou mounting", () => {
  beforeEach(() => {
    process.env.MEDIA_TRACK_WORKFLOW_ADAPTER = "pansou";
    // Keep the test offline: the providers must not reach the network here.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ code: 0, data: { total: 0 } }), { status: 200 })),
    );
  });

  afterEach(() => {
    if (ORIGINAL_ADAPTER === undefined) delete process.env.MEDIA_TRACK_WORKFLOW_ADAPTER;
    else process.env.MEDIA_TRACK_WORKFLOW_ADAPTER = ORIGINAL_ADAPTER;
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("mounts haisou when an api key is configured", async () => {
    const { getWorkerResourceProvider } = await import("./workflow-runtime");
    const provider = await getWorkerResourceProvider(settingsWith({ haisou_api_key: "idr_test" }));
    // A Composite means "more than one source" — PanSou alone is returned bare.
    expect(provider.constructor.name).toBe("CompositeResourceProvider");
    const names = (provider as unknown as { providers: Array<{ name: string }> }).providers.map((p) => p.name);
    expect(names).toContain("haisou");
    expect(names).toContain("pansou");
  });

  it("leaves haisou out when no key is configured", async () => {
    const { getWorkerResourceProvider } = await import("./workflow-runtime");
    const provider = await getWorkerResourceProvider(settingsWith({}));
    const isComposite = provider.constructor.name === "CompositeResourceProvider";
    const names = isComposite
      ? (provider as unknown as { providers: Array<{ name: string }> }).providers.map((p) => p.name)
      : [];
    expect(names).not.toContain("haisou");
  });

  it("treats a blank/whitespace key as unconfigured", async () => {
    const { getWorkerResourceProvider } = await import("./workflow-runtime");
    const provider = await getWorkerResourceProvider(settingsWith({ haisou_api_key: "   " }));
    const isComposite = provider.constructor.name === "CompositeResourceProvider";
    const names = isComposite
      ? (provider as unknown as { providers: Array<{ name: string }> }).providers.map((p) => p.name)
      : [];
    expect(names).not.toContain("haisou");
  });

  it("scopes haisou to the connected drive's brands (a quark drive must not receive 115 links)", async () => {
    const { getWorkerResourceProvider } = await import("./workflow-runtime");
    const provider = await getWorkerResourceProvider(settingsWith({ haisou_api_key: "idr_test" }), "quark");
    const entries = (provider as unknown as { providers: Array<{ name: string; provider: unknown }> }).providers;
    const haisou = entries.find((e) => e.name === "haisou");
    expect(haisou).toBeDefined();
    // The allowedTypes the factory passes down must exclude 115 for a quark drive.
    // (It is a readonly array on the provider, not a Set.)
    const allowed = (haisou!.provider as unknown as { allowedTypes?: readonly string[] }).allowedTypes;
    expect(Array.isArray(allowed)).toBe(true);
    expect(allowed!.length).toBeGreaterThan(0);
    expect(allowed).not.toContain("115");
  });
});
