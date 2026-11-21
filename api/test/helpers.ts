// All data in tests is made up (fake names, example.com addresses, random UUIDs). Nothing from the real exports is used.
import { Miniflare } from 'miniflare';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { handle } from '../src/index';
import { KeyCache } from '../core';
import { NONCE } from '../core/test/helpers';
import type { Env } from '../src/types';

const GOOGLE_CLIENT = 'test-google-client.apps.example.com';
const MS_CLIENT = 'test-ms-client-id';
export const MS_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad';

export interface Stats { queries: number; rowsRead: number; rowsWritten: number; }
export const seenSql = new Map<string, unknown[]>();
export const bindStats = { max: 0 };

/** Wraps a D1 binding and sums statements, rows_read and rows_written for whatever runs through it. */
export function countingDb(db: D1Database) {
  const stats: Stats = { queries: 0, rowsRead: 0, rowsWritten: 0 };
  const add = (m: any) => { stats.queries++; stats.rowsRead += m?.rows_read ?? 0; stats.rowsWritten += m?.rows_written ?? 0; };
  const wrapStmt = (s: D1PreparedStatement, sql = '', binds: unknown[] = []): any => ({
    __s: s,
    bind: (...a: unknown[]) => { bindStats.max = Math.max(bindStats.max, a.length); if (!seenSql.has(sql)) seenSql.set(sql, a); return wrapStmt(s.bind(...a), sql, a); },
    run: async () => { const r = await s.run(); add(r.meta); return r; },
    all: async () => { const r = await s.all(); add(r.meta); return r; },
    first: async (c?: string) => { const r = await s.all(); add(r.meta); return (r.results[0] ?? null) && (c ? (r.results[0] as any)[c] : r.results[0]); },
  });
  const proxy: any = {
    prepare: (sql: string) => wrapStmt(db.prepare(sql), sql),
    batch: async (list: any[]) => { const r = await db.batch(list.map(x => x.__s)); r.forEach(x => add(x.meta)); return r; },
  };
  return { db: proxy as D1Database, stats, reset: () => { stats.queries = stats.rowsRead = stats.rowsWritten = 0; } };
}

export async function makeEnv(overrides: Partial<Env> = {}) {
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("") } }', d1Databases: { DB: 'test-db' } });
  const raw = await mf.getD1Database('DB');
  const sql = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../schema/0001_init.sql'), 'utf8')
    .split('\n').map(l => l.replace(/--.*$/, '')).join('\n');
  for (const stmt of sql.split(';').map(s => s.trim()).filter(Boolean)) await raw.prepare(stmt).run();
  const counter = countingDb(raw);
  const env: Env = {
    DB: counter.db, ALLOW_SIGNUPS: 'false', GOOGLE_CLIENT_ID: GOOGLE_CLIENT, MS_CLIENT_ID: MS_CLIENT,
    ALLOWED_ORIGINS: 'https://app.example.com', SESSION_DAYS: '30', ...overrides,
  };
  return { env, raw, counter, close: () => mf.dispose() };
}

// ---- a fake identity provider: our own RSA key, served through the injected JWKS fetcher ----
const b64u = (b: ArrayBuffer | string) => {
  const bytes = typeof b === 'string' ? new TextEncoder().encode(b) : new Uint8Array(b);
  let s = ''; for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

export async function makeIdp() {
  const pair = (await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const jwk: any = await crypto.subtle.exportKey('jwk', pair.publicKey);
  jwk.kid = 'k1'; jwk.alg = 'RS256'; jwk.use = 'sig';
  const sign = async (claims: Record<string, unknown>, kid = 'k1', key = pair.privateKey) => {
    const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }));
    const body = b64u(JSON.stringify(claims));
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(head + '.' + body));
    return `${head}.${body}.${b64u(sig)}`;
  };
  const iat = Math.floor(Date.now() / 1000) - 5;
  const exp = iat + 3600;
  return {
    deps: { fetchJwks: async () => ({ keys: [jwk] }), keyCache: new KeyCache() } as any,
    sign,
    google: (email: string, extra: Record<string, unknown> = {}) => sign({
      iss: 'https://accounts.google.com', aud: GOOGLE_CLIENT, sub: 'g-' + email, email, email_verified: true, name: email.split('@')[0], iat, nbf: iat, exp, ...extra }),
    microsoft: (email: string, extra: Record<string, unknown> = {}) => sign({
      iss: `https://login.microsoftonline.com/${MS_TENANT}/v2.0`, tid: MS_TENANT, aud: MS_CLIENT, sub: 'm-' + email, email, name: 'Ms ' + email.split('@')[0], nonce: NONCE, iat, nbf: iat, exp, ...extra }),
    otherKeySign: async (claims: Record<string, unknown>) => {
      const other = (await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
      return sign(claims, 'k1', other.privateKey);
    },
    exp, iat,
  };
}

export type Api = ReturnType<typeof makeApi>;
export function makeApi(env: Env, deps: any) {
  const call = (method: string, path: string, body?: unknown, token?: string, headers: Record<string, string> = {}) =>
    handle(new Request('https://api.test' + path, {
      method, headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }), env, deps);
  const j = async (method: string, path: string, body?: unknown, token?: string) => {
    const r = await call(method, path, body, token);
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : null, headers: r.headers };
  };
  return { call, j };
}

/** Insert a made-up user directly (stands in for the importer) and return a session token via Google sign-in. */
export async function seedUser(env: Env, id: string, email: string, name: string) {
  await env.DB.prepare('INSERT INTO users (id, email, name, created_at) VALUES (?1,?2,?3,?4)').bind(id, email, name, '2026-01-01T00:00:00.000000Z').run();
}

export async function signIn(api: Api, idp: Awaited<ReturnType<typeof makeIdp>>, email: string): Promise<string> {
  const r = await api.j('POST', '/auth/google', { idToken: await idp.google(email) });
  if (r.status !== 200) throw new Error('sign-in failed ' + JSON.stringify(r.body));
  return r.body.token;
}

export const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** Alice (u1) and Bob (u2) with one trip each, plus a signed-in token for each. All made up. */
export async function scenario() {
  const ctx = await makeEnv();
  const idp = await makeIdp();
  const api = makeApi(ctx.env, idp.deps);
  await seedUser(ctx.env, uid(1), 'alice@example.com', 'Alice');
  await seedUser(ctx.env, uid(2), 'bob@example.com', 'Bob');
  await seedUser(ctx.env, uid(3), 'carol@example.com', 'Carol');
  const alice = await signIn(api, idp, 'alice@example.com');
  const bob = await signIn(api, idp, 'bob@example.com');
  const carol = await signIn(api, idp, 'carol@example.com');
  const mk = async (token: string, name: string, members: any[]) => (await api.j('POST', '/trips', { name, base_currency: 'AUD', expense_currency: 'AUD', members }, token)).body;
  const tripA = await mk(alice, 'Alice trip', [{ name: 'Alice', is_self: true }, { name: 'Dave', email: 'dave@example.com' }]);
  const tripB = await mk(bob, 'Bob trip', [{ name: 'Bob', is_self: true }, { name: 'Erin' }]);
  const memA = (n: string) => tripA.trip_members.find((m: any) => m.name === n).id;
  const memB = (n: string) => tripB.trip_members.find((m: any) => m.name === n).id;
  const expense = (token: string, trip: any, paidBy: string, a: string, b: string, cents = 1001) =>
    api.j('POST', `/trips/${trip.id}/expenses`, { paid_by_member_id: paidBy, amount_cents: cents, currency: 'AUD', date: '2026-03-01', description: 'Lunch', split_type: 'equal',
      splits: [{ member_id: a, amount_cents: Math.ceil(cents / 2) }, { member_id: b, amount_cents: Math.floor(cents / 2) }] }, token);
  return { ...ctx, idp, api, alice, bob, carol, tripA, tripB, memA, memB, expense };
}
