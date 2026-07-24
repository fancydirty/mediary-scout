function randomHex(hexLength: number): string {
  const bytes = new Uint8Array(hexLength / 2);
  crypto.getRandomValues(bytes);
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
