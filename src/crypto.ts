import { scryptSync, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

const PREFIX = 'v1';

export function isEncrypted(value: string): boolean {
  return typeof value === 'string' && value.startsWith(PREFIX + ':');
}

export function encryptSecret(plaintextJson: string, key: string): string {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const dk = scryptSync(key, salt, 32);
  const cipher = createCipheriv('aes-256-gcm', dk, iv);
  const enc = Buffer.concat([cipher.update(plaintextJson, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PREFIX, salt.toString('base64'), iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join(':');
}

export function decryptSecret(payload: string, key: string): string {
  const parts = payload.split(':');
  if (parts.length !== 5 || parts[0] !== PREFIX) throw new Error('bad encryption payload');
  const [, saltB64, ivB64, tagB64, dataB64] = parts;
  const dk = scryptSync(key, Buffer.from(saltB64, 'base64'), 32);
  const decipher = createDecipheriv('aes-256-gcm', dk, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}
