import { describe, expect, it, vi } from "vitest";

import { runAction } from "./run-action";

describe("runAction", () => {
  it("成功时透传返回值，不碰 onError", async () => {
    const onError = vi.fn();
    const r = await runAction(async () => ({ saved: true }), onError);

    expect(r).toEqual({ ok: true, value: { saved: true } });
    expect(onError).not.toHaveBeenCalled();
  });

  it("抛错时返回 ok:false 并给出可读文案", async () => {
    const onError = vi.fn();
    const r = await runAction(async () => {
      throw new Error("boom");
    }, onError);

    expect(r).toEqual({ ok: false });
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("不把异常内容回显给用户", async () => {
    // 模拟真实泄露风险：DemoReadOnlyError 之类的消息里可能带内部细节。
    const onError = vi.fn();
    await runAction(async () => {
      throw new Error("PGRES: relation acct_secrets does not exist at /srv/app/db.ts:99");
    }, onError);

    const message = onError.mock.calls[0]?.[0] ?? "";
    expect(message).not.toContain("PGRES");
    expect(message).not.toContain("acct_secrets");
    expect(message).not.toContain("/srv/app");
    // 而且要是句人话，能指导下一步动作。
    expect(message).toContain("再试");
  });

  it("T = undefined 时不与失败混淆（tagged union 的存在理由）", async () => {
    const onError = vi.fn();
    // 返回 void 的 action —— 用 `T | undefined` 签名时这里会与抛错无法区分。
    const r = await runAction<void>(async () => undefined, onError);

    expect(r.ok).toBe(true);
    expect(onError).not.toHaveBeenCalled();

    // 类型层面也要能收窄：ok 为 true 时 value 可访问。
    if (r.ok) expect(r.value).toBeUndefined();
  });

  it("非 Error 抛出物（字符串、null）也能兜住", async () => {
    // Next.js 的 action 序列化失败时抛的不一定是 Error 实例。
    for (const thrown of ["plain string", null, undefined, 42]) {
      const onError = vi.fn();
      const r = await runAction(async () => {
        throw thrown;
      }, onError);

      expect(r).toEqual({ ok: false });
      expect(onError).toHaveBeenCalledTimes(1);
    }
  });

  it("同步抛出（fn 还没返回 promise 就炸）也算失败", async () => {
    const onError = vi.fn();
    const r = await runAction(() => {
      throw new Error("sync boom");
    }, onError);

    expect(r).toEqual({ ok: false });
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
