import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// AES-256-GCM with POLARIS_SECRET_KEY (64 hex chars). Stored as "v2:" + base64(iv | tag | ciphertext), where the GCM
// additional data is "<table>:<row id>": a ciphertext copied to another row (or table) fails to decrypt. The tag is 16
// bytes, enforced on read (Node would accept a truncated one otherwise). "v1:" blobs (the same layout without additional
// data) from before row binding still decrypt, and are rewritten as v2 on the next write.
// ponytail: one key, no key id; rotation = re-enter the keys. Add a key id byte when a second key is ever needed.
export class SecretKeyError extends Error {}

function key() {
  const k = process.env.POLARIS_SECRET_KEY;
  if (!k || !/^[0-9a-fA-F]{64}$/.test(k)) throw new SecretKeyError("POLARIS_SECRET_KEY is not set (64 hex chars, e.g. `openssl rand -hex 32`); secrets cannot be stored. See .env.example.");
  return Buffer.from(k, "hex");
}

export function encrypt(plain: string, aad: string) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv, { authTagLength: 16 });
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return "v2:" + Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
}

// Throws on a wrong key or any tampering (GCM auth tag), or a blob bound to another row.
export function decrypt(stored: string, aad: string) {
  const v2 = stored.startsWith("v2:");
  if (!v2 && !stored.startsWith("v1:")) throw new Error("unknown secret format");
  const b = Buffer.from(stored.slice(3), "base64");
  if (b.length < 12 + 16 + 1) throw new Error("secret is truncated");
  const d = createDecipheriv("aes-256-gcm", key(), b.subarray(0, 12), { authTagLength: 16 });
  if (v2) d.setAAD(Buffer.from(aad));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8");
}
