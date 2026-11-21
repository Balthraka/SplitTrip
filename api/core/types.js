// @ts-check
// Type definitions only (JSDoc). This file has no runtime code; editors and `tsc` read the types from it.

/**
 * What the core needs from the Worker's bindings and variables. An app's Env may add its own.
 * @typedef {object} CoreEnv
 * @property {D1Database} DB
 * @property {string} [ALLOW_SIGNUPS]    "true" = anyone who signs in is created; anything else = private mode (only emails already in `users`)
 * @property {string} [GOOGLE_CLIENT_ID] the one accepted audience for Google ID tokens
 * @property {string} [MS_CLIENT_ID]     the one accepted audience for Microsoft ID tokens (empty = Microsoft sign-in off)
 * @property {string} [ALLOWED_ORIGINS]  comma-separated exact origins allowed to call the API from a browser
 * @property {string} [SESSION_DAYS]     session lifetime in days, default 30
 */

/**
 * Test seam. Production passes nothing. Tests inject fakes here, so the live code has no test-only setting or variable.
 * `now` is the clock; `fetchJwks` replaces the network call for the providers' public keys; `keyCache` gives a test its
 * own key cache so one test's keys never leak into the next.
 * @typedef {object} Deps
 * @property {(url: string) => Promise<{ keys: any[] }>} [fetchJwks]
 * @property {() => number} [now]
 * @property {import('./jwt.js').KeyCache} [keyCache]
 */

/**
 * @typedef {object} Session
 * @property {string} userId
 * @property {string} email
 * @property {string} name            the user's display name, whatever the app's column is called
 * @property {boolean} verifiedEmail  true only when the provider vouched for the email (Google)
 */

/**
 * The users table's display-name column and the name of that field in JSON replies.
 * SplitTrip: { column: 'name', field: 'name' }. Packr: { column: 'display_name', field: 'displayName' }.
 * @typedef {object} UserNaming
 * @property {string} column
 * @property {string} field
 */

/**
 * What every route handler and guard receives. An app extends it with its own fields (SplitTrip adds `trip`).
 * @template {CoreEnv} [E=CoreEnv]
 * @typedef {object} CoreCtx
 * @property {Request} req
 * @property {E} env
 * @property {Deps} deps
 * @property {Record<string, string>} params
 * @property {URL} url
 * @property {Session} session        set by the `user` guard (see userGuard); absent on public routes
 * @property {UserNaming} naming
 * @property {import('./jwt.js').KeyCache} keys
 */

/**
 * A guard runs before the handler. It may throw an HttpError, and may set fields on the context.
 * @template C
 * @typedef {(ctx: C) => Promise<void>} GuardFn
 */

/**
 * `guard` is just a name; the app decides what each name means by passing a guards table to createApp.
 * @template C
 * @typedef {object} Route
 * @property {string} method
 * @property {string} path
 * @property {string} guard
 * @property {(ctx: C) => Promise<Response>} handler
 */

export {};
