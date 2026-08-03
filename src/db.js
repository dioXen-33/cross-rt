import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

mkdirSync(path.dirname(config.dbPath), { recursive: true });

export const db = new DatabaseSync(config.dbPath);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
`);

// Les versions precedentes stockaient des tokens OAuth, puis des sessions
// Chromium. Aucune n'est reutilisable : on repart sur un schema propre.
const hasAccounts = db.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('accounts')").get()?.n;
const hasCookies = db
  .prepare("SELECT COUNT(*) AS n FROM pragma_table_info('accounts') WHERE name = 'auth_token'")
  .get()?.n;
if (hasAccounts && !hasCookies) {
  console.warn('[db] Ancien schema detecte : la table des comptes est recreee (sessions a reimporter).');
  db.exec('DROP TABLE IF EXISTS accounts; DROP TABLE IF EXISTS jobs; DROP TABLE IF EXISTS oauth_state;');
}

// Ajouts non destructifs sur une base existante.
if (hasCookies) {
  const columns = db.prepare("SELECT name FROM pragma_table_info('accounts')").all().map((c) => c.name);
  if (!columns.includes('x_user_id')) db.exec('ALTER TABLE accounts ADD COLUMN x_user_id TEXT');
  if (!columns.includes('proxy_url')) db.exec('ALTER TABLE accounts ADD COLUMN proxy_url TEXT');
}

db.exec(`
  CREATE TABLE IF NOT EXISTS accounts (
    id                 TEXT PRIMARY KEY,          -- pseudo en minuscules
    username           TEXT NOT NULL,             -- pseudo tel qu'affiche
    role               TEXT NOT NULL DEFAULT 'amplifier', -- source | amplifier | both
    enabled            INTEGER NOT NULL DEFAULT 1,
    x_user_id          TEXT,                       -- identifiant numerique X, resolu une fois
    auth_token         TEXT,                       -- cookie de session, chiffre
    ct0                TEXT,                       -- jeton CSRF, chiffre
    proxy_url          TEXT,                       -- proxy du compte, chiffre (contient des identifiants)
    session_ok         INTEGER NOT NULL DEFAULT 0,
    session_checked_at INTEGER,
    last_tweet_id      TEXT,                      -- curseur de detection
    last_polled_at     INTEGER,
    last_error         TEXT,
    needs_attention    INTEGER NOT NULL DEFAULT 0, -- verification manuelle requise
    created_at         INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS jobs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    tweet_id     TEXT NOT NULL,
    author_id    TEXT NOT NULL,
    amplifier_id TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'pending', -- pending | done | failed | skipped
    run_at       INTEGER NOT NULL,
    attempts     INTEGER NOT NULL DEFAULT 0,
    error        TEXT,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    UNIQUE (tweet_id, amplifier_id)
  );
  CREATE INDEX IF NOT EXISTS idx_jobs_due ON jobs (status, run_at);

  CREATE TABLE IF NOT EXISTS logs (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    ts      INTEGER NOT NULL,
    level   TEXT NOT NULL,
    message TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

export const DEFAULT_SETTINGS = {
  paused: '0',
  poll_interval_sec: '120',      // detection authentifiee : limites par compte, pas par IP
  delay_min_sec: '90',           // delai aleatoire minimum avant un RT
  delay_max_sec: '900',          // delai aleatoire maximum avant un RT
  stagger_sec: '180',            // ecart minimum entre 2 amplificateurs
  max_rt_per_hour: '4',          // plafond de RT par compte amplificateur
  session_check_hours: '6',      // frequence de verification des sessions
  headless: '1',                 // 0 = fenetres Chromium visibles (diagnostic)
  // Identifiants des operations GraphQL utilisees pour la DETECTION. X les fait
  // tourner au fil de ses deploiements : modifiables ici sans toucher au code.
  // Le retweet passe par le navigateur et n'en a pas besoin.
  user_tweets_query_id: 'V7H0Ap3_Hh2FyS75OCDO3Q',
  user_by_screen_name_query_id: 'G3KGOASz96M-Qu0nwmGXNg',
  skip_replies: '1',
  skip_retweets: '1',
  require_keywords: '',
  exclude_keywords: '',
  max_age_min: '180',
};

const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insertSetting.run(k, v);

export function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = { ...DEFAULT_SETTINGS };
  for (const r of rows) out[r.key] = r.value;
  return out;
}

export function setSettings(patch) {
  const stmt = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  );
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in DEFAULT_SETTINGS)) continue;
    stmt.run(k, String(v));
  }
  return getSettings();
}

export function num(settings, key) {
  const n = Number(settings[key]);
  return Number.isFinite(n) ? n : Number(DEFAULT_SETTINGS[key]);
}
