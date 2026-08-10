import crypto from 'node:crypto';
import path from 'node:path';
import express from 'express';
import { config, ROOT } from './config.js';
import {
  db,
  getSettings,
  setSettings,
  num,
  listGroups,
  createGroup,
  renameGroup,
  deleteGroup,
  groupIdsForAccount,
  setAccountGroups,
} from './db.js';
import { log } from './log.js';
import { checkCookies, SessionError, releaseProxy } from './xapi.js';
import { deleteProfile } from './browser.js';
import { encrypt, decrypt } from './crypto.js';
import { startEngine, pollNow, detectionStatus, onSettingsChanged } from './engine.js';

const app = express();
app.use(express.json());

// ------------------------------------------------------------ auth simple
const sessions = new Set();
const AUTH_COOKIE = 'crt_session';

function cookies(req) {
  return Object.fromEntries(
    (req.headers.cookie || '')
      .split(';')
      .map((c) => c.trim().split('='))
      .filter((p) => p.length === 2)
      .map(([k, v]) => [k, decodeURIComponent(v)])
  );
}

app.post('/api/login', (req, res) => {
  const supplied = String(req.body?.password || '');
  const expected = config.uiPassword;
  const ok =
    supplied.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
  if (!ok) return res.status(401).json({ error: 'Mot de passe incorrect' });

  const token = crypto.randomBytes(32).toString('hex');
  sessions.add(token);
  res.setHeader('Set-Cookie', `${AUTH_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`);
  res.json({ ok: true });
});

app.use((req, res, next) => {
  if (!config.uiPassword || sessions.has(cookies(req)[AUTH_COOKIE])) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'auth', needsLogin: true });
  next();
});

// ---------------------------------------------------- connexion des comptes

const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;

function normalizeHandle(raw) {
  const handle = String(raw || '').trim().replace(/^@/, '').replace(/^https?:\/\/(www\.)?x\.com\//i, '');
  return HANDLE_RE.test(handle) ? handle : null;
}

app.post('/api/accounts', (req, res) => {
  const handle = normalizeHandle(req.body?.handle);
  if (!handle) return res.status(400).json({ error: 'Pseudo invalide (lettres, chiffres et _ uniquement).' });

  const role = ['source', 'amplifier', 'both'].includes(req.body?.role) ? req.body.role : 'source';
  const id = handle.toLowerCase();

  if (db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(id)) {
    return res.status(409).json({ error: `@${handle} est deja dans la liste.` });
  }

  db.prepare('INSERT INTO accounts (id, username, role, enabled, created_at) VALUES (?, ?, ?, 1, ?)')
    .run(id, handle, role, Date.now());
  log.info(`Compte ajoute : @${handle} (${role})`);
  res.json({ ok: true, id });
});

const COOKIE_RE = /^[A-Za-z0-9]{16,300}$/;

/**
 * Reprise d'une session ouverte a la main dans un navigateur normal.
 * Les cookies sont chiffres avant stockage ; leurs valeurs ne sont jamais
 * journalisees. La verification est best-effort : elle ne bloque l'import que
 * si X confirme que les cookies sont invalides.
 */
app.post('/api/accounts/:id/session', async (req, res) => {
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(req.params.id);
  if (!account) return res.status(404).json({ error: 'Compte introuvable' });

  const authToken = String(req.body?.auth_token || '').trim();
  const ct0 = String(req.body?.ct0 || '').trim();
  if (!COOKIE_RE.test(authToken)) return res.status(400).json({ error: 'Valeur auth_token invalide.' });
  if (!COOKIE_RE.test(ct0)) return res.status(400).json({ error: 'Valeur ct0 invalide.' });

  let verified = false;
  try {
    ({ verified } = await checkCookies({ authToken, ct0 }));
  } catch (err) {
    if (err instanceof SessionError) {
      log.error(`@${account.username} : import refuse, cookies invalides.`);
      return res.status(400).json({ error: 'Cookies invalides ou expires. Reconnecte-toi dans ton navigateur et recopie-les.' });
    }
    // X ne permet pas de conclure : on stocke quand meme, le retweet tranchera.
  }

  db.prepare(
    `UPDATE accounts SET auth_token = ?, ct0 = ?, session_ok = 1, needs_attention = 0,
     session_checked_at = ?, last_error = NULL WHERE id = ?`
  ).run(encrypt(authToken), encrypt(ct0), Date.now(), account.id);

  log.info(`@${account.username} : session importee${verified ? ' et validee' : ' (validation differee au 1er retweet)'}.`);
  res.json({ ok: true, verified });
});

/**
 * Proxy du compte : permet de sortir par la meme IP que le VA qui gere ce
 * compte, et d'eviter les alertes de securite liees a un changement de pays.
 * L'URL contient des identifiants : elle est chiffree et jamais renvoyee.
 */
app.put('/api/accounts/:id/proxy', (req, res) => {
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(req.params.id);
  if (!account) return res.status(404).json({ error: 'Compte introuvable' });

  const raw = String(req.body?.proxy_url || '').trim();
  if (!raw) {
    const previous = decrypt(account.proxy_url);
    if (previous) releaseProxy(previous);
    db.prepare('UPDATE accounts SET proxy_url = NULL WHERE id = ?').run(account.id);
    log.info(`@${account.username} : proxy retire.`);
    return res.json({ ok: true, proxy: null });
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return res.status(400).json({ error: 'URL invalide. Format attendu : http://user:pass@hote:port' });
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    return res.status(400).json({ error: 'Seuls les proxys http:// et https:// sont pris en charge (pas SOCKS).' });
  }

  const previous = decrypt(account.proxy_url);
  if (previous && previous !== raw) releaseProxy(previous);
  db.prepare('UPDATE accounts SET proxy_url = ? WHERE id = ?').run(encrypt(raw), account.id);
  log.info(`@${account.username} : proxy configure (${parsed.host}).`);
  res.json({ ok: true, proxy: parsed.host });
});

/** L'utilisateur declare avoir traite la verification demandee par X. */
app.post('/api/accounts/:id/resolve', (req, res) => {
  db.prepare('UPDATE accounts SET needs_attention = 0, last_error = NULL WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// -------------------------------------------------------------------- api

app.get('/api/state', (req, res) => {
  const accounts = db
    .prepare(
      `SELECT a.*,
              (SELECT COUNT(*) FROM jobs j WHERE j.amplifier_id = a.id AND j.status = 'done') AS rt_done,
              (SELECT COUNT(*) FROM jobs j WHERE j.amplifier_id = a.id AND j.status = 'done'
                 AND j.updated_at > ?) AS rt_last_hour
         FROM accounts a ORDER BY a.username COLLATE NOCASE`
    )
    .all(Date.now() - 3_600_000)
    // Ni les cookies ni les identifiants de proxy ne sortent du serveur :
    // seul l'hote du proxy est expose, pour affichage.
    .map(({ auth_token, ct0, proxy_url, ...rest }) => {
      let proxyHost = null;
      const url = decrypt(proxy_url);
      if (url) {
        try { proxyHost = new URL(url).host; } catch { proxyHost = 'invalide'; }
      }
      return { ...rest, proxy_host: proxyHost, group_ids: groupIdsForAccount(rest.id) };
    });

  const jobs = db
    .prepare(
      `SELECT j.*, s.username AS author_username, m.username AS amplifier_username
         FROM jobs j
         LEFT JOIN accounts s ON s.id = j.author_id
         LEFT JOIN accounts m ON m.id = j.amplifier_id
        ORDER BY CASE j.status WHEN 'pending' THEN 0 ELSE 1 END, j.updated_at DESC, j.run_at
        LIMIT 60`
    )
    .all();

  const counts = db
    .prepare('SELECT status, COUNT(*) AS n FROM jobs GROUP BY status')
    .all()
    .reduce((acc, r) => ({ ...acc, [r.status]: r.n }), {});

  const settings = getSettings();
  res.json({
    accounts,
    jobs,
    counts,
    groups: listGroups(),
    logs: db.prepare('SELECT * FROM logs ORDER BY id DESC LIMIT 80').all(),
    settings,
    detection: detectionStatus(settings),
  });
});

// ------------------------------------------------------------------ groupes

const GROUP_NAME_RE = /^.{1,40}$/;

app.post('/api/groups', (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!GROUP_NAME_RE.test(name)) return res.status(400).json({ error: 'Nom de groupe invalide (1 a 40 caracteres).' });
  if (db.prepare('SELECT 1 FROM rt_groups WHERE name = ? COLLATE NOCASE').get(name)) {
    return res.status(409).json({ error: `Le groupe « ${name} » existe deja.` });
  }
  const id = createGroup(name);
  log.info(`Groupe cree : ${name}`);
  res.json({ ok: true, id });
});

app.put('/api/groups/:id', (req, res) => {
  const group = db.prepare('SELECT * FROM rt_groups WHERE id = ?').get(req.params.id);
  if (!group) return res.status(404).json({ error: 'Groupe introuvable' });
  const name = String(req.body?.name || '').trim();
  if (!GROUP_NAME_RE.test(name)) return res.status(400).json({ error: 'Nom de groupe invalide (1 a 40 caracteres).' });
  const clash = db.prepare('SELECT id FROM rt_groups WHERE name = ? COLLATE NOCASE').get(name);
  if (clash && clash.id !== group.id) return res.status(409).json({ error: `Le groupe « ${name} » existe deja.` });
  renameGroup(group.id, name);
  res.json({ ok: true });
});

app.delete('/api/groups/:id', (req, res) => {
  const group = db.prepare('SELECT name FROM rt_groups WHERE id = ?').get(req.params.id);
  deleteGroup(Number(req.params.id));
  if (group) log.info(`Groupe supprime : ${group.name}`);
  res.json({ ok: true });
});

/** Remplace l'ensemble des groupes d'un compte (appartenance ou ciblage). */
app.put('/api/accounts/:id/groups', (req, res) => {
  if (!db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(req.params.id)) {
    return res.status(404).json({ error: 'Compte introuvable' });
  }
  const ids = Array.isArray(req.body?.groupIds) ? req.body.groupIds : [];
  // On ne garde que des identifiants de groupes reellement existants.
  const valid = new Set(db.prepare('SELECT id FROM rt_groups').all().map((g) => g.id));
  setAccountGroups(req.params.id, ids.map(Number).filter((n) => valid.has(n)));
  res.json({ ok: true });
});

app.patch('/api/accounts/:id', (req, res) => {
  const { role, enabled } = req.body || {};
  if (!db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(req.params.id)) {
    return res.status(404).json({ error: 'Compte introuvable' });
  }
  if (role !== undefined) {
    if (!['source', 'amplifier', 'both'].includes(role)) return res.status(400).json({ error: 'Role invalide' });
    db.prepare('UPDATE accounts SET role = ? WHERE id = ?').run(role, req.params.id);
  }
  if (enabled !== undefined) {
    db.prepare('UPDATE accounts SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, req.params.id);
  }
  res.json({ ok: true });
});

app.delete('/api/accounts/:id', (req, res) => {
  const account = db.prepare('SELECT username FROM accounts WHERE id = ?').get(req.params.id);
  db.prepare("DELETE FROM jobs WHERE (amplifier_id = ? OR author_id = ?) AND status = 'pending'")
    .run(req.params.id, req.params.id);
  db.prepare('DELETE FROM accounts WHERE id = ?').run(req.params.id);
  try {
    deleteProfile(req.params.id);
  } catch (err) {
    log.warn(`Profil Chromium non supprime pour ${req.params.id} : ${err.message}`);
  }
  if (account) log.info(`Compte retire : @${account.username}`);
  res.json({ ok: true });
});

app.put('/api/settings', (req, res) => {
  const settings = setSettings(req.body || {});
  onSettingsChanged();
  res.json({ settings });
});

app.post('/api/poll', async (req, res) => {
  await pollNow();
  res.json({ ok: true });
});

app.post('/api/jobs/:id/cancel', (req, res) => {
  db.prepare(
    "UPDATE jobs SET status = 'skipped', error = 'Annule manuellement', updated_at = ? WHERE id = ? AND status = 'pending'"
  ).run(Date.now(), Number(req.params.id));
  res.json({ ok: true });
});

app.post('/api/jobs/clear', (req, res) => {
  db.prepare("DELETE FROM jobs WHERE status != 'pending'").run();
  res.json({ ok: true });
});

// ------------------------------------------------------------------ static
app.use(express.static(path.join(ROOT, 'public')));

// Version affichee au demarrage : permet de confirmer d'un coup d'oeil quel
// code tourne reellement apres une modification.
const BUILD = 'v5.0 (retweet Chromium + proxy)';

// On ecoute par defaut sur la boucle locale uniquement : sur un serveur
// distant, exposer cette interface reviendrait a offrir les sessions X
// enregistrees a Internet. Passer HOST=0.0.0.0 est un choix explicite.
const server = app.listen(config.port, config.host, () => {
  log.info(`Cross-RT ${BUILD} — interface sur http://${config.host}:${config.port}`);
  if (config.host !== '127.0.0.1') {
    log.warn(
      `Interface exposee sur ${config.host} : accessible hors de cette machine. ` +
        `Assure-toi qu'un UI_PASSWORD est defini et qu'un pare-feu filtre le port ${config.port}.`
    );
    if (!config.uiPassword) {
      log.error('UI_PASSWORD est vide alors que l\'interface est exposee : n\'importe qui peut piloter tes comptes.');
    }
  }
  startEngine();
});

// Sans ce garde, un second lancement alors qu'un ancien serveur tient le port
// echouerait en silence : l'utilisateur croirait tourner sur le nouveau code.
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n[serveur] Le port ${config.port} est deja utilise.`);
    console.error('[serveur] Un ancien serveur tourne probablement encore.');
    console.error('[serveur] Ferme-le (Ctrl+C dans sa fenetre), ou arrete tous les process Node,');
    console.error('[serveur] puis relance `npm start`. Ou change PORT dans .env.\n');
  } else {
    console.error(`[serveur] Erreur : ${err.message}`);
  }
  process.exit(1);
});
