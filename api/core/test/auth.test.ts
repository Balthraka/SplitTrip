import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../index.js';
import { NONCE, demoGuards, demoRoutes, makeApp } from './helpers';

type A = Awaited<ReturnType<typeof makeApp>>;
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('sign-in and sessions', () => {
  let a: A;
  beforeAll(async () => { a = await makeApp(); await a.addUser(uid(1), 'alice@example.com', 'Alice'); await a.addUser(uid(2), 'ben@example.com', 'Ben'); });
  afterAll(async () => { await a.close(); });
  const post = (path: string, tok: string) => a.j('POST', path, path.includes('microsoft') ? { idToken: tok, nonce: NONCE } : { idToken: tok });

  it('private mode: an email that is not in users is refused with 403 not_invited and nothing is created', async () => {
    const r = await post('/auth/google', await a.idp.google('stranger@example.com'));
    expect(r.status).toBe(403); expect(r.body.error).toBe('not_invited');
    expect(await a.raw.prepare("SELECT COUNT(*) n FROM users WHERE email='stranger@example.com'").first('n')).toBe(0);
  });
  it('Google links to the existing user by verified email, and the session works', async () => {
    const r = await post('/auth/google', await a.idp.google('alice@example.com'));
    expect(r.status).toBe(200);
    expect(r.body.user).toEqual({ id: uid(1), email: 'alice@example.com', name: 'Alice' });
    const me = await a.j('GET', '/me', undefined, r.body.token);
    expect(me.body).toEqual({ id: uid(1), email: 'alice@example.com', name: 'Alice', verified: true });
  });
  it('Google with an unverified email is refused (403) until the identity is linked', async () => {
    const r = await post('/auth/google', await a.idp.google('ben@example.com', { email_verified: false, sub: 'fresh-sub' }));
    expect(r.status).toBe(403); expect(r.body.error).toBe('email_not_verified');
  });
  it('Microsoft links only to an email already in users, and its session is never "verified"', async () => {
    const r = await post('/auth/microsoft', await a.idp.microsoft('ben@example.com'));
    expect(r.status).toBe(200);
    expect((await a.j('GET', '/me', undefined, r.body.token)).body.verified).toBe(false);
    expect((await post('/auth/microsoft', await a.idp.microsoft('nobody@example.com'))).body.error).toBe('not_invited');
  });
  it('nonce at sign-in: Microsoft needs a matching one in the body; Google checks one only if it is sent; a non-string one is 400', async () => {
    const ms = await a.idp.microsoft('ben@example.com');
    expect((await a.j('POST', '/auth/microsoft', { idToken: ms })).status).toBe(401);                       // none sent
    expect((await a.j('POST', '/auth/microsoft', { idToken: ms, nonce: 'wrong' })).status).toBe(401);
    expect((await a.j('POST', '/auth/microsoft', { idToken: ms, nonce: NONCE })).status).toBe(200);
    const g = await a.idp.google('alice@example.com', { nonce: 'g-nonce' });
    expect((await a.j('POST', '/auth/google', { idToken: g, nonce: 'g-nonce' })).status).toBe(200);
    expect((await a.j('POST', '/auth/google', { idToken: g, nonce: 'other' })).status).toBe(401);
    expect((await a.j('POST', '/auth/google', { idToken: g })).status).toBe(200);                           // none sent: fine
    expect((await a.j('POST', '/auth/google', { idToken: g, nonce: 5 })).body.error).toBe('invalid_nonce');
    expect((await a.j('POST', '/auth/google', { idToken: g, nonce: 'x'.repeat(201) })).status).toBe(400);
  });
  it('after linking, the provider sub is what counts, not the email', async () => {
    await a.raw.prepare("UPDATE users SET email='alice.new@example.com' WHERE id=?1").bind(uid(1)).run();
    const r = await post('/auth/google', await a.idp.google('alice@example.com'));   // same sub as before, old email in the token
    expect(r.status).toBe(200); expect(r.body.user.id).toBe(uid(1));
  });
  it('a different Google account with the same email as an already-linked user is refused (account_already_linked)', async () => {
    const r = await post('/auth/google', await a.idp.google('alice.new@example.com', { sub: 'a-different-google-account' }));
    expect(r.status).toBe(403); expect(r.body.error).toBe('account_already_linked');
  });
  it('the same identity can sign in twice, giving two independent sessions', async () => {
    const t1 = await a.signIn('alice@example.com'), t2 = await a.signIn('alice@example.com');
    expect(t1).not.toBe(t2);
    await a.j('POST', '/me/logout', undefined, t1);
    expect((await a.j('GET', '/me', undefined, t1)).status).toBe(401);
    expect((await a.j('GET', '/me', undefined, t2)).status).toBe(200);
  });
  it('tokens are stored only as SHA-256 hashes', async () => {
    const t = await a.signIn('alice@example.com');
    const rows = (await a.raw.prepare('SELECT token_hash FROM sessions').all()).results as any[];
    expect(rows.some(r => r.token_hash === t)).toBe(false);
    expect(rows.every(r => /^[0-9a-f]{64}$/.test(r.token_hash))).toBe(true);
  });
  it('sessions expire after SESSION_DAYS, and expired ones are cleaned up at the next sign-in', async () => {
    const t = await a.signIn('alice@example.com');
    const real = Date.now();
    a.idp.deps.now = () => real + 31 * 86_400_000;
    expect((await a.j('GET', '/me', undefined, t)).status).toBe(401);
    // signing in again (at the moved clock) removes that user's expired sessions
    const fresh = await post('/auth/google', await a.idp.google('alice@example.com'));
    expect(fresh.status).toBe(200);
    const left = (await a.raw.prepare('SELECT COUNT(*) n FROM sessions WHERE user_id=?1').bind(uid(1)).first('n')) as number;
    expect(left).toBe(1);
    a.idp.deps.now = undefined;
  });
  it('malformed, short, long and unknown bearer tokens are all 401', async () => {
    for (const t of ['x', 'A'.repeat(19), 'A'.repeat(101), 'A'.repeat(43), 'has space ' + 'A'.repeat(30), '']) {
      expect((await a.j('GET', '/me', undefined, t || undefined)).status, t).toBe(401);
    }
  });
  it('bad sign-in bodies are 400, and a provider with no client id is 503', async () => {
    expect((await a.j('POST', '/auth/google', {})).status).toBe(400);
    expect((await a.j('POST', '/auth/google', { idToken: 'x'.repeat(5000) })).status).toBe(400);
    expect((await a.j('POST', '/auth/google', { idToken: 'junk' })).status).toBe(401);
    const off = await makeApp({ env: { MS_CLIENT_ID: '' } });
    expect((await off.j('POST', '/auth/microsoft', { idToken: 'x' })).status).toBe(503);
    await off.close();
  });
});

describe('public mode', () => {
  it('ALLOW_SIGNUPS "true" creates the user, with the name from the token; anything else stays private', async () => {
    const open = await makeApp({ env: { ALLOW_SIGNUPS: 'true' } });
    const r = await open.j('POST', '/auth/google', { idToken: await open.idp.google('new@example.com', { name: 'Newbie' }) });
    expect(r.status).toBe(200); expect(r.body.user.name).toBe('Newbie');
    expect(await open.raw.prepare("SELECT COUNT(*) n FROM users WHERE email='new@example.com'").first('n')).toBe(1);
    await open.close();
    for (const v of ['TRUE', '1', 'yes', ' true']) {
      const priv = await makeApp({ env: { ALLOW_SIGNUPS: v } });
      expect((await priv.j('POST', '/auth/google', { idToken: await priv.idp.google('new@example.com') })).body.error, v).toBe('not_invited');
      await priv.close();
    }
  });
});

describe('public mode never creates a user from an unverified email', () => {
  it('Google: email_verified false is 403 email_not_verified and no user is created', async () => {
    const open = await makeApp({ env: { ALLOW_SIGNUPS: 'true' } });
    const r = await open.j('POST', '/auth/google', { idToken: await open.idp.google('new@example.com', { email_verified: false }) });
    expect(r.status).toBe(403); expect(r.body.error).toBe('email_not_verified');
    expect(await open.raw.prepare('SELECT COUNT(*) n FROM users').first('n')).toBe(0);
    await open.close();
  });
  it('Microsoft (never verified): an unknown email is 403 email_not_verified and no user is created; a known email still links', async () => {
    const open = await makeApp({ env: { ALLOW_SIGNUPS: 'true' } });
    const r = await open.j('POST', '/auth/microsoft', { idToken: await open.idp.microsoft('new@example.com'), nonce: NONCE });
    expect(r.status).toBe(403); expect(r.body.error).toBe('email_not_verified');
    expect(await open.raw.prepare('SELECT COUNT(*) n FROM users').first('n')).toBe(0);
    expect(await open.raw.prepare('SELECT COUNT(*) n FROM sessions').first('n')).toBe(0);
    await open.addUser(uid(30), 'known@example.com', 'Known');
    const k = await open.j('POST', '/auth/microsoft', { idToken: await open.idp.microsoft('known@example.com'), nonce: NONCE });
    expect(k.status).toBe(200); expect(k.body.user.id).toBe(uid(30));
    await open.close();
  });
  it('private mode is unchanged: an unknown Microsoft email is still 403 not_invited', async () => {
    const priv = await makeApp();
    const r = await priv.j('POST', '/auth/microsoft', { idToken: await priv.idp.microsoft('new@example.com'), nonce: NONCE });
    expect(r.body.error).toBe('not_invited');
    await priv.close();
  });
});

describe('the display name field is configurable (Packr: column display_name, JSON field displayName)', () => {
  it('reads and writes the configured column and answers with the configured field', async () => {
    const p = await makeApp({ naming: { column: 'display_name', field: 'displayName' } });
    await p.addUser(uid(7), 'pat@example.com', 'Pat');
    const r = await p.j('POST', '/auth/google', { idToken: await p.idp.google('pat@example.com') });
    expect(r.status).toBe(200);
    expect(r.body.user).toEqual({ id: uid(7), email: 'pat@example.com', displayName: 'Pat' });
    expect((await p.j('GET', '/me', undefined, r.body.token)).body.name).toBe('Pat');     // session.name carries the value either way
    await p.close();
    // public-mode sign-up writes into the configured column too
    const q = await makeApp({ naming: { column: 'display_name', field: 'displayName' }, env: { ALLOW_SIGNUPS: 'true' } });
    const n = await q.j('POST', '/auth/google', { idToken: await q.idp.google('fresh@example.com', { name: 'Fresh' }) });
    expect(n.body.user.displayName).toBe('Fresh');
    expect(await q.raw.prepare("SELECT display_name d FROM users WHERE email='fresh@example.com'").first('d')).toBe('Fresh');
    await q.close();
  });
  it('the column name goes into SQL, so anything that is not a plain identifier is refused at start-up', () => {
    for (const bad of ["name; DROP TABLE users", 'na me', "x'--", '1abc', '']) {
      expect(() => createApp({ routes: demoRoutes, guards: demoGuards, naming: { column: bad } }), bad).toThrow();
    }
    expect(() => createApp({ routes: demoRoutes, guards: demoGuards, naming: { field: 'bad field' } })).toThrow();
  });
});
