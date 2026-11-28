import { randomBytes } from "node:crypto";

// 115 lixianssp + m115 (app/chrome/downurl) cipher.
// The offline-download endpoint (POST https://lixian.115.com/lixianssp/) uses
// `lixianRsaEncrypt` (request-only, deterministic for default rand key).
// The download-URL endpoint (POST https://proapi.115.com/app/chrome/downurl)
// uses `m115Encode` / `m115Decode` (faithful port of SheltonZhu/115driver
// pkg/crypto/m115 — same RSA modulus/exponent and client XOR key, plus the
// 144-byte XOR derivation table and PKCS1 RSA decrypt).

const RSA_N = BigInt(
  "0x8686980c0f5a24c4b9d43020cd2c22703ff3f450756529058b1cf88f09b8602136477198a6e2683149659bd122c33592fdb5ad47944ad1ea4d36c6b172aad6338c3bb6ac6227502d010993ac967d1aef00f0c8e038de2e4d3bc2ec368af2e9f10a6f1eda4f7262f136420c07c331b871bf139f74f3010e3c4fe57df3afb71683",
);
const RSA_E = 0x10001n;
const RSA_KEY = Uint8Array.from([0x8d, 0xa5, 0xa5, 0x8d]);
const G_KEY_L = Uint8Array.from([0x78, 0x06, 0xad, 0x4c, 0x33, 0x86, 0x5d, 0x18, 0x4c, 0x01, 0x3f, 0x46]);

const M115_XOR_KEY_SEED = Uint8Array.from([
  0xf0, 0xe5, 0x69, 0xae, 0xbf, 0xdc, 0xbf, 0x8a,
  0x1a, 0x45, 0xe8, 0xbe, 0x7d, 0xa6, 0x73, 0xb8,
  0xde, 0x8f, 0xe7, 0xc4, 0x45, 0xda, 0x86, 0xc4,
  0x9b, 0x64, 0x8b, 0x14, 0x6a, 0xb4, 0xf1, 0xaa,
  0x38, 0x01, 0x35, 0x9e, 0x26, 0x69, 0x2c, 0x86,
  0x00, 0x6b, 0x4f, 0xa5, 0x36, 0x34, 0x62, 0xa6,
  0x2a, 0x96, 0x68, 0x18, 0xf2, 0x4a, 0xfd, 0xbd,
  0x6b, 0x97, 0x8f, 0x4d, 0x8f, 0x89, 0x13, 0xb7,
  0x6c, 0x8e, 0x93, 0xed, 0x0e, 0x0d, 0x48, 0x3e,
  0xd7, 0x2f, 0x88, 0xd8, 0xfe, 0xfe, 0x7e, 0x86,
  0x50, 0x95, 0x4f, 0xd1, 0xeb, 0x83, 0x26, 0x34,
  0xdb, 0x66, 0x7b, 0x9c, 0x7e, 0x9d, 0x7a, 0x81,
  0x32, 0xea, 0xb6, 0x33, 0xde, 0x3a, 0xa9, 0x59,
  0x34, 0x66, 0x3b, 0xaa, 0xba, 0x81, 0x60, 0x48,
  0xb9, 0xd5, 0x81, 0x9c, 0xf8, 0x6c, 0x84, 0x77,
  0xff, 0x54, 0x78, 0x26, 0x5f, 0xbe, 0xe8, 0x1e,
  0x36, 0x9f, 0x34, 0x80, 0x5c, 0x45, 0x2c, 0x9b,
  0x76, 0xd5, 0x1b, 0x8f, 0xcc, 0xc3, 0xb8, 0xf5,
]);

/**
 * 115's xor: the first `len % 4` bytes xor key[:that], then `len(key)`-sized
 * chunks each xor key from the start. (The leading-partial size is mod 4
 * regardless of key length — a 115 quirk, reproduced exactly.)
 */
function xor115(src: Uint8Array, key: Uint8Array): Uint8Array {
  const out = new Uint8Array(src.length);
  const head = src.length % 4;
  for (let k = 0; k < head; k += 1) {
    out[k] = src[k]! ^ key[k]!;
  }
  for (let a = head; a < src.length; a += key.length) {
    const size = Math.min(key.length, src.length - a);
    for (let k = 0; k < size; k += 1) {
      out[a + k] = src[a + k]! ^ key[k]!;
    }
  }
  return out;
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let result = 0n;
  for (const byte of bytes) {
    result = (result << 8n) | BigInt(byte);
  }
  return result;
}

function bigIntToBytes(value: bigint, length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let remaining = value;
  for (let i = length - 1; i >= 0; i -= 1) {
    bytes[i] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return bytes;
}

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n;
  let b = base % modulus;
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) {
      result = (result * b) % modulus;
    }
    e >>= 1n;
    b = (b * b) % modulus;
  }
  return result;
}

/** 128-byte block: 0x00, (126 - len) bytes of 0x02, 0x00, then the message. */
function padPkcs1(message: Uint8Array): bigint {
  const block = new Uint8Array(128);
  const fill = 126 - message.length;
  for (let k = 0; k < fill; k += 1) {
    block[1 + k] = 0x02;
  }
  block.set(message, 2 + fill);
  return bytesToBigInt(block);
}

function rsaEncryptWithPubkey(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (let l = 0; l < data.length; l += 117) {
    const chunk = data.subarray(l, l + 117);
    const cipher = modPow(padPkcs1(chunk), RSA_E, RSA_N);
    out.push(...bigIntToBytes(cipher, 128));
  }
  return Uint8Array.from(out);
}

/** Encrypt a request body for the 115 lixianssp endpoint; returns base64. */
export function lixianRsaEncrypt(data: Uint8Array): string {
  const reversed = xor115(data, RSA_KEY).reverse();
  const xorData = new Uint8Array(16 + reversed.length);
  xorData.set(xor115(reversed, G_KEY_L), 16);
  return Buffer.from(rsaEncryptWithPubkey(xorData)).toString("base64");
}

function m115XorDeriveKey(seed: Uint8Array, size: number): Uint8Array {
  const key = new Uint8Array(size);
  for (let i = 0; i < size; i += 1) {
    key[i] = ((seed[i]! + M115_XOR_KEY_SEED[size * i]!) & 0xff) ^ M115_XOR_KEY_SEED[size * (size - i - 1)]!;
  }
  return key;
}

function padPkcs1Random(message: Uint8Array): bigint {
  const block = new Uint8Array(128);
  const padSize = 128 - message.length - 3;
  block[0] = 0x00;
  block[1] = 0x02;
  const rand = randomBytes(padSize);
  for (let i = 0; i < padSize; i += 1) {
    block[2 + i] = (rand[i]! % 0xff) + 0x01;
  }
  block[2 + padSize] = 0x00;
  block.set(message, 3 + padSize);
  return bytesToBigInt(block);
}

function m115RsaEncrypt(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (let offset = 0; offset < data.length; offset += 117) {
    const chunk = data.subarray(offset, offset + 117);
    const cipher = modPow(padPkcs1Random(chunk), RSA_E, RSA_N);
    out.push(...bigIntToBytes(cipher, 128));
  }
  return Uint8Array.from(out);
}

function m115RsaDecrypt(data: Uint8Array): Uint8Array {
  if (data.length === 0 || data.length % 128 !== 0) {
    throw new Error(`m115Decode failed: ciphertext length must be a non-zero multiple of 128, got ${data.length}`);
  }
  const out: number[] = [];
  for (let offset = 0; offset < data.length; offset += 128) {
    const chunk = data.subarray(offset, offset + 128);
    const plain = bigIntToBytes(modPow(bytesToBigInt(chunk), RSA_E, RSA_N), 128);
    // Strip leading zeros to match Go big.Int.Bytes(), then locate first 0x00 delimiter after index 0.
    let start = 0;
    while (start < plain.length && plain[start] === 0) {
      start += 1;
    }
    const blockType = plain[start];
    if (start >= plain.length - 1 || (blockType !== 0x01 && blockType !== 0x02)) {
      throw new Error("m115Decode failed: invalid PKCS#1 block header");
    }
    let delim = -1;
    for (let i = start + 1; i < plain.length; i += 1) {
      if (plain[i] === 0) {
        delim = i;
        break;
      }
    }
    if (delim < 0 || delim >= plain.length - 1) {
      throw new Error("m115Decode failed: missing PKCS#1 padding delimiter or empty block payload");
    }
    for (let j = delim + 1; j < plain.length; j += 1) {
      out.push(plain[j]!);
    }
  }
  return Uint8Array.from(out);
}

/** Generate a fresh 16-byte ephemeral key for one m115 request/response pair. */
export function m115GenerateKey(): Uint8Array {
  return Uint8Array.from(randomBytes(16));
}

/** Encode a request payload for 115's proapi `app/chrome/downurl` endpoint; returns base64. */
export function m115Encode(input: Uint8Array, key: Uint8Array): string {
  if (key.length !== 16) {
    throw new Error(`m115Encode requires a 16-byte key, got ${key.length}`);
  }
  const buf = new Uint8Array(16 + input.length);
  buf.set(key, 0);
  const step1 = xor115(input, m115XorDeriveKey(key, 4)).reverse();
  const step2 = xor115(step1, G_KEY_L);
  buf.set(step2, 16);
  return Buffer.from(m115RsaEncrypt(buf)).toString("base64");
}

/** Decode a base64 response `data` payload from 115's `app/chrome/downurl` endpoint. */
export function m115Decode(inputBase64: string, key: Uint8Array): Uint8Array {
  if (key.length !== 16) {
    throw new Error(`m115Decode requires a 16-byte key, got ${key.length}`);
  }
  const raw = Uint8Array.from(Buffer.from(inputBase64, "base64"));
  const decrypted = m115RsaDecrypt(raw);
  if (decrypted.length < 16) {
    throw new Error(`m115Decode failed: decrypted payload too short (${decrypted.length} bytes)`);
  }
  const serverKey = decrypted.subarray(0, 16);
  const body = decrypted.subarray(16);
  const step1 = xor115(body, m115XorDeriveKey(serverKey, 12)).reverse();
  return xor115(step1, m115XorDeriveKey(key, 4));
}
