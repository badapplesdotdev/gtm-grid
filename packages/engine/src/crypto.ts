// Credential encryption — mirrors Revcode's `credentials_enc` column.
// AES-256-GCM with a per-machine key stored at ~/.gtmgrid/key (0600).

import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const KEY_DIR = join(homedir(), ".gtmgrid");
const KEY_PATH = join(KEY_DIR, "key");

function loadOrCreateKey(): Buffer {
  if (existsSync(KEY_PATH)) {
    return Buffer.from(readFileSync(KEY_PATH, "utf8").trim(), "hex");
  }
  mkdirSync(KEY_DIR, { recursive: true });
  const key = randomBytes(32);
  writeFileSync(KEY_PATH, key.toString("hex"), { mode: 0o600 });
  chmodSync(KEY_PATH, 0o600);
  return key;
}

let cachedKey: Buffer | null = null;
function key(): Buffer {
  if (!cachedKey) cachedKey = loadOrCreateKey();
  return cachedKey;
}

/** Encrypt a JSON-serializable secret map → base64(iv | tag | ciphertext). */
export function encryptSecrets(secrets: Record<string, string>): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const plaintext = Buffer.from(JSON.stringify(secrets), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString("base64");
}

/** Decrypt the base64 blob back into the secret map. */
export function decryptSecrets(blob: string): Record<string, string> {
  const buf = Buffer.from(blob, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ciphertext = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8"));
}
