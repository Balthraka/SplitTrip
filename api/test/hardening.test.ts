import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { CURRENCIES } from '../src/currencies';
import { NONCE } from '../core/test/helpers';
import { scenario } from './helpers';

let s: Awaited<ReturnType<typeof scenario>>;
beforeAll(async () => { s = await scenario(); });

describe('response headers added by SplitTrip (the core is not changed)', () => {
  it('every reply, success or error, carries nosniff and no-referrer, and the core\'s headers are still there', async () => {
    for (const r of [await s.api.call('GET', '/me', undefined, s.alice), await s.api.call('GET', '/me'), await s.api.call('GET', '/nope'),
                     await s.api.call('OPTIONS', '/me', undefined, undefined, { origin: 'https://app.example.com' })]) {
      expect(r.headers.get('x-content-type-options')).toBe('nosniff');
      expect(r.headers.get('referrer-policy')).toBe('no-referrer');
    }
    const ok = await s.api.call('GET', '/me', undefined, s.alice);
    expect(ok.headers.get('cache-control')).toBe('no-store');
    expect(ok.headers.get('content-type')).toContain('application/json');
    const blocked = await s.api.call('GET', '/me', undefined, s.alice, { origin: 'https://evil.example.com' });
    expect(blocked.status).toBe(403); expect(blocked.headers.get('x-content-type-options')).toBe('nosniff');
  });
});

describe('currencies: only the ones the page offers (anything else would break Settle Up for the whole trip)', () => {
  it('the Worker\'s list is exactly the page\'s list', () => {
    const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../web/index.html'), 'utf8');
    const page = [...html.split('const CURRENCIES = [')[1].split(']')[0].matchAll(/'([A-Z]{3})'/g)].map(m => m[1]);
    expect([...CURRENCIES].sort()).toEqual([...page].sort());
    expect(new Set(CURRENCIES).size).toBe(CURRENCIES.length);
  });
  it('an unknown currency is 400 on trips, expenses and payments; known ones, including every one real data uses, work', async () => {
    const trip = (cur: string) => s.api.j('POST', '/trips', { name: 'T', base_currency: cur, expense_currency: cur, members: [{ name: 'A', is_self: true }, { name: 'B' }] }, s.alice);
    for (const bad of ['ZZZ', 'XXX', 'aud', 'AU', 'AUDD', '', 'A1D']) {
      const r = await trip(bad); expect(r.status, bad).toBe(400); expect(r.body.error).toBe('invalid_base_currency');
    }
    for (const ok of ['AUD', 'AZN', 'GEL', 'SGD', 'TRY', 'VND']) expect((await trip(ok)).status, ok).toBe(201);
    const exp = (cur: string) => s.api.j('POST', `/trips/${s.tripA.id}/expenses`, { paid_by_member_id: s.memA('Alice'), amount_cents: 100, currency: cur, date: '2026-03-01', description: 'x', split_type: 'single', splits: [{ member_id: s.memA('Alice'), amount_cents: 100 }] }, s.alice);
    expect((await exp('ZZZ')).body.error).toBe('invalid_currency');
    expect((await exp('EUR')).status).toBe(201);
    const pay = (cur: string) => s.api.j('POST', `/trips/${s.tripA.id}/payments`, { from_member_id: s.memA('Dave'), to_member_id: s.memA('Alice'), amount_cents: 100, currency: cur }, s.alice);
    expect((await pay('ZZZ')).body.error).toBe('invalid_currency');
    expect((await pay('USD')).status).toBe(201);
    const patch = (cur: string) => s.api.j('PATCH', `/trips/${s.tripA.id}`, { version: 1, name: 'Alice trip', base_currency: cur, expense_currency: 'AUD' }, s.alice);
    expect((await patch('ZZZ')).status).toBe(400);
    expect((await patch('GBP')).status).toBe(200);
  });
});

describe('POST /me/claim also returns the signed-in user (the page opens with this one call instead of /me then /me/claim)', () => {
  it('Google session: claimed count plus id, email and name; identical user fields to GET /me', async () => {
    const me = (await s.api.j('GET', '/me', undefined, s.bob)).body;
    const c = await s.api.j('POST', '/me/claim', undefined, s.bob);
    expect(c.status).toBe(200);
    expect(c.body).toEqual({ claimed: 0, ...me });
  });
  it('Microsoft session (never verified): claims nothing but still returns the user', async () => {
    const ms = (await s.api.j('POST', '/auth/microsoft', { idToken: await s.idp.microsoft('alice@example.com'), nonce: NONCE })).body;
    const me = (await s.api.j('GET', '/me', undefined, s.alice)).body;
    await s.api.j('POST', `/trips/${s.tripA.id}/members`, { name: 'Alice again', email: 'alice@example.com' }, s.alice);   // an unclaimed row with her email
    const c = await s.api.j('POST', '/me/claim', undefined, ms.token);
    expect(c.body).toEqual({ claimed: 0, ...me });                       // unverified email: nothing claimed
  });
  it('no token: 401, nothing returned', async () => {
    const c = await s.api.j('POST', '/me/claim');
    expect(c.status).toBe(401); expect(c.body).toEqual({ error: 'unauthorized' });
  });
});

describe('the page loads no Tailwind compiler', () => {
  it('has no tailwind CDN script, and the built-in CSS block is up to date', async () => {
    const page = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../web/index.html'), 'utf8');
    expect(page).not.toMatch(/cdn\.tailwindcss\.com/);
    expect(page).not.toMatch(/tailwind\.config/);
    const { execFileSync } = await import('node:child_process');
    execFileSync('node', [join(dirname(fileURLToPath(import.meta.url)), '../scripts/build-css.mjs'), '--check'], { stdio: 'pipe' });   // throws if out of date
  });
});
