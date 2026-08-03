import crypto from 'node:crypto';
import { config } from './config.js';

const KEY = Buffer.from(config.encryptionKey, 'hex');

/**
 * Les cookies de session donnent le controle total d'un compte X, sans mot de
 * passe ni 2FA. Ils ne sont jamais ecrits en clair dans la base.
 */
export function encrypt(plain) {
  if (plain == null) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), enc.toString('base64')].join('.');
}

export function decrypt(payload) {
  if (payload == null) return null;
  const [iv, tag, data] = String(payload).split('.');
  if (!iv || !tag || !data) return null;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    // Cle changee ou donnee corrompue : le compte devra etre reconnecte.
    return null;
  }
}
