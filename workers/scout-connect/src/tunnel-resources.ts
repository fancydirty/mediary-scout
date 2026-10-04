import type { CfApi } from "./cf-api.js";

export interface TunnelResources {
  tunnelId: string;
  /** plaintext connector token — return value only, never persisted */
  token: string;
  recordId: string;
  /** Best-effort delete of what this call created (DNS, then tunnel). Never throws. */
  discard(): Promise<void>;
}

/**
 * Creates the Cloudflare tunnel, its ingress, and the DNS CNAME for one hostname.
 * Compensation matches provision.ts before this was extracted: a failing delete
 * never replaces the error that triggered it, and deleteTunnel runs at most once
 * after it succeeds (a failed attempt leaves the latch unset so the outer catch retries).
 */
export async function createTunnelResources(
  cf: CfApi,
  slug: string,
  hostname: string,
): Promise<TunnelResources> {
  const { tunnelId, token } = await cf.createTunnel(`scout-${slug}`);

  // Compensation invariant: deleteTunnel runs AT MOST once on any failure
  // path. The inner dns catch deletes it, then rethrows into the outer catch,
  // which must not delete it again.
  let tunnelDeleted = false;
  const deleteTunnelOnce = async (): Promise<void> => {
    if (!tunnelDeleted) {
      // Latch AFTER the await: a transient delete failure leaves the flag
      // unset so a later catch can still retry (404-idempotent = safe).
      await cf.deleteTunnel(tunnelId);
      tunnelDeleted = true;
    }
  };

  // Create tunnel ingress and DNS; no Access app.
  //
  // Compensation here is BEST EFFORT, like discard() for the caller's post-CF phase: a
  // failing deleteTunnel must never displace the failure that triggered the
  // rollback, or the caller is told "delete tunnel boom" when the real problem
  // was "cf dns boom". Note deleteTunnelOnce() latches only AFTER a successful
  // await, so a transient failure in the inner catch leaves the flag unset and
  // the outer catch retries it — deletion is 404-idempotent, so that is free.
  let recordId: string;
  try {
    await cf.putTunnelIngress(tunnelId, hostname);
    try {
      ({ recordId } = await cf.createDnsCname(slug, tunnelId));
    } catch (e) {
      try {
        await deleteTunnelOnce();
      } catch {
        // best-effort compensation — original error is what matters
      }
      throw e;
    }
  } catch (e) {
    try {
      await deleteTunnelOnce();
    } catch {
      // best-effort compensation — original error is what matters
    }
    throw e;
  }

  return {
    tunnelId,
    token,
    recordId,
    async discard() {
      try {
        await cf.deleteDnsRecord(recordId);
      } catch {
        // best-effort compensation — original error is what matters
      }
      try {
        await deleteTunnelOnce();
      } catch {
        // best-effort compensation
      }
    },
  };
}
