import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export const sha256Hex = (b: Buffer) => createHash('sha256').update(b).digest('hex');

export function parseKey(hex: string): Buffer | null {
  return /^[0-9a-fA-F]{64}$/.test(hex) ? Buffer.from(hex, 'hex') : null;
}

// AES-256-GCM. "aad" (the object key) is authenticated, so a ciphertext copied to another record fails to decrypt.
export function encrypt(key: Buffer, plain: Buffer, aad: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad));
  const data = Buffer.concat([cipher.update(plain), cipher.final()]);
  return { data, iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex') };
}

// Throws if the ciphertext, IV, tag or aad was changed
export function decrypt(key: Buffer, data: Buffer, ivHex: string, tagHex: string, aad: string): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(data), decipher.final()]);
}