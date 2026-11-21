// @ts-check
import { HttpError, bad, forbidden, json, newId, nowIso, randomToken, readJson, sha256Hex } from './util.js';
import { verifyIdToken } from './jwt.js';

/** @typedef {import('./types.js').CoreEnv} CoreEnv */
/** @typedef {import('./types.js').CoreCtx} CoreCtx */

/** @param {CoreEnv} env */
const sessionMs = (env) => Math.max(1, Number(env.SESSION_DAYS ?? 30) || 30) * 86_400_000;

/**
 * POST /auth/google and /auth/microsoft handler (the app puts it on a `public` route).
 * Body: { idToken, nonce? }. Verifies the provider's ID token, finds or links the user, and returns a new session token.
 * The reply is { token, user: { id, email, <naming.field> } }. The tables used are `users`, `identities` and `sessions`
 * (see core/schema.sql).
 *
 * Nonce: Microsoft sign-in needs one (the token's nonce must equal body.nonce). For Google it is optional, but if one is
 * sent it must match the token.
 *
 * @param {'google' | 'microsoft'} provider
 * @param {Pick<CoreCtx, 'req' | 'env' | 'deps' | 'naming' | 'keys'>} ctx
 * @returns {Promise<Response>}
 */
export async function login(provider, ctx) {
  const body = await readJson(ctx.req);
  const idToken = body.idToken;
  if (typeof idToken !== 'string' || idToken.length > 4096) throw new HttpError(400, 'invalid_token');
  const nonce = body.nonce;
  if (nonce !== undefined && (typeof nonce !== 'string' || nonce.length > 200)) throw bad('invalid_nonce');
  const clientId = provider === 'google' ? ctx.env.GOOGLE_CLIENT_ID : ctx.env.MS_CLIENT_ID;
  if (!clientId) throw new HttpError(503, 'provider_not_configured');

  /** @type {import('./jwt.js').Identity} */
  let ident;
  try { ident = await verifyIdToken(idToken, provider, clientId, ctx.deps, ctx.deps.keyCache ?? ctx.keys, nonce); }
  catch { throw new HttpError(401, 'invalid_token'); }

  const db = ctx.env.DB;
  const now = ctx.deps.now?.() ?? Date.now();
  const col = ctx.naming.column;   // validated as a plain identifier when the app is created

  // 1. A previously linked identity always wins (matched on the provider's stable `sub`, never on email again).
  /** @type {{ id: string, email: string, name: string } | null} */
  let user = await db.prepare(
    `SELECT u.id, u.email, u.${col} AS name FROM identities i JOIN users u ON u.id = i.user_id WHERE i.provider = ?1 AND i.subject = ?2`
  ).bind(provider, ident.subject).first();

  let linking = false;
  if (!user) {
    // 2. First sign-in with this provider: link to the existing user with this email.
    //    Google must report the email as verified. Microsoft sends no such claim, so the `users` table acts as the
    //    hand-checked allowlist (private mode).
    if (provider === 'google' && !ident.emailVerified) throw new HttpError(403, 'email_not_verified');
    user = await db.prepare(`SELECT id, email, ${col} AS name FROM users WHERE email = ?1`).bind(ident.email).first();
    if (user) {
      // One identity per provider per user: refuse if this user is already linked to a different Google/Microsoft account.
      const other = await db.prepare('SELECT 1 AS x FROM identities WHERE user_id = ?1 AND provider = ?2').bind(user.id, provider).first();
      if (other) throw forbidden('account_already_linked');
      linking = true;
    } else if (ctx.env.ALLOW_SIGNUPS === 'true') {
      // Open signups never create a user from an email the provider did not report as verified (Microsoft never does).
      if (!ident.emailVerified) throw new HttpError(403, 'email_not_verified');
      user = { id: newId(), email: ident.email, name: ident.name || ident.email.split('@')[0] };
      await db.prepare(`INSERT INTO users (id, email, ${col}, created_at) VALUES (?1, ?2, ?3, ?4)`)
        .bind(user.id, user.email, user.name, nowIso(now)).run();
      linking = true;
    } else {
      throw forbidden('not_invited');   // private mode
    }
  }

  const token = randomToken();
  const stmts = [
    db.prepare('DELETE FROM sessions WHERE user_id = ?1 AND expires_at < ?2').bind(user.id, nowIso(now)),
    db.prepare('INSERT INTO sessions (token_hash, user_id, verified_email, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)')
      .bind(await sha256Hex(token), user.id, ident.emailVerified ? 1 : 0, nowIso(now), nowIso(now + sessionMs(ctx.env))),
  ];
  if (linking) {
    stmts.unshift(db.prepare('INSERT INTO identities (provider, subject, user_id, created_at) VALUES (?1, ?2, ?3, ?4)')
      .bind(provider, ident.subject, user.id, nowIso(now)));
  }
  await db.batch(stmts);
  return json({ token, user: { id: user.id, email: user.email, [ctx.naming.field]: user.name } });
}

/**
 * The one shared sign-in check. Returns the session or throws 401.
 * @param {Request} req
 * @param {CoreEnv} env
 * @param {import('./types.js').Deps} deps
 * @param {import('./types.js').UserNaming} naming
 * @returns {Promise<import('./types.js').Session>}
 */
export async function authenticate(req, env, deps, naming) {
  const h = req.headers.get('authorization') ?? '';
  const m = /^Bearer ([A-Za-z0-9_-]{20,100})$/.exec(h);
  if (!m) throw new HttpError(401, 'unauthorized');
  /** @type {any} */
  const row = await env.DB.prepare(
    `SELECT s.user_id, s.verified_email, u.email, u.${naming.column} AS name
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?1 AND s.expires_at > ?2`
  ).bind(await sha256Hex(m[1]), nowIso(deps.now?.() ?? Date.now())).first();
  if (!row) throw new HttpError(401, 'unauthorized');
  return { userId: row.user_id, email: row.email, name: row.name, verifiedEmail: row.verified_email === 1 };
}

/**
 * Guard for routes that need no sign-in (the app should only use it for /auth/*).
 * @param {unknown} _ctx
 * @returns {Promise<void>}
 */
export const publicGuard = async (_ctx) => {};

/**
 * Guard for routes that need a signed-in user. Sets ctx.session, or throws 401. App guards call this first.
 * @param {CoreCtx} ctx
 * @returns {Promise<void>}
 */
export async function userGuard(ctx) {
  ctx.session = await authenticate(ctx.req, ctx.env, ctx.deps, ctx.naming);
}

/**
 * POST /me/logout handler: deletes the session this token belongs to.
 * @param {CoreCtx} c
 * @returns {Promise<Response>}
 */
export async function logout(c) {
  const m = /^Bearer (\S+)$/.exec(c.req.headers.get('authorization') ?? '');
  if (m) await c.env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?1').bind(await sha256Hex(m[1])).run();
  return json({ ok: true });
}
