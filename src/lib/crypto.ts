import { createCipheriv, createDecipheriv, randomBytes, randomInt } from "node:crypto";

const PREFIX = "enc:v1:";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

function getKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) throw new Error("ENCRYPTION_KEY is not set");
  const key = Buffer.from(raw, "hex");
  if (key.length !== 32) {
    throw new Error("ENCRYPTION_KEY must be 64 hex characters (32 bytes). Generate one with: openssl rand -hex 32");
  }
  return key;
}

/** AES-256-GCM. Output: "enc:v1:" + base64(iv | authTag | ciphertext). */
export function encrypt(text: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64");
}

/**
 * Reverses encrypt(). Values without the "enc:v1:" prefix are returned as-is:
 * credentials saved before encryption existed (or typed in by an admin) are
 * plaintext and must keep displaying.
 */
export function decrypt(value: string): string {
  if (!value.startsWith(PREFIX)) return value;
  const buf = Buffer.from(value.slice(PREFIX.length), "base64");
  const iv = buf.subarray(0, IV_LENGTH);
  const tag = buf.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = buf.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv("aes-256-gcm", getKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

export function decryptNullable(value: string | null): string | null {
  return value === null ? null : decrypt(value);
}

/** Replaces sshPassword / panelPassword with their decrypted values for API responses. */
export function withDecryptedCredentials<T extends { sshPassword: string | null; panelPassword: string | null }>(
  service: T
): T {
  return {
    ...service,
    sshPassword: decryptNullable(service.sshPassword),
    panelPassword: decryptNullable(service.panelPassword),
  };
}

const LOWER = "abcdefghijkmnopqrstuvwxyz";
const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const DIGITS = "23456789";
// No quotes, backslash, $, backtick or colon, so the password is safe inside
// single-quoted shell strings and as a chpasswd "user:password" line.
const SYMBOLS = "!@#%^*-_+=";

function pick(chars: string): string {
  return chars[randomInt(chars.length)];
}

/** Cryptographically random password with at least one lower, upper, digit and symbol. */
export function generatePassword(length = 16): string {
  const all = LOWER + UPPER + DIGITS + SYMBOLS;
  const chars = [pick(LOWER), pick(UPPER), pick(DIGITS), pick(SYMBOLS)];
  while (chars.length < length) chars.push(pick(all));
  // Fisher–Yates so the guaranteed classes aren't always at the front.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

/** Lowercase letters and digits only — safe for Linux usernames. */
export function randomLowerAlnum(length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) out += pick(LOWER + DIGITS);
  return out;
}
