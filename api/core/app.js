// @ts-check
import { HttpError, allowedOrigins, json, notFound } from './util.js';
import { KeyCache } from './jwt.js';

/** @typedef {import('./types.js').CoreCtx} CoreCtx */
/** @typedef {import('./types.js').CoreEnv} CoreEnv */
/** @typedef {import('./types.js').Deps} Deps */

/**
 * @template {CoreCtx} C
 * @typedef {object} AppOptions
 * @property {import('./types.js').Route<C>[]} routes   The app's route table: method, path, a guard NAME and a handler. The core knows nothing about the routes.
 * @property {Record<string, import('./types.js').GuardFn<C>>} guards   What each guard name means. Every guard name used in `routes` must be here, or createApp throws.
 * @property {Partial<import('./types.js').UserNaming>} [naming]   The users table's display-name column and the JSON field name. Default: column `name`, field `name`.
 */

const IDENT = /^[a-z_][a-z0-9_]*$/i;

/**
 * Matches a path against a pattern like /trips/:id/members. Returns the parameters, or null for no match (including a
 * path whose %-escapes cannot be decoded, which is simply "not found").
 * @param {string} pattern
 * @param {string} path
 * @returns {Record<string, string> | null}
 */
export function match(pattern, path) {
  const a = pattern.split('/'), b = path.split('/');
  if (a.length !== b.length) return null;
  /** @type {Record<string, string>} */
  const params = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith(':')) {
      if (!b[i]) return null;
      try { params[a[i].slice(1)] = decodeURIComponent(b[i]); } catch { return null; }
    } else if (a[i] !== b[i]) return null;
  }
  return params;
}

/**
 * Builds the Worker's request handler.
 *
 * Every request goes through `handle`, in this order:
 *  1. Origin check: a browser request from an origin that is not on ALLOWED_ORIGINS gets 403 before any other work.
 *  2. CORS preflight (OPTIONS).
 *  3. Routing: the first route whose path and method match; its guard runs, then its handler.
 *  4. Errors become JSON ({ error: code }); anything unexpected is a plain 500 with no detail.
 *
 * @template {CoreCtx} C
 * @param {AppOptions<C>} opts
 */
export function createApp(opts) {
  /** @type {import('./types.js').UserNaming} */
  const naming = { column: opts.naming?.column ?? 'name', field: opts.naming?.field ?? 'name' };
  // The column name is put into SQL text, so it must be a plain identifier.
  if (!IDENT.test(naming.column) || !IDENT.test(naming.field)) throw new Error('core: naming.column and naming.field must be plain identifiers');
  for (const r of opts.routes) {
    if (!opts.guards[r.guard]) throw new Error(`core: route ${r.method} ${r.path} uses guard "${r.guard}", which is not in the guards table`);
  }
  const keys = new KeyCache();

  /** @param {Request} req @param {CoreEnv} env @param {Deps} deps */
  async function dispatch(req, env, deps) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    let pathMatched = false;
    for (const r of opts.routes) {
      const params = match(r.path, path);
      if (!params) continue;
      pathMatched = true;
      if (r.method !== req.method) continue;
      const ctx = /** @type {C} */ (/** @type {unknown} */ ({ req, env, deps, params, url, naming, keys }));
      await opts.guards[r.guard](ctx);
      return r.handler(ctx);
    }
    throw pathMatched ? new HttpError(405, 'method_not_allowed') : notFound();
  }

  /**
   * @param {Request} req
   * @param {CoreEnv} env
   * @param {Deps} [deps]
   * @returns {Promise<Response>}
   */
  async function handle(req, env, deps = {}) {
    const origin = req.headers.get('origin');
    const allowed = origin !== null && allowedOrigins(env).includes(origin);
    // A browser always sends Origin on a cross-site request. If it is not on the list, refuse before any work: no sign-in
    // check, no database. (A request with no Origin header is not from a browser page, e.g. curl, and still needs a token.)
    if (origin !== null && !allowed) {
      return new Response(JSON.stringify({ error: 'origin_not_allowed' }), { status: 403,
        headers: { 'content-type': 'application/json; charset=utf-8', vary: 'Origin', 'cache-control': 'no-store' } });
    }
    /** @type {Record<string, string>} */
    const cors = { vary: 'Origin' };
    if (allowed && origin) cors['access-control-allow-origin'] = origin;

    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: {
        ...cors, 'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
        'access-control-allow-headers': 'authorization,content-type', 'access-control-max-age': '600' } });
    }

    /** @type {Response} */
    let res;
    try {
      res = await dispatch(req, env, deps);
    } catch (e) {
      if (e instanceof HttpError) res = json(e.body(), e.status);
      else { console.error('unhandled', e); res = json({ error: 'internal' }, 500); }
    }
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
    out.headers.set('cache-control', 'no-store');
    return out;
  }

  return { handle, routes: opts.routes };
}
