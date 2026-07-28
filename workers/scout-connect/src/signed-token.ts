/**
 * HMAC 自包含签名凭据,供两处共用:魔法链接登录态、接入取件码。
 *
 * 格式:`<purpose>.<b64url(subject)>.<expiryMs>.<b64url(hmac)>`
 *
 * 为什么自包含而不落库:D1 零写入,省掉过期清理;而且 token 能无限重取
 * (决策 #10),取件码必须短命(决策 #12)——自包含的过期时间是签名的一部分,
 * 篡改即失效。
 *
 * purpose 参与签名:魔法链接(login)与取件码(claim)共用本工具,但一种
 * 凭据绝不能当另一种用——把 login token 拿去换 token 必须被拒。
 */

const encoder = new TextEncoder();

function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function b64urlEncodeStr(s: string): string {
  return b64urlEncode(encoder.encode(s));
}

function b64urlDecodeStr(s: string): string {
  const b64 = s.replaceAll("-", "+").replaceAll("_", "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

const KEY_BYTES = 32; // openssl rand -hex 32

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error("key must be even-length hex");
  }
  // 强制 32 字节:配错成更短的 secret 仍能"工作"但削弱 HMAC,且难以察觉。
  if (hex.length !== KEY_BYTES * 2) {
    throw new Error(`key must be ${KEY_BYTES} bytes (${KEY_BYTES * 2} hex chars)`);
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

async function hmac(key: string, message: string): Promise<Uint8Array> {
  const cryptoKey = await globalThis.crypto.subtle.importKey(
    "raw",
    hexToBytes(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await globalThis.crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(message));
  return new Uint8Array(sig);
}

/** 尽力常量时间比较签名。长度不等时提前返回(签名长度是公开的固定值,
 *  不构成侧信道);长度相等时不按首个失配字节短路,逐字节累积差异。
 *  JS 无法保证真常量时间(JIT 可能优化),故为尽力而为。 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export type TokenPurpose = "login" | "claim" | "magic";

export interface SignInput {
  purpose: TokenPurpose;
  subject: string;
}

export interface SignOptions {
  key: string;
  ttlMs: number;
  now?: number;
}

export async function signToken(input: SignInput, opts: SignOptions): Promise<string> {
  const now = opts.now ?? Date.now();
  const expiry = now + opts.ttlMs;
  const subjectPart = b64urlEncodeStr(input.subject);
  const signingInput = `${input.purpose}.${subjectPart}.${expiry}`;
  const sig = b64urlEncode(await hmac(opts.key, signingInput));
  return `${signingInput}.${sig}`;
}

export interface VerifyOptions {
  key: string;
  now?: number;
  expectPurpose?: TokenPurpose;
}

export type VerifyResult =
  | { ok: true; purpose: TokenPurpose; subject: string }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" | "wrong_purpose" };

export async function verifyToken(token: string, opts: VerifyOptions): Promise<VerifyResult> {
  const parts = token.split(".");
  if (parts.length !== 4) return { ok: false, reason: "malformed" };
  const [purpose, subjectPart, expiryStr, sig] = parts as [string, string, string, string];

  // 先验签,再看内容——签名不过就不信任 purpose/expiry 里的任何字节。
  const signingInput = `${purpose}.${subjectPart}.${expiryStr}`;
  const expectedSig = b64urlEncode(await hmac(opts.key, signingInput));
  if (!timingSafeEqual(sig, expectedSig)) return { ok: false, reason: "bad_signature" };

  if (opts.expectPurpose !== undefined && purpose !== opts.expectPurpose) {
    return { ok: false, reason: "wrong_purpose" };
  }
  if (purpose !== "login" && purpose !== "claim" && purpose !== "magic") {
    return { ok: false, reason: "wrong_purpose" };
  }

  const expiry = Number(expiryStr);
  const now = opts.now ?? Date.now();
  // now 非有限(调用方传了 Date.parse(坏值)=NaN)必须判过期:否则 now > expiry
  // 恒为 false,token 永不过期——fail closed。
  if (!Number.isFinite(expiry) || !Number.isFinite(now) || now > expiry) {
    return { ok: false, reason: "expired" };
  }

  return { ok: true, purpose: purpose as TokenPurpose, subject: b64urlDecodeStr(subjectPart) };
}
