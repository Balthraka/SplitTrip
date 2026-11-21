// Core-only test helpers. Nothing here knows about SplitTrip: a tiny demo app is built from the core, on the core's own tables.
import { Miniflare } from 'miniflare';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  createApp, forbidden, json, KeyCache, login, logout, publicGuard, userGuard,
  type CoreCtx, type CoreEnv, type GuardFn, type Route, type UserNaming,
} from '../index.js';

export const GOOGLE_CLIENT = 'test-google-client.apps.example.com';
export const MS_CLIENT = 'test-ms-client-id';
export const MS_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad';
export const ORIGIN = 'https://app.example.com';
export const NONCE = 'test-nonce-123';   // the nonce the fake Microsoft tokens carry

const here = dirname(fileURLToPath(import.meta.url));

/** A D1 database with just the core's tables, optionally with the display-name column renamed. Counts every statement. */
export async function makeDb(nameColumn = 'name') {
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("") } }', d1Databases: { DB: 'core-test-db' } });
  const raw = await mf.getD1Database('DB');
  const sql = readFileSync(join(here, '../schema.sql'), 'utf8').split('\n').map(l => l.replace(/--.*$/, '')).join('\n')
    .replace(/\bname\s+TEXT NOT NULL DEFAULT ''/, `${nameColumn} TEXT NOT NULL DEFAULT ''`);
  for (const stmt of sql.split(';').map(s => s.trim()).filter(Boolean)) await raw.prepare(stmt).run();
  const counter = { queries: 0 };
  const wrap = (s: D1PreparedStatement): any => ({ __s: s, bind: (...a: unknown[]) => wrap(s.bind(...a)),
    run: () => { counter.queries++; return s.run(); }, all: () => { counter.queries++; return s.all(); },
    first: (c?: string) => { counter.queries++; return c ? s.first(c) : s.first(); } });
  const db: any = { prepare: (q: string) => wrap(raw.prepare(q)), batch: (l: any[]) => { counter.queries += l.length; return raw.batch(l.map(x => x.__s)); } };
  return { db: db as D1Database, raw, counter, close: () => mf.dispose() };
}

// ---- a fake identity provider: our own RSA key, served through the injected key fetcher ----
const b64u = (b: ArrayBuffer | string) => {
  const bytes = typeof b === 'string' ? new TextEncoder().encode(b) : new Uint8Array(b);
  let s = ''; for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const rsa = async () => (await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;

export async function makeIdp() {
  const pair = await rsa();
  const jwk: any = await crypto.subtle.exportKey('jwk', pair.publicKey);
  jwk.kid = 'k1'; jwk.alg = 'RS256'; jwk.use = 'sig';
  const sign = async (claims: Record<string, unknown>, kid = 'k1', key = pair.privateKey) => {
    const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }));
    const body = b64u(JSON.stringify(claims));
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(head + '.' + body));
    return `${head}.${body}.${b64u(sig)}`;
  };
  const stats = { fetches: 0 };
  const deps: any = { fetchJwks: async () => { stats.fetches++; return { keys: [jwk] }; }, keyCache: new KeyCache() };
  const iat = () => Math.floor((deps.now?.() ?? Date.now()) / 1000) - 5;
  return {
    deps, stats, sign, jwk,
    google: (email: string, extra: Record<string, unknown> = {}) => sign({
      iss: 'https://accounts.google.com', aud: GOOGLE_CLIENT, sub: 'g-' + email, email, email_verified: true, name: email.split('@')[0],
      iat: iat(), nbf: iat(), exp: iat() + 3600, ...extra }),
    microsoft: (email: string, extra: Record<string, unknown> = {}) => sign({
      iss: `https://login.microsoftonline.com/${MS_TENANT}/v2.0`, tid: MS_TENANT, aud: MS_CLIENT, sub: 'm-' + email, email,
      name: 'Ms ' + email.split('@')[0], nonce: NONCE, iat: iat(), nbf: iat(), exp: iat() + 3600, ...extra }),
    otherKeySign: async (claims: Record<string, unknown>) => sign(claims, 'k1', (await rsa()).privateKey),
  };
}

/** The demo app: the core's machinery plus a few made-up routes and one custom guard, to show how an app plugs in. */
export type DemoCtx = CoreCtx & { isAdmin?: boolean };
export const demoRoutes: Route<DemoCtx>[] = [
  { method: 'POST', path: '/auth/google',    guard: 'public', handler: c => login('google', c) },
  { method: 'POST', path: '/auth/microsoft', guard: 'public', handler: c => login('microsoft', c) },
  { method: 'GET',  path: '/open',           guard: 'public', handler: async () => json({ ok: true }) },
  { method: 'GET',  path: '/me',             guard: 'user',   handler: async c => json({ id: c.session.userId, email: c.session.email, name: c.session.name, verified: c.session.verifiedEmail }) },
  { method: 'POST', path: '/me/logout',      guard: 'user',   handler: logout },
  { method: 'GET',  path: '/things/:id',     guard: 'user',   handler: async c => json({ id: c.params.id }) },
  { method: 'GET',  path: '/admin/secret',   guard: 'admin',  handler: async c => json({ admin: c.isAdmin === true }) },
  { method: 'GET',  path: '/boom',           guard: 'user',   handler: async () => { throw new Error('secret detail: password is hunter2'); } },
];
export const demoGuards: Record<string, GuardFn<DemoCtx>> = {
  public: publicGuard,
  user: userGuard,
  admin: async c => { await userGuard(c); if (c.session.email !== 'admin@example.com') throw forbidden('not_admin'); c.isAdmin = true; },
};

export async function makeApp(opts: { naming?: Partial<UserNaming>; nameColumn?: string; env?: Partial<CoreEnv> } = {}) {
  const d = await makeDb(opts.nameColumn ?? opts.naming?.column ?? 'name');
  const idp = await makeIdp();
  const app = createApp<DemoCtx>({ routes: demoRoutes, guards: demoGuards, naming: opts.naming });
  const env: CoreEnv = { DB: d.db, ALLOW_SIGNUPS: 'false', GOOGLE_CLIENT_ID: GOOGLE_CLIENT, MS_CLIENT_ID: MS_CLIENT, ALLOWED_ORIGINS: ORIGIN, SESSION_DAYS: '30', ...opts.env };
  const col = opts.nameColumn ?? opts.naming?.column ?? 'name';
  const call = (method: string, path: string, body?: unknown, token?: string, headers: Record<string, string> = {}) =>
    app.handle(new Request('https://api.test' + path, {
      method, headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined }), env, idp.deps);
  const j = async (method: string, path: string, body?: unknown, token?: string) => {
    const r = await call(method, path, body, token); const t = await r.text();
    return { status: r.status, body: t ? JSON.parse(t) : null, headers: r.headers };
  };
  const addUser = (id: string, email: string, name: string) =>
    d.raw.prepare(`INSERT INTO users (id, email, ${col}, created_at) VALUES (?1,?2,?3,?4)`).bind(id, email, name, '2026-01-01T00:00:00.000000Z').run();
  const signIn = async (email: string) => {
    const r = await j('POST', '/auth/google', { idToken: await idp.google(email) });
    if (r.status !== 200) throw new Error('sign-in failed ' + JSON.stringify(r.body));
    return r.body.token as string;
  };
  return { ...d, app, env, idp, call, j, addUser, signIn };
}
