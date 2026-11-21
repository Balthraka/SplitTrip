import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError, bad, conflict, createApp, forbidden, json, publicGuard, readJson, userGuard } from '../index.js';
import { match } from '../app.js';
import { ORIGIN, demoGuards, demoRoutes, makeApp } from './helpers';

type A = Awaited<ReturnType<typeof makeApp>>;
let a: A; let alice: string;
beforeAll(async () => {
  a = await makeApp();
  await a.addUser('00000000-0000-4000-8000-000000000001', 'alice@example.com', 'Alice');
  await a.addUser('00000000-0000-4000-8000-000000000009', 'admin@example.com', 'Admin');
  alice = await a.signIn('alice@example.com');
});
afterAll(async () => { await a.close(); });

describe('origin check', () => {
  it('a browser request from an unlisted origin gets 403 before any work: every method, no database query, no CORS header', async () => {
    const before = a.counter.queries;
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      for (const origin of ['https://evil.example.com', 'null', 'https://app.example.com.evil.example.com', 'http://app.example.com', 'https://app.example.com:8443']) {
        const r = await a.call(method, '/me', method === 'GET' || method === 'OPTIONS' ? undefined : {}, alice, { origin });
        expect(r.status, `${method} ${origin}`).toBe(403);
        expect(r.headers.get('access-control-allow-origin')).toBeNull();
        expect((await r.json()) as any).toEqual({ error: 'origin_not_allowed' });
      }
    }
    expect(a.counter.queries).toBe(before);
  });
  it('the listed origin works and is echoed exactly; with no Origin header (not a browser page) a token is still needed', async () => {
    const ok = await a.call('GET', '/me', undefined, alice, { origin: ORIGIN });
    expect(ok.status).toBe(200); expect(ok.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect((await a.call('GET', '/me', undefined, alice)).status).toBe(200);
    expect((await a.call('GET', '/me')).status).toBe(401);
  });
  it('preflight: allowed origin gets 204 with the allowed methods and headers', async () => {
    const r = await a.call('OPTIONS', '/me', undefined, undefined, { origin: ORIGIN, 'access-control-request-method': 'PATCH' });
    expect(r.status).toBe(204);
    expect(r.headers.get('access-control-allow-methods')).toContain('PATCH');
    expect(r.headers.get('access-control-allow-headers')).toBe('authorization,content-type');
  });
  it('the list is exact origins only: "*" is never accepted, several origins can be listed', async () => {
    const star = await makeApp({ env: { ALLOWED_ORIGINS: '*' } });
    expect((await star.call('GET', '/open', undefined, undefined, { origin: 'https://anything.example.com' })).status).toBe(403);
    await star.close();
    const two = await makeApp({ env: { ALLOWED_ORIGINS: 'https://a.example.com, https://b.example.com' } });
    for (const o of ['https://a.example.com', 'https://b.example.com']) expect((await two.call('GET', '/open', undefined, undefined, { origin: o })).status).toBe(200);
    expect((await two.call('GET', '/open', undefined, undefined, { origin: 'https://c.example.com' })).status).toBe(403);
    await two.close();
    const none = await makeApp({ env: { ALLOWED_ORIGINS: '' } });
    expect((await none.call('GET', '/open', undefined, undefined, { origin: ORIGIN })).status).toBe(403);
    await none.close();
  });
});

describe('routing and guards', () => {
  it('unknown path is 404, wrong method is 405, path parameters are decoded', async () => {
    expect((await a.j('GET', '/nope')).status).toBe(404);
    expect((await a.j('PUT', '/me', {}, alice)).status).toBe(405);
    expect((await a.j('GET', '/things/a%20b', undefined, alice)).body).toEqual({ id: 'a b' });
    expect((await a.j('GET', '/me/', undefined, alice)).status).toBe(200);   // trailing slash ignored
  });
  it('a guard runs before its handler: a failing guard means the handler never runs', async () => {
    let ran = false;
    const probe = createApp({ routes: [{ method: 'GET', path: '/x', guard: 'user', handler: async () => { ran = true; return json({}); } }], guards: { user: userGuard } });
    const r = await probe.handle(new Request('https://api.test/x'), a.env, a.idp.deps);
    expect(r.status).toBe(401); expect(ran).toBe(false);
  });
  it('an app can add its own guard name; it can set fields on the context and refuse with its own error', async () => {
    expect((await a.j('GET', '/admin/secret')).status).toBe(401);                                   // not signed in
    const r = await a.j('GET', '/admin/secret', undefined, alice);
    expect(r.status).toBe(403); expect(r.body.error).toBe('not_admin');                              // signed in, not admin
    const admin = await a.signIn('admin@example.com');
    expect((await a.j('GET', '/admin/secret', undefined, admin)).body).toEqual({ admin: true });
  });
  it('a route that names a guard the app did not define is refused when the app is created', () => {
    expect(() => createApp({ routes: [{ method: 'GET', path: '/x', guard: 'member', handler: async () => json({}) }], guards: { public: publicGuard, user: userGuard } })).toThrow(/member/);
  });
  it('the core only knows the guard names it is given: it has no built-in routes and no built-in guard names', () => {
    const empty = createApp({ routes: [], guards: {} });
    expect(empty.routes).toEqual([]);
  });
  it('public routes need no token and no database', async () => {
    const before = a.counter.queries;
    expect((await a.j('GET', '/open')).status).toBe(200);
    expect(a.counter.queries).toBe(before);
  });
});

describe('bad paths and big bodies', () => {
  it('a path with a broken %-escape is 404, not 500, on every kind of route', async () => {
    for (const p of ['/things/%', '/things/%E0%A4%A', '/things/%zz', '/open%', '/%']) {
      const r = await a.call('GET', p, undefined, alice);
      expect(r.status, p).toBe(404);
    }
    expect(match('/things/:id', '/things/%')).toBeNull();
    expect(match('/things/:id', '/things/a%20b')).toEqual({ id: 'a b' });
  });
  const login = (body: string, headers: Record<string, string> = {}) =>
    a.app.handle(new Request('https://api.test/auth/google', { method: 'POST', body, headers }), a.env, a.idp.deps);
  const pad = (total: number) => { const fixed = '{"idToken":"x","pad":""}'.length; return `{"idToken":"x","pad":"${'a'.repeat(total - fixed)}"}`; };
  it('a body over 100,000 characters is 400 body_too_large even with no Content-Length header', async () => {
    const big = pad(100_001);
    expect(big.length).toBe(100_001);
    const req = new Request('https://api.test/auth/google', { method: 'POST', body: big });
    expect(req.headers.get('content-length')).toBeNull();                       // really no header
    const r = await a.app.handle(req, a.env, a.idp.deps);
    expect(r.status).toBe(400); expect(((await r.json()) as any).error).toBe('body_too_large');
  });
  it('the header cannot be used to sneak a big body in: a small Content-Length with a big body is still refused', async () => {
    const r = await login(pad(150_000), { 'content-length': '10' });
    expect(r.status).toBe(400); expect(((await r.json()) as any).error).toBe('body_too_large');
  });
  it('a body of exactly 100,000 characters is read (it fails later for another reason, not for size)', async () => {
    const r = await login(pad(100_000));
    expect(((await r.json()) as any).error).not.toBe('body_too_large');
  });
  it('a streamed body is cut off as soon as it passes the limit (the rest is never read)', async () => {
    let chunks = 0;
    const stream = new ReadableStream({ pull(c) { chunks++; c.enqueue(new TextEncoder().encode('a'.repeat(10_000))); if (chunks > 1000) c.close(); } });
    const r = await a.app.handle(new Request('https://api.test/auth/google', { method: 'POST', body: stream, duplex: 'half' } as any), a.env, a.idp.deps);
    expect(r.status).toBe(400); expect(chunks).toBeLessThan(50);
  });
  it('multi-byte text counts as characters, not bytes (50,000 two-byte characters are fine)', async () => {
    const r = await login(`{"idToken":"x","pad":"${'é'.repeat(50_000)}"}`);
    expect(((await r.json()) as any).error).not.toBe('body_too_large');
  });
  it('empty and non-object bodies are 400 invalid_json', async () => {
    for (const b of ['', 'null', '[]', '"x"', '{bad']) expect(((await (await login(b)).json()) as any).error, b).toBe('invalid_json');
  });
});

describe('readJson(req, maxChars) and HttpError extra fields', () => {
  const post = (body: string) => new Request('https://api.test/x', { method: 'POST', body });
  it('maxChars is optional: the default is still 100,000, and a smaller limit is applied exactly', async () => {
    const body = (n: number) => `{"a":"${'x'.repeat(n - 8)}"}`;
    expect(Object.keys(await readJson(post(body(100_000))))).toEqual(['a']);
    await expect(readJson(post(body(100_001)))).rejects.toMatchObject({ status: 400, code: 'body_too_large' });
    expect(Object.keys(await readJson(post(body(500)), 500))).toEqual(['a']);                 // exactly at the limit
    await expect(readJson(post(body(501)), 500)).rejects.toMatchObject({ code: 'body_too_large' });
    expect(Object.keys(await readJson(post(body(150_000)), 200_000))).toEqual(['a']);          // a larger limit works too
    await expect(readJson(post('[]'), 10)).rejects.toMatchObject({ code: 'invalid_json' });     // same behaviour otherwise
  });
  it('extra fields appear in the JSON error body; without them the reply is exactly { error }', async () => {
    const app = createApp({ guards: { public: publicGuard }, routes: [
      { method: 'GET', path: '/plain', guard: 'public', handler: async () => { throw conflict('stale_version'); } },
      { method: 'GET', path: '/extra', guard: 'public', handler: async () => { throw conflict('stale_version', { currentVersion: 7 }); } },
      { method: 'GET', path: '/max', guard: 'public', handler: async () => { throw bad('too_many', 'x', { max: 40 }); } },
      { method: 'GET', path: '/forbid', guard: 'public', handler: async () => { throw forbidden('nope', { why: 'x' }); } },
      { method: 'GET', path: '/clash', guard: 'public', handler: async () => { throw new HttpError(400, 'real_code', undefined, { error: 'fake', a: 1 }); } },
    ] });
    const env: any = { DB: null, ALLOWED_ORIGINS: 'https://a.example.com' };
    const get = async (p: string) => { const r = await app.handle(new Request('https://x.test' + p), env); return { status: r.status, body: await r.json() as any }; };
    expect(await get('/plain')).toEqual({ status: 409, body: { error: 'stale_version' } });
    expect(await get('/extra')).toEqual({ status: 409, body: { error: 'stale_version', currentVersion: 7 } });
    expect(await get('/max')).toEqual({ status: 400, body: { error: 'too_many', max: 40 } });   // message stays private
    expect(await get('/forbid')).toEqual({ status: 403, body: { error: 'nope', why: 'x' } });
    expect(await get('/clash')).toEqual({ status: 400, body: { error: 'real_code', a: 1 } });    // `error` cannot be overridden
  });
});

describe('errors', () => {
  it('an unexpected error is a plain 500 and its message is not sent to the caller', async () => {
    const r = await a.call('GET', '/boom', undefined, alice);
    expect(r.status).toBe(500);
    const text = await r.text();
    expect(JSON.parse(text)).toEqual({ error: 'internal' });
    expect(text).not.toContain('hunter2');
  });
  it('every reply is marked no-store and Vary: Origin', async () => {
    for (const r of [await a.call('GET', '/open'), await a.call('GET', '/nope'), await a.call('GET', '/boom', undefined, alice), await a.call('GET', '/me', undefined, undefined, { origin: 'https://evil.example.com' })]) {
      expect(r.headers.get('cache-control')).toBe('no-store');
      expect(r.headers.get('vary')).toBe('Origin');
    }
  });
});

describe('no test-only settings in the live code', () => {
  it('core/ source files mention no TEST_ variable and read nothing from process.env; tests inject fakes through `deps` only', () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), '..');
    const files = readdirSync(dir).filter(f => f.endsWith('.js'));
    expect(files.length).toBe(6);   // app, auth, index, jwt, types, util
    for (const f of files) {
      const src = readFileSync(join(dir, f), 'utf8');
      expect(src, f).not.toMatch(/TEST_[A-Z]/);
      expect(src, f).not.toMatch(/process\.env/);
    }
    const toml = readFileSync(join(dir, '../wrangler.toml'), 'utf8');
    expect(toml).not.toMatch(/TEST_/);
  });
});
