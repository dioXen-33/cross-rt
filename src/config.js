import crypto from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// CROSSRT_DATA_DIR permet d'isoler completement une instance (base + cle) :
// indispensable pour tester sans jamais toucher aux donnees reelles.
const DATA_DIR = process.env.CROSSRT_DATA_DIR
  ? path.resolve(process.env.CROSSRT_DATA_DIR)
  : path.join(ROOT, 'data');
mkdirSync(DATA_DIR, { recursive: true });

// Parseur maison plutot que process.loadEnvFile : sous Windows, Notepad et
// PowerShell ecrivent le .env avec un BOM UTF-8 qui corromprait la 1re cle.
const envFile = path.join(ROOT, '.env');
if (existsSync(envFile)) {
  const raw = readFileSync(envFile, 'utf8').replace(/^﻿/, '');
  for (const line of raw.split(/\r?\n/)) {
    if (line.trimStart().startsWith('#')) continue;
    const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)$/);
    if (!match) continue;
    const value = match[2].trim().replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[match[1]] === undefined) process.env[match[1]] = value;
  }
}

const HEX_32 = /^[0-9a-f]{64}$/i;

/**
 * Cle de chiffrement des cookies de session. Jamais bloquante : si elle n'est
 * pas fournie, on en genere une et on la conserve dans data/ pour qu'elle
 * reste stable d'un lancement a l'autre.
 */
function resolveEncryptionKey() {
  const fromEnv = (process.env.ENCRYPTION_KEY || '').trim();
  if (HEX_32.test(fromEnv)) return fromEnv;
  if (fromEnv) console.warn('[config] ENCRYPTION_KEY ignoree (64 caracteres hexadecimaux attendus).');

  const keyFile = path.join(DATA_DIR, 'encryption.key');
  if (existsSync(keyFile)) {
    const stored = readFileSync(keyFile, 'utf8').trim();
    if (HEX_32.test(stored)) return stored;
  }

  const generated = crypto.randomBytes(32).toString('hex');
  writeFileSync(keyFile, generated, { mode: 0o600 });
  console.log(`[config] Cle de chiffrement generee dans ${keyFile}`);
  return generated;
}

// Aucune variable n'est obligatoire : l'outil fonctionne sans .env du tout.
export const config = {
  port: Number(process.env.PORT) || 3000,
  uiPassword: process.env.UI_PASSWORD || '',
  dbPath: path.join(DATA_DIR, 'cross-rt.db'),
  encryptionKey: resolveEncryptionKey(),
};
