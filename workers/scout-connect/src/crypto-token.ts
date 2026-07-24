const IV_BYTES = 12;
const KEY_BYTES = 32;

function hexToKeyBytes(keyHex: string): Uint8Array {
  if (keyHex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(keyHex)) {
    throw new Error("key must be even-length hex");
  }
  const bytes = new Uint8Array(keyHex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(keyHex.slice(i * 2, i * 2 + 2), 16);
  }
  if (bytes.length !== KEY_BYTES) {
    throw new Error(`key must decode to exactly ${KEY_BYTES} bytes, got ${bytes.length}`);
  }
  return bytes;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const byte of bytes) {
    bin += String.fromCharCode(byte);
  }
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64UrlDecode(s: string): Uint8Array {
  const b64 = s.replaceAll("-", "+").replaceAll("_", "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

export async function sha256Hex(s: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(s),
  );
  let hex = "";
  for (const byte of new Uint8Array(digest)) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

export async function wrapToken(plain: string, keyHex: string): Promise<string> {
  const keyBytes = hexToKeyBytes(keyHex);
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    keyBytes,
    "AES-GCM",
    false,
    ["encrypt"],
  );
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await globalThis.crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plain),
  );
  const out = new Uint8Array(IV_BYTES + ciphertext.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ciphertext), IV_BYTES);
  return base64UrlEncode(out);
}

export async function unwrapToken(blob: string, keyHex: string): Promise<string> {
  const keyBytes = hexToKeyBytes(keyHex);
  const data = base64UrlDecode(blob);
  if (data.length <= IV_BYTES) {
    throw new Error("ciphertext too short");
  }
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    keyBytes,
    "AES-GCM",
    false,
    ["decrypt"],
  );
  const plain = await globalThis.crypto.subtle.decrypt(
    { name: "AES-GCM", iv: data.slice(0, IV_BYTES) },
    key,
    data.slice(IV_BYTES),
  );
  return new TextDecoder().decode(plain);
}
