/**
 * Client de l'API GraphQL interne de X — celle qu'utilise le site lui-meme.
 *
 * Authentification par les cookies d'une session ouverte a la main dans un
 * navigateur normal (auth_token + ct0). Aucune application declaree, aucun
 * quota facture : on emet les memes requetes que le client web.
 *
 * Fragilite assumee : les identifiants de requete GraphQL changent au rythme
 * des deploiements de X. Ils sont donc modifiables depuis les reglages, sans
 * toucher au code.
 */

// Bearer public du client web de X, identique pour tout le monde et stable
// depuis des annees. Ce n'est pas un secret : il est en clair dans le JS du site.
import { ProxyAgent } from 'undici';

const WEB_BEARER =
  'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Session invalide ou expiree : l'utilisateur doit reimporter ses cookies. */
export class SessionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SessionError';
  }
}

/**
 * Code 226 : X a identifie la requete comme automatisee et refuse l'action.
 *
 * Ce n'est pas une panne technique — c'est la detection anti-spam de X. Insister
 * est le meilleur moyen de faire passer le compte de « signale » a « verrouille » :
 * le moteur doit donc s'arreter sur ce compte, pas reessayer.
 */
export class AutomationBlockedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AutomationBlockedError';
  }
}

/** Compte verrouille ou suspendu par X : intervention manuelle requise. */
export class LockedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LockedError';
  }
}

export class RateLimitError extends Error {
  constructor(message, resetAt) {
    super(message);
    this.name = 'RateLimitError';
    this.resetAt = resetAt;
  }
}

/** X refuse un doublon : de notre point de vue le resultat est atteint. */
export class AlreadyRetweetedError extends Error {
  constructor() {
    super('Post deja retweete par ce compte.');
    this.name = 'AlreadyRetweetedError';
  }
}

/**
 * 404 sur une operation GraphQL : X ne connait pas cet identifiant de requete.
 * Il a change lors d'un deploiement et doit etre remis a jour dans les reglages.
 */
export class StaleQueryIdError extends Error {
  constructor(operation, settingLabel) {
    super(
      `Operation ${operation} introuvable (404) : l'identifiant de requete est perime. ` +
        `Mets a jour « ${settingLabel} » dans les reglages (voir README).`
    );
    this.name = 'StaleQueryIdError';
    this.operation = operation;
  }
}

/** L'endpoint exige un en-tete que seul le JS du site sait generer. */
export class ClientVerificationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ClientVerificationError';
  }
}

/**
 * Proxy par compte.
 *
 * Les comptes geres par des VA vivent derriere une IP stable. Se connecter
 * depuis une autre adresse declenche une alerte de securite legitime chez X :
 * on route donc les requetes d'un compte par le meme proxy que son operateur.
 *
 * Les agents sont mis en cache par URL — en creer un par requete ouvrirait un
 * nouveau pool de connexions a chaque appel.
 */
const dispatchers = new Map();

export function dispatcherFor(proxyUrl) {
  if (!proxyUrl) return undefined;
  if (!dispatchers.has(proxyUrl)) {
    dispatchers.set(proxyUrl, new ProxyAgent({ uri: proxyUrl }));
  }
  return dispatchers.get(proxyUrl);
}

/** Libere l'agent d'un proxy retire ou modifie. */
export function releaseProxy(proxyUrl) {
  const agent = dispatchers.get(proxyUrl);
  if (!agent) return;
  dispatchers.delete(proxyUrl);
  agent.close?.().catch(() => {});
}

function headers({ authToken, ct0 }, { json = false } = {}) {
  const h = {
    authorization: `Bearer ${WEB_BEARER}`,
    cookie: `auth_token=${authToken}; ct0=${ct0}`,
    'x-csrf-token': ct0,
    'x-twitter-auth-type': 'OAuth2Session',
    'x-twitter-active-user': 'yes',
    'x-twitter-client-language': 'fr',
    'user-agent': UA,
    origin: 'https://x.com',
    referer: 'https://x.com/',
  };
  // content-type seulement quand il y a un corps : l'envoyer sur un GET sans
  // corps declenche un 404 « page does not exist » cote proxy de X.
  if (json) h['content-type'] = 'application/json';
  return h;
}

/** Codes d'erreur renvoyes par X dans le corps de la reponse. */
const CODES = {
  ALREADY_RETWEETED: 327,
  NOT_AUTHENTICATED: 32,
  USER_SUSPENDED: 63,
  ACCOUNT_SUSPENDED: 64,
  RATE_LIMIT: 88,
  ACCOUNT_LOCKED: 326,
  AUTOMATED_REQUEST: 226,
};

function collectErrors(json) {
  const list = Array.isArray(json?.errors) ? json.errors : [];
  return list.map((e) => ({ code: Number(e.code ?? e.extensions?.code ?? 0), message: String(e.message || '') }));
}

function rateLimitReset(res) {
  const reset = Number(res.headers.get('x-rate-limit-reset'));
  return Number.isFinite(reset) && reset > 0 ? reset * 1000 : Date.now() + 15 * 60_000;
}

/** Traduit une reponse d'erreur en exception typee, exploitable par le moteur. */
function raise(res, json, context, gql) {
  const errors = collectErrors(json);
  const codes = errors.map((e) => e.code);
  const text = errors.map((e) => e.message).join(' | ') || `HTTP ${res.status}`;

  // 404 sur une operation GraphQL = identifiant de requete inconnu de X.
  if (res.status === 404 && gql) throw new StaleQueryIdError(gql.operation, gql.setting);

  if (codes.includes(CODES.ALREADY_RETWEETED) || /already retweeted/i.test(text)) {
    throw new AlreadyRetweetedError();
  }
  if (codes.includes(CODES.AUTOMATED_REQUEST)) {
    throw new AutomationBlockedError('X a identifie la requete comme automatisee et a refuse l\'action (code 226).');
  }
  if (codes.includes(CODES.ACCOUNT_LOCKED)) throw new LockedError(`Compte verrouille par X : ${text}`);
  if (codes.includes(CODES.USER_SUSPENDED) || codes.includes(CODES.ACCOUNT_SUSPENDED)) {
    throw new LockedError(`Compte suspendu : ${text}`);
  }
  if (codes.includes(CODES.RATE_LIMIT) || res.status === 429) {
    throw new RateLimitError(`Limite de debit X atteinte (${context}).`, rateLimitReset(res));
  }
  if (codes.includes(CODES.NOT_AUTHENTICATED) || res.status === 401) {
    throw new SessionError('Session invalide ou expiree : reimporte les cookies.');
  }
  if (res.status === 403) {
    // Signature typique d'un en-tete de verification client manquant.
    if (/transaction|client.?verification|denied/i.test(text)) {
      throw new ClientVerificationError(
        `X refuse la requete (${context}) : ${text}. L'endpoint exige probablement un en-tete genere par le site.`
      );
    }
    throw new SessionError(`Acces refuse (${context}) : ${text}`);
  }
  throw new Error(`X a renvoye ${res.status} (${context}) : ${text.slice(0, 200)}`);
}

async function call(url, { method = 'GET', session, body, context, gql }) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: headers(session, { json: !!body }),
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
      // Route la requete par le proxy du compte quand il en a un.
      dispatcher: dispatcherFor(session.proxyUrl),
    });
  } catch (err) {
    const via = session.proxyUrl ? ' via le proxy du compte' : '';
    throw new Error(`Reseau indisponible (${context})${via} : ${err.message}`);
  }

  const raw = await res.text();
  let json = null;
  try {
    json = raw ? JSON.parse(raw) : null;
  } catch {
    // Reponse HTML : X sert une page de blocage plutot que du JSON.
    if (!res.ok) throw new SessionError(`Reponse inattendue de X (${context}, HTTP ${res.status}).`);
  }

  if (!res.ok || collectErrors(json).length) raise(res, json, context, gql);
  return json;
}

/**
 * Verifie que les cookies fonctionnent et renvoie le pseudo reellement
 * connecte. Sert a valider un import et a controler les sessions dormantes.
 */
/**
 * Verifie que les cookies authentifient bien un compte, en best-effort.
 *
 * X a desactive les endpoints REST v1.1 hérités (verify_credentials,
 * account/settings...) pour les sessions web : ils renvoient 404 meme avec des
 * cookies valides. On interroge donc badge_count, un endpoint v2 de generation
 * actuelle utilise par le client web.
 *
 * Renvoie { verified: true } si les cookies sont confirmes valides.
 * Leve SessionError s'ils sont confirmes invalides (401/code 32).
 * Renvoie { verified: false } si X ne permet pas de conclure (404, reseau) :
 * dans ce cas, seul le premier retweet tranchera.
 */
export async function checkCookies(session) {
  try {
    await call('https://api.x.com/2/badge_count/badge_count.json?supports_ntab_urt=1', {
      session,
      context: 'verification de session',
    });
    return { verified: true };
  } catch (err) {
    if (err instanceof SessionError) throw err;
    return { verified: false, reason: err.message };
  }
}

// ------------------------------------------------------- lecture GraphQL

/**
 * Appel GraphQL en lecture.
 *
 * X exige un objet `features` qui evolue a chaque deploiement : un champ
 * manquant fait echouer la requete avec « The following features cannot be
 * null: ... ». Plutot que de figer une liste qui perimera, on lit les champs
 * reclames dans le message d'erreur, on les ajoute, et on rejoue une fois.
 */
async function graphqlGet(session, { queryId, operation, variables, features = {}, context, setting }) {
  const gql = { operation, setting };
  const build = (feat) => {
    const url = new URL(`https://x.com/i/api/graphql/${encodeURIComponent(queryId)}/${operation}`);
    url.searchParams.set('variables', JSON.stringify(variables));
    url.searchParams.set('features', JSON.stringify(feat));
    return url.toString();
  };

  try {
    return await call(build(features), { session, context, gql });
  } catch (err) {
    const missing = String(err.message).match(/features cannot be null:\s*([^"|]+)/i);
    if (!missing) throw err;

    const healed = { ...features };
    for (const name of missing[1].split(',').map((s) => s.trim()).filter(Boolean)) healed[name] = false;
    return call(build(healed), { session, context: `${context} (features completees)`, gql });
  }
}

/** Resout un pseudo en identifiant numerique, a mettre en cache. */
export async function resolveUserId(session, handle, queryId) {
  if (!queryId) throw new Error('Identifiant de requete UserByScreenName manquant dans les reglages.');

  const json = await graphqlGet(session, {
    queryId,
    operation: 'UserByScreenName',
    variables: { screen_name: handle, withSafetyModeUserFields: true },
    features: { hidden_profile_subscriptions_enabled: true, responsive_web_graphql_timeline_navigation_enabled: true },
    context: `resolution de @${handle}`,
    setting: 'ID de requete UserByScreenName',
  });

  const id = json?.data?.user?.result?.rest_id;
  if (!id) throw new Error(`Impossible de resoudre @${handle} en identifiant numerique.`);
  return String(id);
}

/**
 * Collecte les tweets dans la reponse GraphQL.
 *
 * La structure de la timeline change souvent (timeline / timeline_v2,
 * instructions imbriquees...). On parcourt donc l'arbre en profondeur en
 * ramassant tout objet de type Tweet, ce qui resiste aux reorganisations.
 * Le filtrage par `user_id_str` ecarte les originaux imbriques dans un retweet.
 */
function collectTweets(node, targetUserId, out = new Map()) {
  if (!node || typeof node !== 'object') return out;

  if (Array.isArray(node)) {
    for (const item of node) collectTweets(item, targetUserId, out);
    return out;
  }

  const legacy = node.legacy;
  if (legacy && legacy.id_str && (node.__typename === 'Tweet' || node.rest_id)) {
    if (!targetUserId || legacy.user_id_str === targetUserId) {
      const text = legacy.full_text || '';
      out.set(legacy.id_str, {
        id: legacy.id_str,
        text,
        createdAt: legacy.created_at ? new Date(legacy.created_at).getTime() : null,
        isRetweet: !!legacy.retweeted_status_result || /^RT @/.test(text),
        isReply: !!legacy.in_reply_to_status_id_str,
      });
    }
  }

  for (const key of Object.keys(node)) collectTweets(node[key], targetUserId, out);
  return out;
}

/** Posts recents d'un compte, du plus ancien au plus recent. */
export async function fetchUserTweets(session, userId, queryId, { count = 20 } = {}) {
  if (!queryId) throw new Error('Identifiant de requete UserTweets manquant dans les reglages.');

  const json = await graphqlGet(session, {
    queryId,
    operation: 'UserTweets',
    variables: {
      userId: String(userId),
      count,
      includePromotedContent: false,
      withQuickPromoteEligibilityTweetFields: false,
      withVoice: false,
      withV2Timeline: true,
    },
    features: { responsive_web_graphql_timeline_navigation_enabled: true },
    context: 'lecture de timeline',
    setting: 'ID de requete UserTweets',
  });

  const tweets = [...collectTweets(json, String(userId)).values()];
  tweets.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
  return tweets;
}

// Le retweet ne passe plus par cette API : il est publie dans un vrai Chromium
// (voir browser.js), ou le JavaScript de X produit lui-meme les jetons
// anti-robot que l'appel direct ne pouvait pas fournir.
