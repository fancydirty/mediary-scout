import { beforeEach, describe, expect, it } from "vitest";
import {
  checkLoginAllowed,
  recordLoginFailure,
  recordLoginSuccess,
  _resetLoginThrottleForTest,
} from "./login-throttle";

const K = "owner1|1.2.3.4";
const T0 = 1_000_000;

beforeEach(() => _resetLoginThrottleForTest());

describe("login throttle", () => {
  it("allows the first attempts, then locks after 5 failures within the window", () => {
    expect(checkLoginAllowed(K, T0).allowed).toBe(true);
    for (let i = 0; i < 5; i++) {
      expect(checkLoginAllowed(K, T0).allowed).toBe(true);
      recordLoginFailure(K, T0);
    }
    const verdict = checkLoginAllowed(K, T0);
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.retryAfterSec).toBeGreaterThan(0);
  });

  it("stays locked until lockedUntil, then allows again", () => {
    for (let i = 0; i < 5; i++) recordLoginFailure(K, T0);
    expect(checkLoginAllowed(K, T0 + 1000).allowed).toBe(false); // inside 1min lock
    expect(checkLoginAllowed(K, T0 + 61_000).allowed).toBe(true); // after first lock
  });

  it("escalates lock duration for repeat offenders (exponential backoff)", () => {
    for (let i = 0; i < 5; i++) recordLoginFailure(K, T0);
    const firstLockUntil = T0 + 60_000;
    // fail again right after first lock expires → second lock should be longer (2x)
    for (let i = 0; i < 5; i++) recordLoginFailure(K, firstLockUntil);
    const v = checkLoginAllowed(K, firstLockUntil);
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.retryAfterSec).toBeGreaterThan(60); // > 1min ⇒ escalated
  });

  it("clears the bucket on successful login", () => {
    for (let i = 0; i < 4; i++) recordLoginFailure(K, T0);
    recordLoginSuccess(K);
    // after success, a fresh 5 failures are required to lock again
    for (let i = 0; i < 4; i++) recordLoginFailure(K, T0 + 1000);
    expect(checkLoginAllowed(K, T0 + 1000).allowed).toBe(true);
  });

  it("resets the failure count after the sliding window passes", () => {
    for (let i = 0; i < 4; i++) recordLoginFailure(K, T0);
    // 16 minutes later (> 15min window) — old failures no longer count
    const later = T0 + 16 * 60_000;
    recordLoginFailure(K, later);
    expect(checkLoginAllowed(K, later).allowed).toBe(true);
  });

  it("tracks keys independently", () => {
    for (let i = 0; i < 5; i++) recordLoginFailure("owner1|9.9.9.9", T0);
    expect(checkLoginAllowed("owner1|9.9.9.9", T0).allowed).toBe(false);
    expect(checkLoginAllowed("owner1|1.1.1.1", T0).allowed).toBe(true); // different ip
    expect(checkLoginAllowed("owner2|9.9.9.9", T0).allowed).toBe(true); // different user
  });
});
