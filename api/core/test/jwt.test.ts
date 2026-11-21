import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KeyCache, verifyIdToken } from '../index.js';
import { GOOGLE_CLIENT, MS_CLIENT, MS_TENANT, NONCE, makeIdp } from './helpers';

const check = (idp: Awaited<ReturnType<typeof makeIdp>>, tok: string, provider: 'google' | 'microsoft' = 'google', deps = idp.deps, nonce: string | undefined = provider === 'microsoft' ? NONCE : undefined) =>
  verifyIdToken(tok, provider, provider === 'google' ? GOOGLE_CLIENT : MS_CLIENT, deps, deps.keyCache, nonce).then(i => i, (e: Error) => e.message);

describe('ID token checks', () => {
  let idp: Awaited<ReturnType<typeof makeIdp>>;
  beforeAll(async () => { idp = await makeIdp(); });

  it('accepts a good Google token and reports the verified email', async () => {
    const r: any = await check(idp, await idp.google('Alice@Example.com'));
    expect(r.email).toBe('alice@example.com');          // lower-cased
    expect(r.emailVerified).toBe(true);
    expect(r.subject).toBe('g-Alice@Example.com');
  });
  it('refuses a bad signature, wrong audience, wrong issuer, expired, missing subject, and junk', async () => {
    const base = { iss: 'https://accounts.google.com', aud: GOOGLE_CLIENT, sub: 'x', email: 'a@example.com', email_verified: true };
    const now = Math.floor(Date.now() / 1000);
    expect(await check(idp, await idp.otherKeySign({ ...base, exp: now + 600 }))).toBe('bad_signature');
    expect(await check(idp, await idp.google('a@example.com', { aud: 'someone-elses-client' }))).toBe('bad_audience');
    expect(await check(idp, await idp.google('a@example.com', { aud: [GOOGLE_CLIENT, 'another'] }))).toBe('bad_audience');   // one audience only
    expect(await check(idp, await idp.google('a@example.com', { iss: 'https://evil.example.com' }))).toBe('bad_issuer');
    expect(await check(idp, await idp.google('a@example.com', { exp: now - 7200 }))).toBe('expired');
    expect(await check(idp, await idp.google('a@example.com', { sub: '' }))).toBe('no_subject');
    expect(await check(idp, 'not-a-jwt')).toBe('malformed');
    expect(await check(idp, 'a.b.c')).toBeTypeOf('string');
  });
  it('refuses alg none / HS256 style tokens', async () => {
    const head = btoa(JSON.stringify({ alg: 'none', kid: 'k1' })).replace(/=+$/, '');
    const body = btoa(JSON.stringify({ iss: 'https://accounts.google.com', aud: GOOGLE_CLIENT, sub: 'x', exp: 9999999999 })).replace(/=+$/, '');
    expect(await check(idp, `${head}.${body}.`)).toBe('bad_alg');
  });

  describe('nbf and iat (same rules and tolerances as Packr)', () => {
    const now = Math.floor(Date.now() / 1000);
    it('a token issued in the future or not yet valid is refused', async () => {
      expect(await check(idp, await idp.google('a@example.com', { iat: now + 3600, exp: now + 7200 }))).toBe('issued_in_future');
      expect(await check(idp, await idp.google('a@example.com', { nbf: now + 3600 }))).toBe('not_yet_valid');
      expect(await check(idp, await idp.microsoft('a@example.com', { nbf: now + 3600 }), 'microsoft')).toBe('not_yet_valid');
    });
    it('small clock differences are fine: nbf 30 s, iat 300 s', async () => {
      expect(await check(idp, await idp.google('a@example.com', { nbf: now + 120 }))).toBe('not_yet_valid');
      expect(await check(idp, await idp.google('a@example.com', { nbf: now + 20 }))).toBeTypeOf('object');
      expect(await check(idp, await idp.google('a@example.com', { iat: now + 400 }))).toBe('issued_in_future');
      expect(await check(idp, await idp.google('a@example.com', { iat: now + 200 }))).toBeTypeOf('object');
    });
  });

  describe('Microsoft', () => {
    it('accepts the personal-accounts tenant only, and never reports the email as verified', async () => {
      const ok: any = await check(idp, await idp.microsoft('ben@example.com'), 'microsoft');
      expect(ok.emailVerified).toBe(false);
      expect(await check(idp, await idp.microsoft('ben@example.com', { tid: 'some-work-tenant', iss: 'https://login.microsoftonline.com/some-work-tenant/v2.0' }), 'microsoft')).toBe('bad_issuer');
      expect(await check(idp, await idp.microsoft('ben@example.com', { aud: 'other' }), 'microsoft')).toBe('bad_audience');
    });
  });

  describe('nonce', () => {
    it('Microsoft: the token must carry a nonce and it must equal the one sent; a missing one on either side is refused', async () => {
      expect(await check(idp, await idp.microsoft('ben@example.com'), 'microsoft')).toBeTypeOf('object');
      expect(await check(idp, await idp.microsoft('ben@example.com'), 'microsoft', idp.deps, 'a-different-nonce')).toBe('bad_nonce');
      expect(await check(idp, await idp.microsoft('ben@example.com'), 'microsoft', idp.deps, '')).toBe('bad_nonce');
      expect(await check(idp, await idp.microsoft('ben@example.com', { nonce: undefined }), 'microsoft')).toBe('bad_nonce');       // token has none
      expect(await check(idp, await idp.microsoft('ben@example.com', { nonce: 42 }), 'microsoft')).toBe('bad_nonce');
      await expect(verifyIdToken(await idp.microsoft('ben@example.com'), 'microsoft', MS_CLIENT, idp.deps, idp.deps.keyCache)).rejects.toThrow('bad_nonce'); // none sent
    });
    it('Google: if a nonce is sent it must match the token; if none is sent nothing is checked', async () => {
      expect(await check(idp, await idp.google('a@example.com', { nonce: 'n1' }), 'google', idp.deps, 'n1')).toBeTypeOf('object');
      expect(await check(idp, await idp.google('a@example.com', { nonce: 'n1' }), 'google', idp.deps, 'n2')).toBe('bad_nonce');
      expect(await check(idp, await idp.google('a@example.com'), 'google', idp.deps, 'n1')).toBe('bad_nonce');                      // token has none
      expect(await check(idp, await idp.google('a@example.com', { nonce: 'n1' }))).toBeTypeOf('object');                          // none sent: not checked
    });
  });

  it('a provider with no client id configured is refused', async () => {
    await expect(verifyIdToken(await idp.google('a@example.com'), 'google', '', idp.deps, idp.deps.keyCache)).rejects.toThrow('provider_not_configured');
  });
});

describe('provider public keys: forced re-fetch at most once every 5 minutes', () => {
  const unknownKid = (idp: Awaited<ReturnType<typeof makeIdp>>, clock: number) =>
    idp.sign({ iss: 'https://accounts.google.com', aud: GOOGLE_CLIENT, sub: 'x', email: 'a@example.com', email_verified: true, iat: Math.floor(clock / 1000), exp: Math.floor(clock / 1000) + 600 }, 'rotated-key');

  it('a flood of tokens with an unknown key id causes one extra fetch, then none for 5 minutes, then one more', async () => {
    const idp = await makeIdp();
    let clock = Date.now();
    idp.deps.now = () => clock;
    const bad = async () => check(idp, await unknownKid(idp, clock));
    expect(await bad()).toBe('unknown_key'); expect(idp.stats.fetches).toBe(1);    // cold cache: one fetch, no pointless second one
    expect(await bad()).toBe('unknown_key'); expect(idp.stats.fetches).toBe(2);    // first forced refresh
    for (let i = 0; i < 50; i++) expect(await bad()).toBe('unknown_key');
    expect(idp.stats.fetches).toBe(2);                                             // 50 more bad tokens: no more fetches
    clock += 4 * 60_000;
    expect(await bad()).toBe('unknown_key'); expect(idp.stats.fetches).toBe(2);    // 4 minutes: still throttled
    clock += 61_000;
    expect(await bad()).toBe('unknown_key'); expect(idp.stats.fetches).toBe(3);    // past 5 minutes: one more
    // a good token is unaffected throughout
    const good = await idp.google('a@example.com');
    expect(await check(idp, good)).toBeTypeOf('object'); expect(idp.stats.fetches).toBe(3);
  });

  it('a failing key fetch is throttled too (the attempt counts)', async () => {
    const idp = await makeIdp();
    let n = 0; let fail = false;
    const deps: any = { keyCache: new KeyCache(), now: () => Date.now(),
      fetchJwks: async (u: string) => { n++; if (fail) throw new Error('down'); return idp.deps.fetchJwks(u); } };
    expect(await check(idp, await idp.google('a@example.com'), 'google', deps)).toBeTypeOf('object');   // cache filled (1 fetch)
    fail = true;
    const t = await unknownKid(idp, Date.now());
    expect(await check(idp, t, 'google', deps)).toBe('down');          // forced refresh attempted and failed
    expect(await check(idp, t, 'google', deps)).toBe('unknown_key');   // throttled: no second attempt
    expect(n).toBe(2);
  });

  it('a real key rotation is still picked up on the first unknown key id', async () => {
    const idp = await makeIdp();
    let rotated = false; let fetches = 0;
    const deps: any = { keyCache: new KeyCache(),
      fetchJwks: async () => { fetches++; return { keys: [rotated ? { ...idp.jwk, kid: 'k2' } : idp.jwk] }; } };
    const withKid = (kid: string) => idp.sign({ iss: 'https://accounts.google.com', aud: GOOGLE_CLIENT, sub: 'g', email: 'a@example.com', email_verified: true, exp: Math.floor(Date.now() / 1000) + 600 }, kid);
    expect(await check(idp, await withKid('k1'), 'google', deps)).toBeTypeOf('object');
    rotated = true;
    expect(await check(idp, await withKid('k2'), 'google', deps)).toBeTypeOf('object');
    expect(fetches).toBe(2);
  });

  it('keys are cached for an hour, then fetched again', async () => {
    const idp = await makeIdp();
    let clock = Date.now(); idp.deps.now = () => clock;
    const good = () => idp.google('a@example.com');
    await check(idp, await good()); await check(idp, await good());
    expect(idp.stats.fetches).toBe(1);
    clock += 3_600_001;
    await check(idp, await good());
    expect(idp.stats.fetches).toBe(2);
  });
});

afterAll(() => { void MS_TENANT; });
