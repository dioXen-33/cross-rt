import { db, getSettings, num, groupIdsForAccount } from './db.js';
import { isNewer, maxId } from './detect.js';
import { retweet, BrowserSessionError, ChallengeError } from './browser.js';
import {
  checkCookies,
  resolveUserId,
  fetchUserTweets,
  SessionError,
  LockedError,
  RateLimitError,
  ClientVerificationError,
  StaleQueryIdError,
  AutomationBlockedError,
} from './xapi.js';
import { decrypt } from './crypto.js';
import { log, trimLogs } from './log.js';

const WORKER_TICK_MS = 10_000;
const MAX_ATTEMPTS = 4;
const MAX_JOBS_PER_TICK = 3;

/** Limites de debit par compte : id -> timestamp de reprise. */
const rateLimited = new Map();

function isRateLimited(id) {
  const until = rateLimited.get(id);
  if (!until) return false;
  if (until <= Date.now()) {
    rateLimited.delete(id);
    return false;
  }
  return true;
}

/** Reconstitue les identifiants dechiffres d'un compte. */
function sessionOf(account) {
  const authToken = decrypt(account.auth_token);
  const ct0 = decrypt(account.ct0);
  if (!authToken || !ct0) throw new SessionError('Aucune session enregistree : importe les cookies.');
  // Le proxy suit le compte : lecture API et navigateur sortent par la meme IP.
  return { authToken, ct0, proxyUrl: decrypt(account.proxy_url) || undefined };
}

const sources = () =>
  db.prepare("SELECT * FROM accounts WHERE enabled = 1 AND role IN ('source', 'both') ORDER BY username").all();

/** Un amplificateur n'est utilisable que si sa session est valide et sans blocage. */
const amplifiers = () =>
  db
    .prepare(
      `SELECT * FROM accounts
        WHERE enabled = 1 AND role IN ('amplifier', 'both')
          AND session_ok = 1 AND needs_attention = 0
        ORDER BY username`
    )
    .all();

function setError(id, message, { attention } = {}) {
  db.prepare('UPDATE accounts SET last_error = ?, needs_attention = COALESCE(?, needs_attention) WHERE id = ?')
    .run(message ? String(message).slice(0, 300) : null, attention === undefined ? null : attention ? 1 : 0, id);
}

// ---------------------------------------------------------------- filtrage

function parseKeywords(raw) {
  return String(raw || '')
    .split(',')
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean);
}

/** Renvoie null si le post passe les filtres, sinon la raison du rejet. */
function rejectionReason(post, settings) {
  if (num(settings, 'skip_replies') && post.isReply) return 'reponse';
  if (num(settings, 'skip_retweets') && post.isRetweet) return 'retweet';

  const maxAgeMin = num(settings, 'max_age_min');
  if (maxAgeMin > 0 && post.createdAt) {
    const ageMin = (Date.now() - post.createdAt) / 60_000;
    if (ageMin > maxAgeMin) return `trop ancien (${Math.round(ageMin)} min)`;
  }

  const text = String(post.text).toLowerCase();
  const required = parseKeywords(settings.require_keywords);
  if (required.length && !required.some((k) => text.includes(k))) return 'aucun mot-cle requis';

  const excluded = parseKeywords(settings.exclude_keywords);
  const hit = excluded.find((k) => text.includes(k));
  if (hit) return `mot-cle exclu « ${hit} »`;

  return null;
}

// ---------------------------------------------------------- mise en file

const insertJob = db.prepare(
  `INSERT OR IGNORE INTO jobs (tweet_id, author_id, amplifier_id, status, run_at, created_at, updated_at)
   VALUES (?, ?, ?, 'pending', ?, ?, ?)`
);

/**
 * Amplificateurs qui doivent retweeter cette source, selon les groupes.
 *
 * - Source sans groupe assigne  -> tous les amplificateurs (comportement par
 *   defaut, inchange).
 * - Source avec des groupes      -> uniquement les amplificateurs qui
 *   appartiennent a au moins un de ces groupes.
 */
export function targetsForSource(source) {
  let targets = amplifiers().filter((a) => a.id !== source.id);

  const sourceGroups = groupIdsForAccount(source.id);
  if (sourceGroups.length) {
    const wanted = new Set(sourceGroups);
    targets = targets.filter((a) => groupIdsForAccount(a.id).some((g) => wanted.has(g)));
  }
  return targets;
}

function enqueuePost(post, source, settings) {
  const targets = targetsForSource(source);
  if (!targets.length) return 0;

  const minDelay = num(settings, 'delay_min_sec') * 1000;
  const maxDelay = Math.max(minDelay, num(settings, 'delay_max_sec') * 1000);
  const stagger = num(settings, 'stagger_sec') * 1000;

  // Ordre aleatoire + decalage croissant : les comptes ne retweetent jamais
  // en meme temps ni toujours dans le meme ordre.
  const shuffled = [...targets].sort(() => Math.random() - 0.5);
  const now = Date.now();
  let queued = 0;

  shuffled.forEach((amp, i) => {
    const jitter = minDelay + Math.random() * (maxDelay - minDelay);
    const runAt = now + jitter + i * stagger * (0.7 + Math.random() * 0.6);
    if (insertJob.run(post.id, source.id, amp.id, Math.round(runAt), now, now).changes) queued++;
  });

  return queued;
}

// ------------------------------------------------------------- detection

// Une limite de debit atteinte suspend toute la detection le temps du backoff,
// pas seulement le compte source qui l'a rencontree.
let detectPauseUntil = 0;
let detectPauseLogged = 0;
let consecutive429 = 0;
let noReaderLogged = false;

/** Derniere tentative par compte, en memoire : sert au tour de role. */
const lastAttemptAt = new Map();

/**
 * Session utilisee pour LIRE les timelines.
 *
 * La detection passe desormais par l'API authentifiee : il faut donc un compte
 * connecte pour lire. On prend un amplificateur valide, en alternant pour
 * repartir la charge sur plusieurs sessions plutot que d'en exposer une seule.
 */
let readerCursor = 0;

function readerSession() {
  // La lecture reste autorisee avec une session mise de cote pour un refus
  // d'ECRITURE (code 226) : lire une timeline est ce que fait tout navigateur,
  // ce n'est pas l'action que X a refusee. On privilegie neanmoins les comptes
  // non signales quand il y en a.
  const usable = db
    .prepare(
      `SELECT * FROM accounts
        WHERE enabled = 1 AND role IN ('amplifier', 'both')
          AND session_ok = 1 AND auth_token IS NOT NULL AND ct0 IS NOT NULL
        ORDER BY needs_attention, username`
    )
    .all();
  if (!usable.length) return null;

  const clean = usable.filter((a) => !a.needs_attention);
  const pool = clean.length ? clean : usable;
  const account = pool[readerCursor++ % pool.length];
  return { account, session: sessionOf(account) };
}

/** Interroge un seul compte source par cycle, du plus anciennement lu au plus recent. */
async function pollNextSource(settings, { force = false } = {}) {
  if (!force && Date.now() < detectPauseUntil) return;

  const intervalMs = Math.max(30, num(settings, 'poll_interval_sec')) * 1000;
  const now = Date.now();
  const candidate = sources()
    .filter((s) => force || now - (lastAttemptAt.get(s.id) || 0) >= intervalMs)
    .sort((a, b) => (lastAttemptAt.get(a.id) || 0) - (lastAttemptAt.get(b.id) || 0))[0];

  if (!candidate) return;
  lastAttemptAt.set(candidate.id, now);
  await pollSource(candidate, settings);
}

async function pollSource(source, settings) {
  const reader = readerSession();
  if (!reader) {
    if (!noReaderLogged) {
      noReaderLogged = true;
      log.warn('Detection impossible : aucune session disponible. Importe les cookies d\'au moins un compte amplificateur.');
    }
    return;
  }
  noReaderLogged = false;

  let posts;
  try {
    // L'identifiant numerique ne change jamais : on le resout une seule fois.
    let userId = source.x_user_id;
    if (!userId) {
      userId = await resolveUserId(reader.session, source.username, settings.user_by_screen_name_query_id);
      db.prepare('UPDATE accounts SET x_user_id = ? WHERE id = ?').run(userId, source.id);
      log.info(`@${source.username} identifie (${userId}).`);
    }
    posts = await fetchUserTweets(reader.session, userId, settings.user_tweets_query_id);
  } catch (err) {
    if (err instanceof RateLimitError) {
      consecutive429 += 1;
      // Un refus isole ne doit pas coûter une fenetre entiere : 1 min, puis 3,
      // et on ne s'aligne sur la date de X qu'au 3e refus consecutif.
      const backoffMs = consecutive429 === 1 ? 60_000 : consecutive429 === 2 ? 180_000 : null;
      detectPauseUntil = backoffMs ? Date.now() + backoffMs : err.resetAt;
      if (detectPauseLogged !== detectPauseUntil) {
        detectPauseLogged = detectPauseUntil;
        const mins = Math.max(1, Math.round((detectPauseUntil - Date.now()) / 60_000));
        log.warn(`Lecture refusee par X (limite de debit sur @${reader.account.username}). Tentative ${consecutive429}, reprise dans ~${mins} min.`);
      }
      return;
    }
    if (err instanceof SessionError || err instanceof LockedError || err instanceof StaleQueryIdError) {
      // C'est la session lectrice ou la configuration qui est en cause,
      // pas le compte source lui-meme.
      handleApiError(reader.account, err, 'lecture de timeline');
      return;
    }
    log.error(`@${source.username} — detection impossible : ${err.message}`);
    setError(source.id, err.message);
    return;
  }

  if (!posts.length) {
    log.warn(`@${source.username} : aucun post retourne. Verifie l'identifiant de requete UserTweets (reglages).`);
    setError(source.id, 'Aucun post retourne par X.');
    db.prepare('UPDATE accounts SET last_polled_at = ? WHERE id = ?').run(Date.now(), source.id);
    return;
  }

  // Detection reussie : on repart d'un backoff neuf.
  consecutive429 = 0;
  detectPauseLogged = 0;
  db.prepare('UPDATE accounts SET last_polled_at = ?, last_error = NULL WHERE id = ?').run(Date.now(), source.id);

  const newest = maxId(posts.map((p) => p.id));

  // Premier passage : on pose le curseur sans rien retweeter, sinon on
  // republierait tout l'historique visible d'un coup.
  if (!source.last_tweet_id) {
    db.prepare('UPDATE accounts SET last_tweet_id = ? WHERE id = ?').run(newest, source.id);
    log.info(`@${source.username} : curseur initialise, les prochains posts seront retweetes.`);
    return;
  }

  for (const post of posts) {
    if (!isNewer(post.id, source.last_tweet_id)) continue;

    const reason = rejectionReason(post, settings);
    if (reason) {
      log.info(`@${source.username} — post ${post.id} ignore (${reason}).`);
      continue;
    }
    const queued = enqueuePost(post, source, settings);
    log.info(
      queued
        ? `@${source.username} — nouveau post ${post.id} : ${queued} retweet(s) programme(s).`
        : `@${source.username} — post ${post.id} : aucun amplificateur disponible.`
    );
  }

  db.prepare('UPDATE accounts SET last_tweet_id = ? WHERE id = ?').run(newest, source.id);
}

// ------------------------------------------------------------ execution

function retweetsLastHour(amplifierId) {
  return (
    db
      .prepare("SELECT COUNT(*) AS n FROM jobs WHERE amplifier_id = ? AND status = 'done' AND updated_at > ?")
      .get(amplifierId, Date.now() - 3_600_000)?.n ?? 0
  );
}

function finishJob(id, status, error = null) {
  db.prepare('UPDATE jobs SET status = ?, error = ?, updated_at = ? WHERE id = ?')
    .run(status, error ? String(error).slice(0, 300) : null, Date.now(), id);
}

function reschedule(jobId, at, error = null) {
  db.prepare('UPDATE jobs SET run_at = ?, error = ?, updated_at = ? WHERE id = ?')
    .run(Math.round(at), error ? String(error).slice(0, 300) : null, Date.now(), jobId);
}

/** Un identifiant de requete perime n'est signale qu'une fois par operation. */
const staleLogged = new Set();

/** Traduit une erreur d'API en etat de compte lisible dans l'interface. */
function handleApiError(account, err, context) {
  if (err instanceof StaleQueryIdError) {
    // Panne de configuration, pas de compte : inutile de desactiver la session.
    setError(account.id, err.message);
    if (!staleLogged.has(err.operation)) {
      staleLogged.add(err.operation);
      log.error(err.message);
    }
    return 'stale';
  }
  if (err instanceof AutomationBlockedError) {
    // On arrete ce compte immediatement. Reessayer apres un 226 est le meilleur
    // moyen de le faire verrouiller : la session reste valide, mais le compte
    // sort du circuit tant que l'utilisateur n'a pas tranche.
    db.prepare('UPDATE accounts SET needs_attention = 1 WHERE id = ?').run(account.id);
    setError(account.id, 'X refuse l\'action : requete jugee automatisee (code 226).');
    log.error(
      `@${account.username} : X a bloque le retweet en le jugeant automatise (code 226). ` +
        `Ce compte est mis de cote — ne relance pas sans lire la section « Blocage anti-automatisation » du README.`
    );
    return 'automation';
  }
  if (err instanceof ChallengeError) {
    db.prepare('UPDATE accounts SET needs_attention = 1 WHERE id = ?').run(account.id);
    setError(account.id, err.message);
    log.error(`@${account.username} : ${err.message} (${context}) — traite-la a la main dans un navigateur normal.`);
    return 'attention';
  }
  if (err instanceof BrowserSessionError) {
    db.prepare('UPDATE accounts SET session_ok = 0 WHERE id = ?').run(account.id);
    setError(account.id, err.message);
    log.error(`@${account.username} : ${err.message} (${context})`);
    return 'session';
  }
  if (err instanceof LockedError) {
    db.prepare('UPDATE accounts SET needs_attention = 1, session_ok = 0 WHERE id = ?').run(account.id);
    setError(account.id, err.message);
    log.error(`@${account.username} : ${err.message} (${context}) — ouvre ce compte a la main dans X.`);
    return 'attention';
  }
  if (err instanceof SessionError) {
    db.prepare('UPDATE accounts SET session_ok = 0 WHERE id = ?').run(account.id);
    setError(account.id, err.message);
    log.error(`@${account.username} : ${err.message} (${context})`);
    return 'session';
  }
  if (err instanceof RateLimitError) {
    rateLimited.set(account.id, err.resetAt);
    const mins = Math.ceil((err.resetAt - Date.now()) / 60_000);
    setError(account.id, `Limite de debit, reprise dans ~${mins} min`);
    log.warn(`@${account.username} : limite de debit X (${context}), pause de ~${mins} min.`);
    return 'ratelimit';
  }
  if (err instanceof ClientVerificationError) {
    // Cas structurel : ce n'est pas le compte qui est en cause, c'est l'endpoint.
    setError(account.id, err.message);
    log.error(`X exige une verification client sur ${context} — voir la section « Endpoint bloque » du README.`);
    return 'blocked';
  }
  setError(account.id, err.message);
  log.error(`@${account.username} — erreur (${context}) : ${err.message}`);
  return 'other';
}

async function runDueJobs(settings) {
  const due = db
    .prepare("SELECT * FROM jobs WHERE status = 'pending' AND run_at <= ? ORDER BY run_at LIMIT 25")
    .all(Date.now());
  if (!due.length) return;

  const cap = num(settings, 'max_rt_per_hour');
  // Chaque retweet ouvre un navigateur : on en traite peu par cycle.
  const handled = new Set(); // un seul RT par compte et par tick
  let processed = 0;

  for (const job of due) {
    if (processed >= MAX_JOBS_PER_TICK) break;
    if (handled.has(job.amplifier_id)) continue;
    if (isRateLimited(job.amplifier_id)) continue;

    const amp = db.prepare('SELECT * FROM accounts WHERE id = ?').get(job.amplifier_id);
    if (!amp || !amp.enabled) {
      finishJob(job.id, 'skipped', 'Compte amplificateur absent ou desactive');
      continue;
    }
    if (amp.needs_attention) {
      reschedule(job.id, Date.now() + 30 * 60_000, 'Compte en attente de verification manuelle');
      continue;
    }
    if (!amp.session_ok) {
      reschedule(job.id, Date.now() + 15 * 60_000, 'Session a reconnecter');
      continue;
    }
    if (cap > 0 && retweetsLastHour(amp.id) >= cap) {
      // Plafond atteint : on repousse plutot que d'abandonner le retweet.
      reschedule(job.id, Date.now() + 10 * 60_000);
      continue;
    }

    const author = db.prepare('SELECT username FROM accounts WHERE id = ?').get(job.author_id);
    if (!author) {
      finishJob(job.id, 'skipped', 'Compte source retire');
      continue;
    }

    handled.add(job.amplifier_id);
    processed++;
    db.prepare('UPDATE jobs SET attempts = attempts + 1, updated_at = ? WHERE id = ?').run(Date.now(), job.id);

    try {
      const creds = sessionOf(amp);
      const result = await retweet(amp.id, {
        tweetId: job.tweet_id,
        authorHandle: author.username,
        authToken: creds.authToken,
        ct0: creds.ct0,
        proxyUrl: creds.proxyUrl,
        headless: !!num(settings, 'headless'),
      });
      finishJob(job.id, 'done');
      setError(amp.id, null);
      log.info(
        result === 'already'
          ? `@${amp.username} avait deja retweete ${job.tweet_id}.`
          : `@${amp.username} a retweete ${job.tweet_id}.`
      );
    } catch (err) {
      const kind = handleApiError(amp, err, 'retweet');

      // Ces cas ne sont pas la faute du job : il attend, il n'est pas perdu.
      // 'automation' : tres longue attente, le compte est de toute facon exclu
      // du circuit par needs_attention jusqu'a decision de l'utilisateur.
      const hold = { attention: 30, session: 15, blocked: 30, stale: 10, automation: 120 }[kind];
      if (hold) {
        reschedule(job.id, Date.now() + hold * 60_000, err.message);
        continue;
      }
      if (kind === 'ratelimit') {
        reschedule(job.id, rateLimited.get(amp.id) + 5_000, err.message);
        continue;
      }

      const attempts = job.attempts + 1;
      if (attempts >= MAX_ATTEMPTS) finishJob(job.id, 'failed', err.message);
      else reschedule(job.id, Date.now() + 2 ** attempts * 60_000, err.message);
    }
  }
}

// ------------------------------------------- verification des sessions

async function checkStaleSession(settings) {
  const intervalMs = num(settings, 'session_check_hours') * 3_600_000;
  if (intervalMs <= 0) return;

  // Un seul controle par tick. Best-effort : on ne desactive une session que si
  // X confirme que les cookies sont invalides ; une verification impossible
  // (endpoint indisponible) n'invalide jamais une session qui marche peut-etre.
  const stale = db
    .prepare(
      `SELECT * FROM accounts
        WHERE enabled = 1 AND role IN ('amplifier', 'both')
          AND session_ok = 1 AND needs_attention = 0
          AND (session_checked_at IS NULL OR session_checked_at < ?)
        ORDER BY COALESCE(session_checked_at, 0) LIMIT 1`
    )
    .get(Date.now() - intervalMs);
  if (!stale) return;

  db.prepare('UPDATE accounts SET session_checked_at = ? WHERE id = ?').run(Date.now(), stale.id);
  try {
    await checkCookies(sessionOf(stale));
    setError(stale.id, null);
  } catch (err) {
    // Seule une SessionError confirmee desactive la session (via handleApiError).
    handleApiError(stale, err, 'verification de session');
  }
}

// ---------------------------------------------------------------- boucles

let ticking = false;

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const settings = getSettings();
    if (num(settings, 'paused')) return;

    await pollNextSource(settings);
    await runDueJobs(settings);
    await checkStaleSession(settings);
  } catch (err) {
    log.error(`Erreur inattendue dans la boucle : ${err.message}`);
  } finally {
    ticking = false;
  }
}

export function startEngine() {
  setInterval(tick, WORKER_TICK_MS);
  setInterval(trimLogs, 10 * 60_000);
  setTimeout(tick, 2_000);
  log.info('Moteur demarre.');
}

/**
 * A appeler quand les reglages changent : permet de re-signaler un identifiant
 * de requete toujours perime apres une correction infructueuse.
 */
export function onSettingsChanged() {
  staleLogged.clear();
}

/** Declenche une detection immediate et forcee (bouton « Verifier maintenant »). */
export async function pollNow() {
  if (ticking) return;
  ticking = true;
  try {
    const settings = getSettings();
    if (num(settings, 'paused')) return;
    lastAttemptAt.clear();
    detectPauseUntil = 0; // on ignore la pause : l'utilisateur veut reessayer
    await pollNextSource(settings, { force: true });
    await runDueJobs(settings);
  } finally {
    ticking = false;
  }
}

/**
 * Etat de la detection. Les limites etant desormais rattachees aux sessions et
 * non a l'IP, l'intervalle n'est plus contraint par un quota partage : un seul
 * compte est lu par cycle, d'ou l'intervalle effectif ci-dessous.
 */
export function detectionStatus(settings) {
  const sourceCount = sources().length;
  const readerCount = amplifiers().filter((a) => a.auth_token && a.ct0).length;
  const configured = Math.max(30, num(settings, 'poll_interval_sec'));
  const spacingSec = WORKER_TICK_MS / 1000;
  return {
    sourceCount,
    readerCount,
    configuredIntervalSec: configured,
    effectiveIntervalSec: Math.max(configured, sourceCount * spacingSec),
    pausedUntil: detectPauseUntil > Date.now() ? detectPauseUntil : null,
  };
}
