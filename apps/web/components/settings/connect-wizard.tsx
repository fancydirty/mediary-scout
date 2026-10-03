"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  connectAbandonOrderAction,
  connectAccountAction,
  connectBindAction,
  connectCheckoutAction,
  connectOrderStatusAction,
  connectPollLinkAction,
  connectProbeAction,
  connectProvisionAction,
  connectSlugCheckAction,
  connectStartLinkAction,
  connectUnlinkAction,
  type ConnectAccountView,
} from "../../app/connect-actions";
import type { TestRemoteAccessResult } from "../../app/actions";
import { copyText } from "../../lib/copy-text";

export type ConnectWizardPending = { email: string; verifyCode: string; expiresAt: string; interval?: number };

export type ConnectWizardProps = {
  linked: boolean;
  email: string | null;
  pending: ConnectWizardPending | null;
  account: ConnectAccountView | null;
  hasTunnelToken: boolean;
  /** The name this instance's tunnel serves, when known (MEDIARY_CONNECT_HOSTNAME or a binding). */
  boundHostname?: string | null;
  passwordSet: boolean | "unknown";
  multiUser?: boolean;
  compact?: boolean;
  /** A checkout this instance is still waiting on, with its payment page (kept across reloads). */
  pendingOrder?: { orderId: string; checkoutUrl: string } | null;
};

type Step = 1 | 2 | 3 | 4 | 5;

type Notice = { text: string; tone?: "danger" | "success" | "muted" };

export function connectSlugReasonText(reason: string | undefined): string {
  switch (reason) {
    case "reserved":
      return "这个名字被保留了（可能与商标冲突）";
    case "invalid":
      return "这个名字不符合规则";
    case "taken":
      return "这个名字已被占用";
    default:
      return "这个名字暂时不能用";
  }
}

/** Delay before the next link poll: Connect's interval (seconds, 3 when missing or odd),
 *  two seconds slower after each slow_down, never more than ten seconds. */
export function nextLinkPollDelayMs(currentMs: number, intervalSec: number | undefined, slowDown: boolean): number {
  const base =
    typeof intervalSec === "number" && Number.isFinite(intervalSec) && intervalSec > 0
      ? Math.min(Math.max(intervalSec * 1_000, 1_000), 10_000)
      : 3_000;
  return slowDown ? Math.min(Math.max(currentMs, base) + 2_000, 10_000) : base;
}

/**
 * Whether this instance's tunnel serves the account's name. A token alone only says some tunnel
 * is set up: after 断开 and linking another account it still serves the old name. An instance
 * that does not know its hostname (connected by an older connect.sh) is trusted as before.
 */
function tunnelServesAccount(account: ConnectAccountView, hasTunnelToken: boolean, boundHostname: string | null | undefined): boolean {
  if (!hasTunnelToken || account.endpoint === null) return false;
  return !boundHostname || boundHostname === account.endpoint.hostname;
}

/** Where a linked instance continues, from the account it just read. An account that already
 *  paid and picked a name on the website goes straight to connecting. */
export function stepForAccount(
  account: ConnectAccountView,
  hasTunnelToken: boolean,
  boundHostname?: string | null,
): Step {
  if (!account.active) return 3;
  if (!account.endpoint) return 4;
  return tunnelServesAccount(account, hasTunnelToken, boundHostname) ? 3 : 5;
}

/**
 * Where a confirmed payment leads. It is a renewal only when this instance's tunnel already
 * serves the account's name; otherwise (no name yet, or the tunnel serves another account's
 * name) the wizard goes on to pick a name or to 接入.
 */
export function paymentOutcome(
  account: ConnectAccountView,
  hasTunnelToken: boolean,
  boundHostname?: string | null,
): { step: Step; renewal: boolean } {
  return {
    step: stepForAccount(account, hasTunnelToken, boundHostname),
    renewal: tunnelServesAccount(account, hasTunnelToken, boundHostname),
  };
}

/** Expiry in China time, like the rest of the app: the server (often UTC in Docker) and the
 *  browser must render the same text, or hydration mismatches and the time jumps. */
function formatExpiry(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

function initialStep(props: ConnectWizardProps): Step {
  if (!props.linked) return props.pending ? 2 : 1;
  if (!props.account) return 3;
  return stepForAccount(props.account, props.hasTunnelToken, props.boundHostname);
}

function friendlyError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (!message || /HTTP\s*\d{3}|(?:no_updater|invalid_input|pull_failed|compose_failed|at_capacity|unauthorized|rate_limited)/i.test(message)) {
    return "操作没完成，请稍后再试。";
  }
  return message;
}

export function ConnectWizard(props: ConnectWizardProps) {
  const router = useRouter();
  const [step, setStep] = useState<Step>(() => initialStep(props));
  const [linked, setLinked] = useState(props.linked);
  const [email, setEmail] = useState(props.email ?? props.pending?.email ?? "");
  const [pending, setPending] = useState(props.pending);
  const [account, setAccount] = useState<ConnectAccountView | null>(props.account);
  const [accountUnavailable, setAccountUnavailable] = useState(props.linked && props.account === null);
  const [passwordSet, setPasswordSet] = useState(props.passwordSet);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, startTransition] = useTransition();
  const [slug, setSlug] = useState("");
  const [slugCheck, setSlugCheck] = useState<{ available: boolean; reason?: string; suggestions: string[] } | null>(null);
  const [order, setOrder] = useState<{ orderId: string; checkoutUrl: string } | null>(props.pendingOrder ?? null);
  const orderId = order?.orderId ?? null;
  const [tunnelStarting, setTunnelStarting] = useState(false);
  const [fallbackCommand, setFallbackCommand] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const probeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Bumped by every new probe loop and on unmount: a probe answering for an older loop (or after
  // the page was left) stops instead of scheduling another one.
  const probeGeneration = useRef(0);

  useEffect(() => {
    setLinked(props.linked);
    setPending(props.pending);
    setEmail(props.email ?? props.pending?.email ?? "");
    setAccount(props.account);
    setAccountUnavailable(props.linked && props.account === null);
    setPasswordSet(props.passwordSet);
    setStep(initialStep(props));
    setOrder(props.pendingOrder ?? null);
  }, [props.linked, props.email, props.pending, props.account, props.hasTunnelToken, props.boundHostname, props.passwordSet, props.pendingOrder]);

  useEffect(() => {
    if (step !== 2 || !pending) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let delay = nextLinkPollDelayMs(3_000, pending.interval, false);
    // Next poll only after this one answered (no overlap), slower after slow_down.
    const poll = async () => {
      let slowDown = false;
      try {
        const result = await connectPollLinkAction();
        if (stopped) return;
        if (result.state === "linked") {
          setLinked(true);
          setPending(null);
          setNotice({ text: "已连接 Mediary Connect。", tone: "success" });
          try {
            const accountResult = await connectAccountAction();
            if (accountResult.state === "linked") {
              setAccount(accountResult.account);
              setAccountUnavailable(false);
              setStep(stepForAccount(accountResult.account, props.hasTunnelToken, props.boundHostname));
            } else if (accountResult.state === "unlinked") {
              setLinked(false);
              setStep(1);
              setAccountUnavailable(false);
            } else {
              setAccountUnavailable(true);
              setStep(3);
            }
          } catch (error) {
            setAccountUnavailable(true);
            setStep(3);
            setNotice({ text: friendlyError(error), tone: "danger" });
          }
          return;
        } else if (result.state === "expired") {
          setPending(null);
          setStep(1);
          setNotice({ text: "确认邮件已失效，请重新发送。", tone: "danger" });
          return;
        } else if (result.state === "slow_down") {
          slowDown = true;
        } else if (result.state === "none") {
          // Nothing pending any more: another tab (or this page before a refresh) already took
          // the approval, or the request was cleared. Stop polling and follow the account.
          setPending(null);
          const accountResult = await connectAccountAction();
          if (accountResult.state === "linked") {
            setLinked(true);
            setAccount(accountResult.account);
            setAccountUnavailable(false);
            setStep(stepForAccount(accountResult.account, props.hasTunnelToken, props.boundHostname));
          } else {
            setStep(1);
          }
          return;
        } else if (result.state === "error") {
          setNotice({ text: result.message, tone: "danger" });
        }
      } catch (error) {
        if (!stopped) setNotice({ text: friendlyError(error), tone: "danger" });
      }
      if (stopped) return;
      delay = nextLinkPollDelayMs(delay, pending.interval, slowDown);
      timer = setTimeout(() => void poll(), delay);
    };
    void poll();
    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [step, pending]);

  useEffect(() => {
    // Any step: a reload restores a paid-but-unconfirmed order, and checking it is also what
    // lets Connect settle it when its webhook did not arrive.
    if (!orderId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Set once the order is fulfilled or closed: no further polls.
    let settling = false;
    const poll = async () => {
      try {
        const result = await connectOrderStatusAction(orderId);
        if (stopped) return;
        if (!result.ok && "unlinked" in result) {
          // Connect no longer accepts this instance's credential; the action forgot it and the order.
          settling = true;
          setOrder(null);
          setLinked(false);
          setAccount(null);
          setAccountUnavailable(false);
          setStep(1);
          setNotice({ text: result.message, tone: "danger" });
        } else if (!result.ok) {
          // Keep polling: a passing network error must not strand a paid order.
          setNotice({ text: result.message, tone: "danger" });
        } else if (result.status === "fulfilled") {
          // Read the account before clearing orderId: clearing it re-runs this effect, and the
          // cleanup's `stopped` would drop every update below (the wizard then sat on step 3).
          // Settled only once the read came back: if it throws, the next poll tries again.
          const accountResult = await connectAccountAction();
          if (stopped) return;
          settling = true;
          setOrder(null);
          if (accountResult.state === "linked") {
            setAccount(accountResult.account);
            setAccountUnavailable(false);
            const outcome = paymentOutcome(accountResult.account, props.hasTunnelToken, props.boundHostname);
            setStep(outcome.step);
            setNotice(
              outcome.renewal
                ? {
                    text: `续期成功，新的到期时间：${accountResult.account.expiresAt ? formatExpiry(accountResult.account.expiresAt) : "待确认"}`,
                    tone: "success",
                  }
                : { text: "付款已确认。", tone: "success" },
            );
          } else if (accountResult.state === "unlinked") {
            setLinked(false);
            setAccount(null);
            setAccountUnavailable(false);
            setStep(1);
            setNotice({ text: "Mediary Connect 连接已失效，请重新连接。", tone: "danger" });
          } else {
            setAccountUnavailable(true);
            setNotice({ text: "暂时读不到 Mediary Connect 账号信息。", tone: "danger" });
          }
        } else if (["closed", "expired"].includes(result.status)) {
          settling = true;
          setOrder(null);
          setNotice({ text: "这笔订单已关闭，请重新选择时长。", tone: "danger" });
        }
      } catch (error) {
        if (!stopped) setNotice({ text: friendlyError(error), tone: "danger" });
      }
      if (stopped || settling) return;
      timer = setTimeout(() => void poll(), 3_000);
    };
    void poll();
    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [orderId, step]);

  useEffect(() => {
    if (step !== 4) {
      setSlugCheck(null);
      return;
    }
    const normalized = slug.trim().toLowerCase();
    if (!normalized) {
      setSlugCheck(null);
      return;
    }
    let stopped = false;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const result = await connectSlugCheckAction(normalized);
          if (stopped) return;
          if (result.ok) {
            setSlugCheck(result.available ? { available: true, suggestions: [] } : { available: false, reason: result.reason ?? "暂不可用", suggestions: result.suggestions ?? [] });
          } else {
            setSlugCheck(null);
          }
          if (!result.ok) setNotice({ text: result.message, tone: "danger" });
        } catch (error) {
          if (!stopped) setNotice({ text: friendlyError(error), tone: "danger" });
        }
      })();
    }, 400);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [slug, step]);

  useEffect(() => () => {
    probeGeneration.current += 1;
    if (probeTimer.current) clearTimeout(probeTimer.current);
  }, []);

  const tiers = useMemo(() => account?.tiers ?? [], [account]);

  const retryAccount = () => {
    setNotice(null);
    startTransition(async () => {
      try {
        const result = await connectAccountAction();
        if (result.state === "unlinked") {
          setLinked(false);
          setAccount(null);
          setAccountUnavailable(false);
          setStep(1);
          setNotice({ text: "Mediary Connect 连接已失效，请重新连接。", tone: "danger" });
          return;
        }
        if (result.state !== "linked") {
          setAccountUnavailable(true);
          setNotice({ text: result.state === "error" ? result.message : "暂时读不到 Mediary Connect 账号信息。", tone: "danger" });
          return;
        }
        setAccount(result.account);
        setAccountUnavailable(false);
        setStep(stepForAccount(result.account, props.hasTunnelToken, props.boundHostname));
      } catch (error) {
        setAccountUnavailable(true);
        setNotice({ text: friendlyError(error), tone: "danger" });
      }
    });
  };

  const sendLink = () => {
    setNotice(null);
    startTransition(async () => {
      try {
        const result = await connectStartLinkAction(email);
        if (!result.ok) {
          setNotice({ text: result.message, tone: "danger" });
          return;
        }
        setEmail(result.email);
        setPending({ email: result.email, verifyCode: result.verifyCode, expiresAt: "", interval: result.interval });
        setStep(2);
      } catch (error) {
        setNotice({ text: friendlyError(error), tone: "danger" });
      }
    });
  };

  const buy = (tier: "quarter" | "year" | "two_years") => {
    const popup = window.open("about:blank", "mediary-connect-checkout");
    setNotice(null);
    startTransition(async () => {
      try {
        const result = await connectCheckoutAction(tier);
        if (!result.ok) {
          popup?.close();
          setNotice({ text: result.message, tone: "danger" });
          return;
        }
        if (popup) {
          popup.opener = null;
          popup.location.href = result.checkoutUrl;
          setNotice({ text: "已打开微信支付页面，付款完成后这里会自动继续。", tone: "muted" });
        } else {
          setNotice({ text: "浏览器拦截了新窗口，请点击下面的链接完成支付。", tone: "danger" });
        }
        setOrder({ orderId: result.orderId, checkoutUrl: result.checkoutUrl });
      } catch (error) {
        popup?.close();
        setNotice({ text: friendlyError(error), tone: "danger" });
      }
    });
  };

  const provision = () => {
    const normalized = slug.trim().toLowerCase();
    if (!slugCheck?.available || !normalized) return;
    startTransition(async () => {
      try {
        const result = await connectProvisionAction(normalized);
        if (!result.ok) {
          setNotice({ text: result.reason === "slug_taken" ? "刚被别人抢先占用了，换一个吧。" : result.message, tone: "danger" });
          return;
        }
        setAccount((current) => current ? { ...current, endpoint: { slug: normalized, hostname: result.hostname, status: "active" } } : current);
        setStep(5);
        setNotice({ text: `已选好名字：${result.hostname}`, tone: "success" });
      } catch (error) {
        setNotice({ text: friendlyError(error), tone: "danger" });
      }
    });
  };

  const setAccessPassword = () => {
    setNotice(null);
    startTransition(async () => {
      try {
        const response = await fetch("/api/auth/password", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ password }),
        });
        const body = (await response.json().catch(() => ({}))) as { error?: string; passwordSet?: boolean };
        if (!response.ok || body.passwordSet !== true) {
          setNotice({ text: body.error || "设置密码失败，请在局域网里重试。", tone: "danger" });
          return;
        }
        setPassword("");
        setPasswordSet(true);
        setNotice({ text: "门禁密码已设置。", tone: "success" });
      } catch (error) {
        setNotice({ text: friendlyError(error), tone: "danger" });
      }
    });
  };

  const probeUntilReachable = () => {
    if (probeTimer.current) clearTimeout(probeTimer.current);
    const generation = ++probeGeneration.current;
    const startedAt = Date.now();
    // Each probe can take seconds; schedule the next one only after this one answered.
    const probe = async () => {
      try {
        const result: TestRemoteAccessResult = await connectProbeAction();
        if (generation !== probeGeneration.current) return;
        if (result.ok && result.detail === "reachable") {
          setTunnelStarting(false);
          setNotice({ text: `已接通 https://${account?.endpoint?.hostname ?? ""}`, tone: "success" });
          router.refresh();
          return;
        }
      } catch (error) {
        if (generation !== probeGeneration.current) return;
        setNotice({ text: friendlyError(error), tone: "danger" });
      }
      if (Date.now() - startedAt >= 120_000) {
        setTunnelStarting(false);
        setNotice({ text: "隧道还没有响应，请稍后点击重新接入。", tone: "danger" });
        return;
      }
      probeTimer.current = setTimeout(() => void probe(), 5_000);
    };
    void probe();
  };

  const bind = () => {
    setNotice(null);
    setFallbackCommand(null);
    setTunnelStarting(true);
    startTransition(async () => {
      try {
        const result = await connectBindAction();
        if (!result.ok) {
          setTunnelStarting(false);
          if (result.reason === "no_updater") {
            setFallbackCommand(result.command ?? null);
            setNotice(null);
          } else {
            setNotice({ text: result.message || (result.reason === "password_required" ? "请先设置访问密码。" : "接入没有完成。"), tone: "danger" });
          }
          return;
        }
        setNotice({ text: "正在启动隧道…", tone: "muted" });
        probeUntilReachable();
      } catch (error) {
        setTunnelStarting(false);
        setNotice({ text: friendlyError(error), tone: "danger" });
      }
    });
  };

  const abandonOrder = () => {
    if (!order) return;
    const abandoned = order.orderId;
    startTransition(async () => {
      try {
        const result = await connectAbandonOrderAction(abandoned);
        if (!result.ok) {
          setNotice({ text: result.message, tone: "danger" });
          return;
        }
        setOrder((current) => (current?.orderId === abandoned ? null : current));
        setNotice({ text: "已不再等待这笔订单，可以重新选择时长。", tone: "muted" });
      } catch (error) {
        setNotice({ text: friendlyError(error), tone: "danger" });
      }
    });
  };

  const unlink = () => {
    startTransition(async () => {
      try {
        const result = await connectUnlinkAction();
        if (!result.ok) {
          setNotice({ text: result.message, tone: "danger" });
          return;
        }
        setLinked(false);
        setPending(null);
        setAccount(null);
        setAccountUnavailable(false);
        // The order belonged to the account just unlinked: stop waiting for it.
        setOrder(null);
        setStep(1);
        setNotice({ text: "已断开 Mediary Connect。", tone: "success" });
      } catch (error) {
        setNotice({ text: friendlyError(error), tone: "danger" });
      }
    });
  };

  const stepTitle = ["未连接", "等你确认", "选时长", "选名字", "接入"][step - 1];
  return (
    <div style={{ marginTop: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
        <strong>{props.compact ? "Mediary Connect" : stepTitle}</strong>
        {!props.compact ? <span className="panel-note">第 {step} 步，共 5 步</span> : null}
        {linked ? <button type="button" className="ghost-button" onClick={unlink} disabled={busy}>断开</button> : null}
      </div>

      {step === 1 ? (
        <form onSubmit={(event) => { event.preventDefault(); sendLink(); }} style={{ maxWidth: 420 }}>
          <p className="panel-note">{props.compact
            ? "用开通时的邮箱连上 Mediary Connect 账号，就能在这里续期、重新接入。我们会发一封确认邮件，点邮件里的「确认连接」即可。"
            : "输入邮箱，我们会发一封确认邮件。点击邮件里的「确认连接」后，这台实例就会和你的 Mediary Connect 账号关联。"}</p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input className="setting-control" type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="你的邮箱" aria-label="邮箱" required />
            <button className="primary-button" type="submit" disabled={busy || !email.trim()}>发送确认邮件</button>
          </div>
        </form>
      ) : null}

      {step === 2 && pending ? (
        <div>
          <p className="panel-note">我们给 <strong>{pending.email}</strong> 发了一封邮件。在任何设备上打开邮件点「确认连接」，这里会自动继续。</p>
          <p style={{ margin: "8px 0", fontSize: "1.25rem", fontWeight: 700 }}>确认码：{pending.verifyCode}</p>
          <p className="panel-note">30 分钟内有效。</p>
          <p className="panel-note">如果不是你刚在这台实例里发起的，请忽略这封邮件。</p>
        </div>
      ) : null}

      {step === 3 ? (
        <div>
          {accountUnavailable ? (
            <div>
              <p className="panel-note" role="status">暂时读不到 Mediary Connect 账号信息。</p>
              <button type="button" className="secondary-button" onClick={retryAccount} disabled={busy}>重试</button>
            </div>
          ) : <>
          <p className="panel-note">{account?.expiresAt ? `当前到期时间：${formatExpiry(account.expiresAt)}` : "选择一段使用时长，付款后继续。"}</p>
          {!account?.checkoutOpen ? <p className="panel-note" role="status">现在暂时不能购买，请稍后再试。</p> : null}
          <div style={{ display: "grid", gap: 8 }}>
            {tiers.map((tier) => (
              <div key={tier.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, border: "1px solid var(--border)", borderRadius: 8, padding: "10px 12px" }}>
                <span><strong>{tier.label}</strong><span className="panel-note"> · {tier.months} 个月 · ¥{tier.price.replace(/\.00$/, "")}</span>{tier.featured ? <span className="hub-badge tone-green" style={{ marginLeft: 8 }}>推荐</span> : null}</span>
                <button className="primary-button" type="button" onClick={() => buy(tier.id)} disabled={busy || !account?.checkoutOpen || order !== null}>微信支付</button>
              </div>
            ))}
          </div>
          {props.compact && account?.endpoint ? (
            <button type="button" className="secondary-button" style={{ marginTop: 10 }} onClick={() => setStep(5)} disabled={busy}>
              重新接入
            </button>
          ) : null}
          {order ? (
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginTop: 10 }}>
              <p className="panel-note" role="status" style={{ margin: 0 }}>
                等待支付结果…{" "}
                <a href={order.checkoutUrl} target="_blank" rel="noopener noreferrer">打开微信支付页面</a>
              </p>
              <button type="button" className="ghost-button" onClick={abandonOrder} disabled={busy}>不付了</button>
            </div>
          ) : null}
          </>}
        </div>
      ) : null}

      {step === 4 ? (
        <div style={{ maxWidth: 500 }}>
          <p className="panel-note">给这台实例选一个专属名字，最终地址是「名字.mediaryconnect.app」。</p>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input className="setting-control" value={slug} onChange={(event) => setSlug(event.target.value)} placeholder="例如 family" aria-label="专属名字" />
            <span className="panel-note">.mediaryconnect.app</span>
          </div>
          <p className="panel-note">小写字母、数字、连字符；不以连字符开头或结尾；1 到 32 个字符</p>
          <p className="panel-note">选定后不可更改、永久保留（到期也不会被别人拿走）。</p>
          {slugCheck ? <p className="panel-note" role="status" style={{ color: slugCheck.available ? "var(--accent)" : "var(--danger, #e5484d)" }}>{slugCheck.available ? "这个名字可以用。" : connectSlugReasonText(slugCheck.reason)}</p> : null}
          {slugCheck?.suggestions?.length ? <p className="panel-note">可以试试：{slugCheck.suggestions.join("、")}</p> : null}
          <button className="primary-button" type="button" onClick={provision} disabled={busy || !slugCheck?.available}>确定</button>
        </div>
      ) : null}

      {step === 5 ? (
        <div style={{ maxWidth: 520 }}>
          {!props.multiUser && passwordSet === "unknown" ? (
            // A failed read is not "no password": do not offer first-time setup, but keep 接入 off.
            <p className="panel-note" role="status" style={{ marginBottom: 12 }}>
              暂时读不到访问密码的状态（数据库读取失败），请稍后刷新页面再接入。
            </p>
          ) : null}
          {!props.multiUser && passwordSet === false ? (
            <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 12, marginBottom: 12 }}>
              <strong>先设置访问密码</strong>
              <p className="panel-note">远程访问的门禁就是这个密码。第一次设置请在局域网里完成。</p>
              <form onSubmit={(event) => { event.preventDefault(); setAccessPassword(); }} style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <input className="setting-control" type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="至少 6 位" aria-label="访问密码" minLength={6} />
                <button className="secondary-button" type="submit" disabled={busy || password.length < 6}>设置密码</button>
              </form>
            </div>
          ) : null}
          <button className="primary-button" type="button" onClick={bind} disabled={busy || tunnelStarting || (!props.multiUser && passwordSet !== true)}>{tunnelStarting ? "正在启动隧道…" : props.compact ? "重新接入" : "接入"}</button>
          {fallbackCommand ? <div style={{ marginTop: 12 }}><p className="panel-note">这台机器的更新助手还不支持一键接入（或没有装）。在部署目录（有 docker-compose.yml 的那个文件夹）运行下面这条命令完成接入，15 分钟内有效：</p><pre className="update-cmd" style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{fallbackCommand}</pre><button type="button" className="secondary-button" style={{ marginTop: 8 }} onClick={() => void copyText(fallbackCommand).then((ok) => setNotice(ok ? { text: "已复制。", tone: "success" } : { text: "复制没成功，请手动选中命令复制。", tone: "danger" }))}>复制命令</button></div> : null}
        </div>
      ) : null}

      {notice ? <p className="panel-note" role="status" style={{ marginTop: 12, color: notice.tone === "danger" ? "var(--danger, #e5484d)" : notice.tone === "success" ? "var(--accent)" : undefined }}>{notice.text}</p> : null}
    </div>
  );
}
