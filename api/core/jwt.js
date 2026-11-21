// @ts-check

const GOOGLE_JWKS = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISS = ['https://accounts.google.com', 'accounts.google.com'];
// Personal Microsoft accounts only (Hotmail, Outlook, Live): the `consumers` endpoint and its fixed tenant id.
const MS_JWKS = 'https://login.microsoftonline.com/consumers/discovery/v2.0/keys';
const MS_CONSUMER_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad';
const MS_ISS = `https://login.microsoftonline.com/${MS_CONSUMER_TENANT}/v2.0`;

const CACHE_MS = 3_600_000;          // normal key cache: 1 hour
const FORCED_REFRESH_MS = 300_000;   // an unknown key id may force a re-fetch, but at most once per 5 minutes per provider

/**
 * @typedef {'google' | 'microsoft'} Provider
 * @typedef {{ provider: Provider, subject: string, email: string, emailVerified: boolean, name: string }} Identity
 */

/** @param {string} s @returns {Uint8Array} */
const b64u = (s) => {
  const t = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=');
  const bin = atob(t);
  return Uint8Array.from(bin, c => c.charCodeAt(0));
};
/** @param {string} s */
const parseJson = (s) => JSON.parse(new TextDecoder().decode(b64u(s)));
/** @param {import('./types.js').Deps} deps */
const clock = (deps) => deps.now?.() ?? Date.now();

/** The providers' public signing keys, cached in memory. One instance per app; tests make their own. */
export class KeyCache {
  constructor() {
    /** @type {Map<string, { at: number, keys: any[] }>} */
    this.hits = new Map();
    /** @type {Map<string, number>} */
    this.lastForced = new Map();
  }

  /**
   * Returns the keys. `fetched` says whether this call went to the network.
   * @param {string} url
   * @param {import('./types.js').Deps} deps
   * @param {boolean} [forceFresh]
   * @returns {Promise<{ keys: any[], fetched: boolean }>}
   */
  async get(url, deps, forceFresh = false) {
    const now = clock(deps);
    const hit = this.hits.get(url);
    if (hit && !forceFresh && now - hit.at < CACHE_MS) return { keys: hit.keys, fetched: false };
    if (forceFresh) {
      // Throttle: tokens signed with a made-up key id must not make the Worker hammer Google or Microsoft.
      const last = this.lastForced.get(url);
      if (hit && last !== undefined && now - last < FORCED_REFRESH_MS) return { keys: hit.keys, fetched: false };
      this.lastForced.set(url, now);   // recorded before the fetch, so a failing fetch is throttled too
    }
    const fetcher = deps.fetchJwks ?? (async (/** @type {string} */ u) => {
      const r = await fetch(u);
      if (!r.ok) throw new Error('jwks_fetch_failed');
      return /** @type {Promise<{ keys: any[] }>} */ (r.json());
    });
    const body = await fetcher(url);
    this.hits.set(url, { at: now, keys: body.keys });
    return { keys: body.keys, fetched: true };
  }
}

/**
 * Verifies an OpenID Connect ID token's RS256 signature with WebCrypto and checks iss, aud (one client id), exp, nbf, iat
 * and the nonce. The nbf/iat checks and their tolerances are the same as Packr's jwt.js. Throws on any problem.
 *
 * Nonce: for Microsoft the token's nonce must be present and equal to `nonce`. For Google, if a `nonce` is given it must
 * equal the token's nonce; if none is given nothing is checked.
 *
 * @param {string} token
 * @param {Provider} provider
 * @param {string | undefined} clientId
 * @param {import('./types.js').Deps} deps
 * @param {KeyCache} keys
 * @param {string} [nonce]
 * @returns {Promise<Identity>}
 */
export async function verifyIdToken(token, provider, clientId, deps, keys, nonce) {
  if (!clientId) throw new Error('provider_not_configured');
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed');
  const header = parseJson(parts[0]);
  const claims = parseJson(parts[1]);
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new Error('bad_alg');

  const url = provider === 'google' ? GOOGLE_JWKS : MS_JWKS;
  const first = await keys.get(url, deps);
  let jwk = first.keys.find(k => k.kid === header.kid);
  // Unknown key id: the provider may have rotated its keys. Re-fetch once, unless we only just fetched (nothing newer to
  // get) or a forced re-fetch already happened in the last 5 minutes.
  if (!jwk && !first.fetched) jwk = (await keys.get(url, deps, true)).keys.find(k => k.kid === header.kid);
  if (!jwk) throw new Error('unknown_key');

  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, /** @type {BufferSource} */ (b64u(parts[2])), new TextEncoder().encode(parts[0] + '.' + parts[1]));
  if (!ok) throw new Error('bad_signature');

  const nowSec = Math.floor(clock(deps) / 1000);
  if (typeof claims.exp !== 'number' || claims.exp < nowSec - 60) throw new Error('expired');   // 60 s of clock difference allowed
  if (typeof claims.nbf === 'number' && claims.nbf > nowSec + 30) throw new Error('not_yet_valid');
  if (typeof claims.iat === 'number' && claims.iat > nowSec + 300) throw new Error('issued_in_future');
  if (claims.aud !== clientId) throw new Error('bad_audience');
  if (typeof claims.sub !== 'string' || !claims.sub) throw new Error('no_subject');

  if (provider === 'google') {
    if (!GOOGLE_ISS.includes(claims.iss)) throw new Error('bad_issuer');
    if (nonce !== undefined && claims.nonce !== nonce) throw new Error('bad_nonce');
    const email = typeof claims.email === 'string' ? claims.email.toLowerCase() : '';
    if (!email) throw new Error('no_email');
    return {
      provider, subject: claims.sub, email, name: String(claims.name ?? ''),
      emailVerified: claims.email_verified === true || claims.email_verified === 'true',
    };
  }
  if (claims.iss !== MS_ISS || claims.tid !== MS_CONSUMER_TENANT) throw new Error('bad_issuer');
  if (typeof nonce !== 'string' || !nonce || claims.nonce !== nonce) throw new Error('bad_nonce');
  const email = String(claims.email ?? claims.preferred_username ?? '').toLowerCase();
  if (!email) throw new Error('no_email');
  // Microsoft sends no verified-email claim: never treated as verified.
  return { provider, subject: claims.sub, email, name: String(claims.name ?? ''), emailVerified: false };
}
