import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// AES-256-GCM with HARNESS_SECRET_KEY (64 hex chars). Stored as "v1:" + base64(iv | tag | ciphertext).
export class SecretKeyError extends Error {}

function key() {
  const k = process.env.HARNESS_SECRET_KEY;
  if (!k || !/^[0-9a-fA-F]{64}$/.test(k)) throw new SecretKeyError("HARNESS_SECRET_KEY is not set (64 hex chars, e.g. `openssl rand -hex 32`); secrets cannot be stored. See .env.example.");
  return Buffer.from(k, "hex");
}

export function encrypt(plain: string) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return "v1:" + Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
}

// Throws on a wrong key or any tampering (GCM auth tag).
export function decrypt(stored: string) {
  if (!stored.startsWith("v1:")) throw new Error("unknown secret format");
  const b = Buffer.from(stored.slice(3), "base64");
  const d = createDecipheriv("aes-256-gcm", key(), b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8");
}
