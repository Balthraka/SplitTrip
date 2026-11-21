import { NONCE } from '../core/test/helpers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes } from '../src/router';
import { handle } from '../src/index';
import { makeApi, makeEnv, makeIdp, scenario, seedUser, signIn, uid } from './helpers';

type S = Awaited<ReturnType<typeof scenario>>;
let s: S;
beforeAll(async () => { s = await scenario(); });
afterAll(async () => { await s.close(); });

const fill = (path: string, ids: Record<string, string>) => path.replace(/:(\w+)/g, (_, k) => ids[k] ?? uid(999));

describe('route table', () => {
  it('only /auth/* is public; every other route has a sign-in guard; every :tripId route has a trip guard', () => {
    for (const r of routes) {
      if (r.guard === 'public') expect(r.path.startsWith('/auth/'), r.path).toBe(true);
      else expect(['user', 'member', 'creator']).toContain(r.guard);
      if (r.path.includes(':tripId')) expect(['member', 'creator'], `${r.method} ${r.path}`).toContain(r.guard);
      if (r.path.startsWith('/auth/')) expect(r.guard).toBe('public');
    }
  });

  it('every non-public route returns 401 with no token, a malformed token, and an unknown token', async () => {
    for (const r of routes.filter(r => r.guard !== 'public')) {
      const path = fill(r.path, {});
      for (const token of [undefined, 'x', 'A'.repeat(43)]) {
        const res = await s.api.j(r.method, path, r.method === 'GET' || r.method === 'DELETE' ? undefined : {}, token);
        expect(res.status, `${r.method} ${r.path} token=${token}`).toBe(401);
      }
    }
  });

  it('unknown paths are 404 and wrong methods 405 without leaking anything', async () => {
    expect((await s.api.j('GET', '/nope')).status).toBe(404);
    expect((await s.api.j('PUT', '/me', {}, s.alice)).status).toBe(405);
  });
});

describe('user A cannot touch user B\'s trip (every route, real ids)', () => {
  it('bob gets 404 on every :tripId route of alice\'s trip, and nothing changes', async () => {
    const e = (await s.expense(s.alice, s.tripA, s.memA('Alice'), s.memA('Alice'), s.memA('Dave'))).body;
    const pay = (await s.api.j('POST', `/trips/${s.tripA.id}/payments`, { from_member_id: s.memA('Dave'), to_member_id: s.memA('Alice'), amount_cents: 500, currency: 'AUD' }, s.alice)).body;
    const ids = { tripId: s.tripA.id, expenseId: e.id, memberId: s.memA('Dave'), paymentId: pay.id };
    const before = JSON.stringify(await s.raw.prepare('SELECT (SELECT COUNT(*) FROM expenses) a,(SELECT COUNT(*) FROM trip_members) b,(SELECT COUNT(*) FROM payments) c,(SELECT COUNT(*) FROM trips) d').first());
    const bodies: Record<string, unknown> = {
      'POST /trips/:tripId/members': { name: 'Mallory' }, 'PATCH /trips/:tripId': { version: 1, name: 'x', base_currency: 'AUD', expense_currency: 'AUD' },
      'POST /trips/:tripId/expenses': {}, 'PUT /trips/:tripId/expenses/:expenseId': { version: 1 }, 'POST /trips/:tripId/payments': {},
      'POST /trips/:tripId/payments/:paymentId/confirm': {},
    };
    for (const r of routes.filter(r => r.path.includes(':tripId'))) {
      const res = await s.api.j(r.method, fill(r.path, ids), bodies[`${r.method} ${r.path}`], s.bob);
      expect(res.status, `${r.method} ${r.path}`).toBe(404);
    }
    const after = JSON.stringify(await s.raw.prepare('SELECT (SELECT COUNT(*) FROM expenses) a,(SELECT COUNT(*) FROM trip_members) b,(SELECT COUNT(*) FROM payments) c,(SELECT COUNT(*) FROM trips) d').first());
    expect(after).toBe(before);
  });

  it('bob\'s trip list never contains alice\'s trip', async () => {
    const r = await s.api.j('GET', '/trips', undefined, s.bob);
    expect(r.body.map((t: any) => t.id)).toEqual([s.tripB.id]);
  });

  it('ids from another trip are refused even through a trip the caller belongs to', async () => {
    const e = (await s.expense(s.alice, s.tripA, s.memA('Alice'), s.memA('Alice'), s.memA('Dave'))).body;
    const pay = (await s.api.j('POST', `/trips/${s.tripA.id}/payments`, { from_member_id: s.memA('Dave'), to_member_id: s.memA('Alice'), amount_cents: 100, currency: 'AUD' }, s.alice)).body;
    const T = s.tripB.id; // bob IS the creator and a member of trip B
    expect((await s.api.j('DELETE', `/trips/${T}/expenses/${e.id}`, undefined, s.bob)).status).toBe(404);
    expect((await s.api.j('PUT', `/trips/${T}/expenses/${e.id}`, { version: 1 }, s.bob)).status).toBe(404);
    expect((await s.api.j('POST', `/trips/${T}/payments/${pay.id}/confirm`, undefined, s.bob)).status).toBe(404);
    expect((await s.api.j('DELETE', `/trips/${T}/payments/${pay.id}`, undefined, s.bob)).status).toBe(404);
    expect((await s.api.j('DELETE', `/trips/${T}/members/${s.memA('Dave')}`, undefined, s.bob)).status).toBe(404);
    // an expense in trip B may not name a member of trip A
    const bad = await s.expense(s.bob, s.tripB, s.memB('Bob'), s.memB('Bob'), s.memA('Dave'));
    expect(bad.status).toBe(400);
  });
});

describe('old row-level-security rules, one test each', () => {
  it('creator-only: update/delete trip, remove member, update/delete expense', async () => {
    const t = s.tripA;
    // carol becomes a member (added by alice, then claimed by email so she is linked)
    await s.api.j('POST', `/trips/${t.id}/members`, { name: 'Carol', email: 'carol@example.com' }, s.alice);
    expect((await s.api.j('POST', '/me/claim', undefined, s.carol)).body.claimed).toBe(1);
    expect((await s.api.j('GET', `/trips/${t.id}`, undefined, s.carol)).status).toBe(200);
    expect((await s.api.j('PATCH', `/trips/${t.id}`, { version: 1, name: 'x', base_currency: 'AUD', expense_currency: 'AUD' }, s.carol)).status).toBe(403);
    expect((await s.api.j('DELETE', `/trips/${t.id}`, undefined, s.carol)).status).toBe(403);
    const m = (await s.api.j('GET', `/trips/${t.id}/members`, undefined, s.carol)).body.find((x: any) => x.name === 'Dave').id;
    expect((await s.api.j('DELETE', `/trips/${t.id}/members/${m}`, undefined, s.carol)).status).toBe(403);
    const e = (await s.expense(s.alice, t, s.memA('Alice'), s.memA('Alice'), s.memA('Dave'))).body;
    const edit = { version: e.version, paid_by_member_id: s.memA('Alice'), amount_cents: 1001, currency: 'AUD', date: '2026-03-01', description: 'x', split_type: 'equal', splits: [{ member_id: s.memA('Alice'), amount_cents: 501 }, { member_id: s.memA('Dave'), amount_cents: 500 }] };
    expect((await s.api.j('PUT', `/trips/${t.id}/expenses/${e.id}`, edit, s.carol)).status).toBe(403);
    expect((await s.api.j('DELETE', `/trips/${t.id}/expenses/${e.id}`, undefined, s.carol)).status).toBe(403);
    expect((await s.api.j('PUT', `/trips/${t.id}/expenses/${e.id}`, edit, s.alice)).status).toBe(200);
  });

  it('any member may add members, expenses and payments; only pending payments can be deleted, by initiator or either party', async () => {
    const t = s.tripA;
    expect((await s.api.j('POST', `/trips/${t.id}/members`, { name: 'Frank' }, s.carol)).status).toBe(201);
    const p = (await s.api.j('POST', `/trips/${t.id}/payments`, { from_member_id: s.memA('Dave'), to_member_id: s.memA('Alice'), amount_cents: 700, currency: 'AUD' }, s.carol)).body;
    expect(p.status).toBe('pending');
    expect((await s.api.j('DELETE', `/trips/${t.id}/payments/${p.id}`, undefined, s.carol)).status).toBe(200); // initiator
    const p2 = (await s.api.j('POST', `/trips/${t.id}/payments`, { from_member_id: s.memA('Dave'), to_member_id: s.memA('Alice'), amount_cents: 700, currency: 'AUD' }, s.carol)).body;
    expect((await s.api.j('DELETE', `/trips/${t.id}/payments/${p2.id}`, undefined, s.alice)).status).toBe(200); // payee
    const p3 = (await s.api.j('POST', `/trips/${t.id}/payments`, { from_member_id: s.memA('Dave'), to_member_id: s.memA('Alice'), amount_cents: 700, currency: 'AUD' }, s.alice)).body;
    expect((await s.api.j('POST', `/trips/${t.id}/payments/${p3.id}/confirm`, undefined, s.carol)).status).toBe(200);
    expect((await s.api.j('POST', `/trips/${t.id}/payments/${p3.id}/confirm`, undefined, s.carol)).status).toBe(409); // no longer pending
    expect((await s.api.j('DELETE', `/trips/${t.id}/payments/${p3.id}`, undefined, s.alice)).status).toBe(409);       // confirmed: cannot delete
  });

  it('profiles: only your own row is readable/updatable (narrower than the old "any signed-in user can read all profiles")', async () => {
    expect((await s.api.j('GET', '/me', undefined, s.alice)).body.email).toBe('alice@example.com');
    const renamed = await s.api.j('PATCH', '/me', { name: 'Alice Renamed' }, s.alice);
    expect(renamed.body.name).toBe('Alice Renamed');
    const names = await s.raw.prepare("SELECT name FROM trip_members WHERE user_id = ?1").bind(uid(1)).all();
    expect(names.results.every((r: any) => r.name === 'Alice Renamed')).toBe(true);
    expect((await s.api.j('PATCH', '/me', { name: '' }, s.alice)).status).toBe(400);
  });
});

describe('sign-in', () => {
  it('Google: bad signature, wrong audience, expired, unverified email and unknown key are all 401/403', async () => {
    const idp = s.idp;
    const post = async (tok: string) => (await s.api.j('POST', '/auth/google', { idToken: tok })).status;
    expect(await post(await idp.otherKeySign({ iss: 'https://accounts.google.com', aud: s.env.GOOGLE_CLIENT_ID, sub: 'x', email: 'alice@example.com', email_verified: true, iat: idp.iat, exp: idp.exp }))).toBe(401);
    expect(await post(await idp.google('alice@example.com', { aud: 'someone-elses-client' }))).toBe(401);
    expect(await post(await idp.google('alice@example.com', { exp: Math.floor(Date.now() / 1000) - 7200 }))).toBe(401);
    expect(await post(await idp.google('alice@example.com', { iss: 'https://evil.example.com' }))).toBe(401);
    expect(await post(await idp.sign({ iss: 'https://accounts.google.com', aud: s.env.GOOGLE_CLIENT_ID, sub: 'x', email: 'alice@example.com', email_verified: true, iat: idp.iat, exp: idp.exp }, 'unknown-kid'))).toBe(401);
    expect(await post(await idp.google('bob@example.com', { sub: 'fresh-sub-1', email_verified: false }))).toBe(403); // not verified, not yet linked
    expect(await post('not-a-jwt')).toBe(401);
  });

  it('private mode: an email that is not in users is refused with 403 not_invited', async () => {
    const r = await s.api.j('POST', '/auth/google', { idToken: await s.idp.google('stranger@example.com') });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('not_invited');
    expect(await s.raw.prepare("SELECT COUNT(*) n FROM users WHERE email='stranger@example.com'").first('n')).toBe(0);
  });

  it('public mode creates the user only when ALLOW_SIGNUPS is "true"', async () => {
    const env2 = await makeEnv({ ALLOW_SIGNUPS: 'true' });
    const api2 = makeApi(env2.env, s.idp.deps);
    const r = await api2.j('POST', '/auth/google', { idToken: await s.idp.google('newbie@example.com') });
    expect(r.status).toBe(200);
    await env2.close();
  });

  it('first sign-in links the existing user by verified email, later sign-ins match the provider subject, not the email', async () => {
    await seedUser(s.env, uid(20), 'linker@example.com', 'Linker');
    const first = await s.api.j('POST', '/auth/google', { idToken: await s.idp.google('linker@example.com') });
    expect(first.body.user.id).toBe(uid(20));
    // an attacker who later gets a token with the same email but a different `sub` is refused (already linked)
    const hijack = await s.api.j('POST', '/auth/google', { idToken: await s.idp.google('linker@example.com', { sub: 'attacker-sub' }) });
    expect(hijack.status).toBe(403);
    expect(hijack.body.error).toBe('account_already_linked');
  });

  it('Microsoft: allowlist = users table; consumer tenant only; never counts as a verified email', async () => {
    await seedUser(s.env, uid(21), 'hot@example.com', 'Hot');
    expect((await s.api.j('POST', '/auth/microsoft', { idToken: await s.idp.microsoft('unknown@example.com'), nonce: NONCE })).status).toBe(403);
    expect((await s.api.j('POST', '/auth/microsoft', { idToken: await s.idp.microsoft('hot@example.com', { tid: 'some-work-tenant' }), nonce: NONCE })).status).toBe(401);
    const ok = await s.api.j('POST', '/auth/microsoft', { idToken: await s.idp.microsoft('hot@example.com'), nonce: NONCE });
    expect(ok.status).toBe(200);
    expect(await s.raw.prepare('SELECT verified_email v FROM sessions WHERE user_id = ?1').bind(uid(21)).first('v')).toBe(0);
  });

  it('claim_memberships only works on a provider-verified email (a Microsoft session claims nothing)', async () => {
    await seedUser(s.env, uid(22), 'invitee@example.com', 'Invitee');
    await s.api.j('POST', `/trips/${s.tripB.id}/members`, { name: 'Invitee', email: 'Invitee@Example.com ' }, s.bob); // stored lowercased
    const ms = (await s.api.j('POST', '/auth/microsoft', { idToken: await s.idp.microsoft('invitee@example.com'), nonce: NONCE })).body.token;
    expect((await s.api.j('POST', '/me/claim', undefined, ms)).body.claimed).toBe(0);
    const g = await signIn(s.api, s.idp, 'invitee@example.com');
    expect((await s.api.j('POST', '/me/claim', undefined, g)).body.claimed).toBe(1);
    expect((await s.api.j('POST', '/me/claim', undefined, g)).body.claimed).toBe(0); // idempotent
  });

  it('session tokens are stored hashed, expire, and can be revoked', async () => {
    const tok = await signIn(s.api, s.idp, 'alice@example.com');
    const rows = (await s.raw.prepare('SELECT token_hash, expires_at FROM sessions').all()).results as any[];
    expect(rows.some(r => r.token_hash === tok)).toBe(false);
    expect(rows.every(r => /^[0-9a-f]{64}$/.test(r.token_hash))).toBe(true);
    // expired: same token, clock moved 31 days on
    const late = makeApi(s.env, { ...s.idp.deps, now: () => Date.now() + 31 * 86_400_000 });
    expect((await late.j('GET', '/me', undefined, tok)).status).toBe(401);
    expect((await s.api.j('POST', '/me/logout', undefined, tok)).status).toBe(200);
    expect((await s.api.j('GET', '/me', undefined, tok)).status).toBe(401);
  });
});

describe('CORS', () => {
  const pre = (origin: string) => handle(new Request('https://api.test/me', { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'GET' } }), s.env);
  it('allows only the configured origin, never *', async () => {
    const ok = await pre('https://app.example.com');
    expect(ok.status).toBe(204);
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://app.example.com');
    expect((await pre('https://evil.example.com')).status).toBe(403);
    const res = await s.api.call('GET', '/me', undefined, s.alice, { origin: 'https://evil.example.com' });
    expect(res.status).toBe(403);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    const wild = await makeEnv({ ALLOWED_ORIGINS: '*' });
    const r = await handle(new Request('https://api.test/me', { method: 'OPTIONS', headers: { origin: 'https://anything.example.com' } }), wild.env);
    expect(r.status).toBe(403);
    await wild.close();
  });
});
