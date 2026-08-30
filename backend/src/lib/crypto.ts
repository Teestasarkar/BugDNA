/**
 * Token encryption at rest.
 *
 * GitHub access tokens are the most sensitive thing BugDNA stores: one grants
 * read access to a user's private source. They are therefore never persisted in
 * plaintext — each is sealed with AES-256-GCM under `TOKEN_ENCRYPTION_KEY`.
 *
 * GCM is authenticated, so a tampered ciphertext fails to decrypt rather than
 * silently yielding garbage. The IV is random per encryption (never reused) and
 * stored alongside the ciphertext, which is safe and standard.
 */
import crypto from "node:crypto";
import { env } from "../config/env";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12; // 96-bit nonce, the GCM-recommended size
const KEY = env.tokenEncryptionKey;

export interface SealedToken {
  cipher: string; // base64
  iv: string; // base64
  tag: string; // base64
}

/** Encrypt a token for storage. */
export function sealToken(plaintext: string): SealedToken {
  if (!plaintext) throw new Error("sealToken: refusing to encrypt an empty value");

  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv);

  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);

  return {
    cipher: encrypted.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

/**
 * Decrypt a stored token.
 *
 * Throws if the key has changed or the record was tampered with. Callers treat
 * a throw as "this GitHub connection is unusable, ask the user to reconnect"
 * rather than as a server fault.
 */
export function openToken(sealed: SealedToken): string {
  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    KEY,
    Buffer.from(sealed.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));

  return Buffer.concat([
    decipher.update(Buffer.from(sealed.cipher, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

/** URL-safe random identifier, used for OAuth `state` and lock tokens. */
export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

/**
 * Constant-time string comparison, for comparing secrets (e.g. the internal
 * ML service token) without leaking length/content through timing.
 */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** Stable short hash, used for cache keys derived from long inputs. */
export function shortHash(input: string, length = 16): string {
  return crypto.createHash("sha256").update(input).digest("hex").slice(0, length);
}
