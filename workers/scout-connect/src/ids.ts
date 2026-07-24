type RandomBytes = (size: number) => Uint8Array;

const globalGetRandomValues =
  typeof globalThis.crypto?.getRandomValues === "function"
    ? globalThis.crypto.getRandomValues.bind(globalThis.crypto)
    : undefined;

// Fallback for runtimes without WebCrypto (e.g. some vitest environments).
// Lazily imported only when needed so Workers never bundles node:crypto on
// the hot path.
const nodeRandomBytes: RandomBytes | undefined =
  globalGetRandomValues !== undefined
    ? undefined
    : await import("node:crypto")
        .then((m) => (m.randomBytes as unknown as RandomBytes))
        .catch(() => undefined);

function randomBytesSync(size: number): Uint8Array {
  if (globalGetRandomValues !== undefined) {
    return globalGetRandomValues(new Uint8Array(size));
  }
  if (nodeRandomBytes !== undefined) {
    return nodeRandomBytes(size);
  }
  throw new Error("no CSPRNG available in this runtime");
}

function randomHex(hexLength: number): string {
  const bytes = randomBytesSync(hexLength / 2);
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

export function newId(prefix: "inv" | "ep" | "aud"): string {
  return `${prefix}_${randomHex(16)}`;
}

export function newInviteCode(): string {
  return randomHex(40);
}
