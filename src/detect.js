/**
 * Helpers de comparaison d'identifiants de posts.
 *
 * Les identifiants X sont des « snowflakes » : strictement croissants dans le
 * temps. Comparer les identifiants plutot que les dates evite deux pieges — les
 * posts epingles, qui remontent en tete de timeline sans etre les plus recents,
 * et les imprecisions de fuseau sur `created_at`.
 *
 * Ils depassent Number.MAX_SAFE_INTEGER : la comparaison se fait en BigInt.
 */

/** Vrai si `id` est posterieur au curseur. Faux si le curseur est absent. */
export function isNewer(id, cursor) {
  if (!cursor) return false;
  try {
    return BigInt(id) > BigInt(cursor);
  } catch {
    return false;
  }
}

/** Plus grand identifiant d'une liste, ou null. */
export function maxId(ids) {
  let best = null;
  for (const id of ids) {
    try {
      if (best === null || BigInt(id) > BigInt(best)) best = id;
    } catch {
      /* identifiant inattendu : ignore */
    }
  }
  return best;
}
