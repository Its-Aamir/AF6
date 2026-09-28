/**
 * Encryption for provider credentials at rest (AES-256-GCM).
 * Key source: SECRETS_KEY env (base64, 32 bytes). If absent, a key is generated
 * once into <STORAGE_DIR>/../secrets.key with 0600 permissions.
 * Decrypted secrets never leave the server process.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config';

let key: Buffer | null = null;

function loadKey(): Buffer {
  if (key) return key;
  const fromEnv = process.env.SECRETS_KEY?.trim();
  if (fromEnv) {
    const k = Buffer.from(fromEnv, 'base64');
    if (k.length !== 32) throw new Error('SECRETS_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32)');
    key = k;
    return k;
  }
  const file = path.join(path.dirname(config.storageDir), config.isTest ? 'secrets.test.key' : 'secrets.key');
  if (fs.existsSync(file)) {
    key = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64');
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    key = randomBytes(32);
    fs.writeFileSync(file, key.toString('base64'), { mode: 0o600 });
    if (!config.isTest) console.warn(`[secrets] SECRETS_KEY not set; generated ${file}. Back it up, or set SECRETS_KEY in production.`);
  }
  if (key.length !== 32) throw new Error(`Invalid secrets key in ${file}`);
  return key;
}

export function encryptJson(value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', loadKey(), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join('.');
}

export function decryptJson<T>(payload: string): T {
  const [v, iv, tag, data] = payload.split('.');
  if (v !== 'v1' || !iv || !tag || !data) throw new Error('Unrecognised secret format');
  const decipher = createDecipheriv('aes-256-gcm', loadKey(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  const out = Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]);
  return JSON.parse(out.toString('utf8')) as T;
}

/** "…abcd" — enough for the user to recognise a key, useless to anyone else. */
export function hintFor(secret: string): string {
  const s = secret.trim();
  return s.length <= 8 ? '…' : `…${s.slice(-4)}`;
}
