const RSA2_ALGORITHM = Object.freeze({
  name: "RSASSA-PKCS1-v1_5",
  hash: "SHA-256",
});

const RSA_ENCRYPTION_OID = new Uint8Array([
  0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01,
  0x05, 0x00,
]);

export type AlipayCryptoKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

export interface SignedAlipayParams {
  params: Record<string, string>;
  canonical: string;
}

function derLength(length: number): Uint8Array {
  if (!Number.isSafeInteger(length) || length < 0) throw new Error("invalid DER length");
  if (length < 0x80) return new Uint8Array([length]);
  const bytes: number[] = [];
  for (let value = length; value > 0; value = Math.floor(value / 256)) {
    bytes.unshift(value % 256);
  }
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

function derSequence(...parts: Uint8Array[]): Uint8Array {
  const contentLength = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const length = derLength(contentLength);
  const result = new Uint8Array(1 + length.byteLength + contentLength);
  result[0] = 0x30;
  result.set(length, 1);
  let offset = 1 + length.byteLength;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function derOctetString(bytes: Uint8Array): Uint8Array {
  const length = derLength(bytes.byteLength);
  return new Uint8Array([0x04, ...length, ...bytes]);
}

function derBitString(bytes: Uint8Array): Uint8Array {
  const length = derLength(bytes.byteLength + 1);
  return new Uint8Array([0x03, ...length, 0, ...bytes]);
}

function pkcs1PrivateToPkcs8(bytes: Uint8Array): Uint8Array {
  return derSequence(new Uint8Array([0x02, 0x01, 0x00]), RSA_ENCRYPTION_OID, derOctetString(bytes));
}

function pkcs1PublicToSpki(bytes: Uint8Array): Uint8Array {
  return derSequence(RSA_ENCRYPTION_OID, derBitString(bytes));
}

function decodeKeyText(value: string): Uint8Array {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("Alipay key is not configured");
  }
  const compact = value
    .replace(/-----BEGIN [^-]+-----|-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  if (compact === "") throw new Error("Alipay key is empty");
  try {
    const binary = atob(compact);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    throw new Error("Alipay key is not valid base64");
  }
}

export async function importAlipayPrivateKey(value: string): Promise<AlipayCryptoKey> {
  const bytes = decodeKeyText(value);
  if (/BEGIN RSA PRIVATE KEY/.test(value)) {
    return crypto.subtle.importKey(
      "pkcs8",
      pkcs1PrivateToPkcs8(bytes),
      RSA2_ALGORITHM,
      false,
      ["sign"],
    );
  }
  try {
    return await crypto.subtle.importKey("pkcs8", bytes, RSA2_ALGORITHM, false, ["sign"]);
  } catch (error) {
    if (/BEGIN PRIVATE KEY/.test(value)) throw error;
    return crypto.subtle.importKey(
      "pkcs8",
      pkcs1PrivateToPkcs8(bytes),
      RSA2_ALGORITHM,
      false,
      ["sign"],
    );
  }
}

export async function importAlipayPublicKey(value: string): Promise<AlipayCryptoKey> {
  const bytes = decodeKeyText(value);
  if (/BEGIN RSA PUBLIC KEY/.test(value)) {
    return crypto.subtle.importKey(
      "spki",
      pkcs1PublicToSpki(bytes),
      RSA2_ALGORITHM,
      false,
      ["verify"],
    );
  }
  try {
    return await crypto.subtle.importKey("spki", bytes, RSA2_ALGORITHM, false, ["verify"]);
  } catch (error) {
    if (/BEGIN PUBLIC KEY/.test(value)) throw error;
    return crypto.subtle.importKey(
      "spki",
      pkcs1PublicToSpki(bytes),
      RSA2_ALGORITHM,
      false,
      ["verify"],
    );
  }
}

function canonicalAlipayParams(
  params: Readonly<Record<string, string>>,
  includeSignType: boolean,
): string {
  return Object.entries(params)
    .filter(([key, value]) => {
      if (key === "sign") return false;
      if (!includeSignType && key === "sign_type") return false;
      return value !== "";
    })
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

function base64FromBytes(bytes: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function bytesFromBase64(value: string): Uint8Array {
  const binary = atob(value.replace(/ /g, "+"));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function recordFromParams(
  input: URLSearchParams | Readonly<Record<string, string>>,
): Record<string, string> | null {
  if (!(input instanceof URLSearchParams)) return { ...input };
  const result: Record<string, string> = {};
  for (const [key, value] of input.entries()) {
    if (Object.hasOwn(result, key)) return null;
    result[key] = value;
  }
  return result;
}

export async function signAlipayParams(
  params: Readonly<Record<string, string>>,
  privateKey: AlipayCryptoKey,
): Promise<SignedAlipayParams> {
  const unsigned: Record<string, string> = { ...params, sign_type: "RSA2" };
  delete unsigned.sign;
  const canonical = canonicalAlipayParams(unsigned, true);
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(canonical),
  );
  return {
    params: { ...unsigned, sign: base64FromBytes(signature) },
    canonical,
  };
}

export async function verifyAlipayParams(
  input: URLSearchParams | Readonly<Record<string, string>>,
  publicKey: AlipayCryptoKey,
): Promise<boolean> {
  const params = recordFromParams(input);
  if (params === null || params.sign_type !== "RSA2" || !params.sign) return false;
  try {
    const signature = bytesFromBase64(params.sign);
    for (const includeSignType of [true, false]) {
      const canonical = canonicalAlipayParams(params, includeSignType);
      if (
        await crypto.subtle.verify(
          "RSASSA-PKCS1-v1_5",
          publicKey,
          signature,
          new TextEncoder().encode(canonical),
        )
      ) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/** Verify the exact raw JSON member Alipay signs in OpenAPI responses. */
export async function verifyAlipayContent(
  content: string,
  signatureBase64: string,
  publicKey: AlipayCryptoKey,
): Promise<boolean> {
  if (content === "" || signatureBase64 === "") return false;
  try {
    return await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      publicKey,
      bytesFromBase64(signatureBase64),
      new TextEncoder().encode(content),
    );
  } catch {
    return false;
  }
}
