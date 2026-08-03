/**
 * Publication des retweets dans un vrai Chromium.
 *
 * Pourquoi un navigateur plutot que l'appel API direct : sur la page, c'est le
 * JavaScript de X lui-meme qui produit les jetons anti-robot (dont
 * x-client-transaction-id). Rien n'est forge — le client legitime fait son
 * travail — la ou l'appel API nu se faisait refuser en code 226.
 *
 * Choix assume : aucun camouflage d'empreinte, aucun solveur de CAPTCHA. Sur une
 * verification, l'outil s'arrete sur ce compte et demande une intervention.
 */

import path from 'node:path';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { ROOT } from './config.js';

const PROFILES_DIR = path.join(ROOT, 'data', 'profiles');
mkdirSync(PROFILES_DIR, { recursive: true });

const NAV_TIMEOUT = 60_000;

/** Session absente ou expiree : les cookies doivent etre reimportes. */
export class BrowserSessionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BrowserSessionError';
  }
}

/** X demande une verification humaine : on ne la contourne pas. */
export class ChallengeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ChallengeError';
  }
}

export function profileDir(accountId) {
  return path.join(PROFILES_DIR, accountId);
}

export function deleteProfile(accountId) {
  const dir = profileDir(accountId);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

// Un profil Chromium ne supporte qu'une instance a la fois : on serialise
// strictement les operations compte par compte.
const locks = new Map();

function withLock(accountId, fn) {
  const previous = locks.get(accountId) || Promise.resolve();
  const current = previous.then(fn, fn);
  locks.set(accountId, current.then(() => {}, () => {}));
  return current;
}

/**
 * Traduit l'URL de proxy du compte en configuration Playwright.
 * Les identifiants doivent etre passes separement de l'hote.
 */
export function parseProxy(proxyUrl) {
  if (!proxyUrl) return undefined;
  let parsed;
  try {
    parsed = new URL(proxyUrl);
  } catch {
    throw new Error(`URL de proxy invalide : ${String(proxyUrl).slice(0, 40)}`);
  }
  const proxy = { server: `${parsed.protocol}//${parsed.host}` };
  if (parsed.username) proxy.username = decodeURIComponent(parsed.username);
  if (parsed.password) proxy.password = decodeURIComponent(parsed.password);
  return proxy;
}

async function launch(accountId, { headless, proxyUrl }) {
  mkdirSync(profileDir(accountId), { recursive: true });
  return chromium.launchPersistentContext(profileDir(accountId), {
    headless,
    viewport: { width: 1280, height: 900 },
    locale: 'fr-FR',
    proxy: parseProxy(proxyUrl),
  });
}

/**
 * Injecte la session dans le profil. On n'automatise jamais le formulaire de
 * connexion : X le bloque, et c'est l'etape la plus surveillee.
 */
async function applyCookies(context, { authToken, ct0 }) {
  const base = { path: '/', secure: true, expires: Math.floor(Date.now() / 1000) + 365 * 24 * 3600 };
  const cookies = [];
  for (const domain of ['.x.com', '.twitter.com']) {
    cookies.push({ ...base, name: 'auth_token', value: authToken, domain, httpOnly: true, sameSite: 'None' });
    cookies.push({ ...base, name: 'ct0', value: ct0, domain, httpOnly: false, sameSite: 'Lax' });
  }
  await context.addCookies(cookies);
}

/** Differencie une session morte d'une verification active. */
async function assertUsable(page) {
  const url = page.url();
  if (/\/i\/flow\/login|\/login\b|\/i\/flow\/signup/.test(url)) {
    throw new BrowserSessionError('Session expiree : reimporte les cookies de ce compte.');
  }
  if (/\/account\/access|\/i\/flow\/consent_flow|\/i\/flow\/challenge/.test(url)) {
    throw new ChallengeError('X demande une verification manuelle sur ce compte.');
  }
  const challenge = await page
    .locator('iframe[src*="captcha" i], iframe[title*="captcha" i], [data-testid="ocfEnterTextTextInput"]')
    .count();
  if (challenge) throw new ChallengeError('X affiche un CAPTCHA sur ce compte.');
}

/**
 * Publie le retweet. Renvoie 'done', ou 'already' si le post etait deja relaye.
 */
export function retweet(accountId, { tweetId, authorHandle, authToken, ct0, headless = true, proxyUrl }) {
  return withLock(accountId, async () => {
    const context = await launch(accountId, { headless, proxyUrl });
    try {
      await applyCookies(context, { authToken, ct0 });

      const page = context.pages()[0] || (await context.newPage());
      await page.goto(`https://x.com/${authorHandle}/status/${tweetId}`, {
        waitUntil: 'domcontentloaded',
        timeout: NAV_TIMEOUT,
      });
      await assertUsable(page);

      const article = page.locator('article[data-testid="tweet"]').first();
      try {
        await article.waitFor({ timeout: 25_000 });
      } catch {
        await assertUsable(page);
        throw new Error('Post introuvable, supprime, ou page non chargee.');
      }

      if (await article.locator('[data-testid="unretweet"]').count()) return 'already';

      await article.locator('[data-testid="retweet"]').first().click({ timeout: 15_000 });

      const confirm = page.locator('[data-testid="retweetConfirm"]');
      await confirm.waitFor({ timeout: 15_000 });
      await confirm.click();

      // Le bouton bascule en « unretweet » : confirmation cote interface.
      try {
        await article.locator('[data-testid="unretweet"]').first().waitFor({ timeout: 25_000 });
      } catch {
        // Le clic a pu etre refuse silencieusement (blocage anti-automatisation).
        await assertUsable(page);
        throw new Error('Retweet non confirme par l\'interface de X apres le clic.');
      }
      return 'done';
    } finally {
      await context.close().catch(() => {});
    }
  });
}

/** Verifie qu'une session ouvre bien x.com dans le navigateur, sans rien publier. */
export function checkSession(accountId, { authToken, ct0, headless = true, proxyUrl }) {
  return withLock(accountId, async () => {
    const context = await launch(accountId, { headless, proxyUrl });
    try {
      await applyCookies(context, { authToken, ct0 });
      const page = context.pages()[0] || (await context.newPage());
      await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
      await assertUsable(page);
      return true;
    } finally {
      await context.close().catch(() => {});
    }
  });
}
