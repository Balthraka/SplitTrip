# core/: the shared sign-in and request layer

One folder, copied into each app's Worker (no package, no shared deployment: apps stay fully separate).
It holds the parts that must behave identically in every app, and nothing else. It has no routes of its own.

**Plain JavaScript (ES modules) with JSDoc types and `// @ts-check`**, so apps written in TypeScript or in plain JS import it unchanged and plain Node can run it. Imports inside `core/` use `.js` extensions. The copies must stay identical: `node scripts/check-core.mjs <app-folder> <app-folder> ...` fails if any file differs (by hash, line endings ignored).

| File | What it does |
|---|---|
| `app.js` | `createApp({ routes, guards, naming })` builds the Worker's `handle(req, env, deps)`: origin check, CORS preflight, routing, guard, handler, error replies |
| `auth.js` | `login('google' \| 'microsoft', ctx)` (sign-in, linking, private mode, session), `userGuard` (the signed-in check), `publicGuard`, `logout` |
| `jwt.js` | `verifyIdToken` (RS256 signature, issuer, one audience, `exp`, `nbf`, `iat`) and `KeyCache` (provider keys, cached an hour, forced re-fetch at most once per 5 minutes) |
| `util.js` | `HttpError` and helpers (`bad`, `notFound`, `forbidden`, `conflict`), `json`, ids, SHA-256, `readJson`, `allowedOrigins` |
| `types.js` | JSDoc type definitions only: `CoreEnv`, `Deps`, `Session`, `CoreCtx`, `Route`, `GuardFn`, `UserNaming` (no runtime code) |
| `schema.sql` | the three tables the core reads and writes: `users`, `identities`, `sessions` |
| `index.js` | what an app imports |
| `test/` | tests of the core alone (vitest, TypeScript), on a tiny demo app. They do not import anything from `src/`. The other apps copy the six code files and `schema.sql`, not `test/`; `check-core` skips `test/` unless you pass `--with-tests` |

## How an app plugs in

The app owns its **route table** and its **guard names**. The core only runs what it is given.

```ts
import { createApp, login, logout, publicGuard, userGuard, forbidden, type CoreCtx, type GuardFn, type Route } from '../core';

type Ctx = CoreCtx & { trip?: Trip };                       // the app's context: the core's fields plus its own

export const routes: Route<Ctx>[] = [
  { method: 'POST', path: '/auth/google',    guard: 'public', handler: c => login('google', c) },
  { method: 'POST', path: '/auth/microsoft', guard: 'public', handler: c => login('microsoft', c) },
  { method: 'POST', path: '/me/logout',      guard: 'user',   handler: logout },
  { method: 'GET',  path: '/things/:id',     guard: 'owner',  handler: getThing },          // the app's own routes
];

const guards: Record<string, GuardFn<Ctx>> = {
  public: publicGuard,                                       // no token
  user: userGuard,                                           // valid bearer token; sets ctx.session
  owner: async c => { await userGuard(c); /* the app's own check, may set ctx fields or throw */ },
};

export const app = createApp<Ctx>({ routes, guards, naming: { column: 'name', field: 'name' } });
```

```ts
// src/index.ts
export default { fetch: (req: Request, env: Env) => app.handle(req, env) };
```

- A route's `guard` is only a name. `createApp` throws at start-up if a route uses a name that is not in `guards`, so a route can never skip its guard by accident.
- A guard runs before the handler. It throws an `HttpError` to refuse (`unauthorized` 401, `forbidden` 403, `not_found` 404), or sets fields on `ctx` for the handler.
- Any guard that needs a signed-in user calls `await userGuard(ctx)` first. SplitTrip's `member` and `creator` guards do exactly that, then check the trip.
- `readJson(req, maxChars = 100_000)` reads the body in pieces and refuses with `400 body_too_large` once it passes `maxChars` characters; the `Content-Length` header is not trusted. A route that needs a bigger or smaller limit passes it as the second argument.
- Handlers throw `HttpError` (or `bad`, `notFound`, `forbidden`, `conflict`) for expected failures. An error can carry extra fields that go into the JSON body: `conflict('stale_version', { currentVersion: 7 })` replies `409 { "error": "stale_version", "currentVersion": 7 }`; `new HttpError(status, code, message, extra)` is the long form. `error` is always the code (extra cannot override it), the message is never sent, and an error without extra fields replies exactly `{ "error": code }` as before. Anything else becomes a plain 500 with no detail.

## What the core does on every request

1. **Origin check.** A request with an `Origin` header that is not on `ALLOWED_ORIGINS` gets `403 origin_not_allowed` before any other work (no token check, no database). `*` is never accepted. A request with no `Origin` header is not a browser page (for example curl) and still needs a token.
2. CORS preflight (`OPTIONS`) for allowed origins; the allowed origin is echoed exactly.
3. Routing, then the route's guard, then its handler. A path that cannot be decoded (for example `/trips/%`) is a plain 404.
4. Every reply carries `cache-control: no-store` and `vary: Origin`.

## Sign-in rules (`login`)

- ID tokens are verified in the Worker with WebCrypto. **One audience per provider**: `GOOGLE_CLIENT_ID`, `MS_CLIENT_ID` (empty = that provider is off, 503).
- Checks: signature, issuer, audience, `exp` (60 s allowed), `nbf` (30 s allowed), `iat` (300 s allowed; `nbf` and `iat` rules are Packr's), and the nonce.
- **Open signups** (`ALLOW_SIGNUPS = "true"`) never create a user from an email the provider did not report as verified: `403 email_not_verified`, no user and no session. Microsoft never reports one, so with open signups it can only sign in users that already exist. Private mode is unchanged (`403 not_invited`).
- **Nonce**: the request body is `{ idToken, nonce? }`. For Microsoft the token's nonce must be present and equal `body.nonce`. For Google, a nonce is checked only if one is sent, and then it must match.
- Provider keys are cached for an hour. A token with an unknown key id may force one re-fetch, **at most once every 5 minutes** per provider; a failed fetch counts too.
- Google must report the email as verified. Microsoft accepts personal accounts only (the `consumers` tenant) and is never treated as verified.
- First sign-in links to the existing user with that email, then the provider's stable `sub` is stored in `identities` and used from then on. A different `sub` for an already-linked user and provider is refused (`account_already_linked`).
- **Private mode** (default): an email not in `users` gets `403 not_invited`. Only `ALLOW_SIGNUPS = "true"` (exactly) creates users.
- Sessions: a random bearer token, stored only as a SHA-256 hash, lifetime `SESSION_DAYS` (default 30). Expired sessions of a user are deleted when that user signs in again.

## Configuration

| Setting | Where | Meaning |
|---|---|---|
| `DB` | binding | the app's own D1 database |
| `GOOGLE_CLIENT_ID`, `MS_CLIENT_ID` | wrangler vars | the single accepted audience for each provider |
| `ALLOWED_ORIGINS` | wrangler var | comma-separated exact origins |
| `ALLOW_SIGNUPS` | wrangler var | `"true"` only if the app is public |
| `SESSION_DAYS` | wrangler var | session lifetime |
| `naming` | `createApp` option | the `users` display-name column and the JSON field. SplitTrip: `name` / `name`. Packr: `display_name` / `displayName`. The column is placed in SQL, so it must be a plain identifier (checked at start-up) |

## Tables

Copy `schema.sql` into the app's first migration (users, identities, sessions); the app adds its own tables. The display-name column may have another name (see `naming`). Timestamps are ISO-8601 text written by `nowIso()`.

## Tests and the test seam

`Deps` is the only test seam: `fetchJwks` (replaces the network call for provider keys), `now` (clock), `keyCache` (a fresh `KeyCache` per test). Production passes nothing. There is no test-only environment variable or setting anywhere in `core/` (a test checks the source for that). Run the core tests alone with `npx vitest run core`.
