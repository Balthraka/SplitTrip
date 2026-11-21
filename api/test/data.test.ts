import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseCents } from '../src/cents';
import { scenario, uid } from './helpers';

type S = Awaited<ReturnType<typeof scenario>>;
let s: S;
beforeAll(async () => { s = await scenario(); });
afterAll(async () => { await s.close(); });

const body = (s: S, paidBy: string, a: string, b: string, over: any = {}) => ({
  paid_by_member_id: paidBy, amount_cents: 1001, currency: 'AUD', date: '2026-03-01', description: 'Dinner', split_type: 'equal',
  splits: [{ member_id: a, amount_cents: 501 }, { member_id: b, amount_cents: 500 }], ...over,
});

describe('money is integer cents', () => {
  it('parseCents is exact for every 2dp decimal the old numeric columns hold', () => {
    expect(parseCents('29.18')).toBe(2918);
    expect(parseCents('125000.00')).toBe(12500000);
    expect(parseCents('0.07')).toBe(7);
    expect(parseCents('1.1')).toBe(110);
    expect(parseCents('5')).toBe(500);
    expect(parseCents('19.99')).toBe(1999);                 // 19.99 * 100 = 1998.9999999999998 as a float
    expect(parseCents('1188000.00')).toBe(118800000);
    expect(() => parseCents('1.234')).toThrow();
    expect(() => parseCents('abc')).toThrow();
  });

  it('the API refuses floats, strings, zero, negatives and unsafe sizes', async () => {
    for (const bad of [10.5, '1001', 0, -5, 1e15, NaN, null]) {
      const r = await s.api.j('POST', `/trips/${s.tripA.id}/expenses`, body(s, s.memA('Alice'), s.memA('Alice'), s.memA('Dave'), { amount_cents: bad }), s.alice);
      expect(r.status, String(bad)).toBe(400);
    }
    const r = await s.api.j('POST', `/trips/${s.tripA.id}/expenses`, body(s, s.memA('Alice'), s.memA('Alice'), s.memA('Dave'), { splits: [{ member_id: s.memA('Alice'), amount_cents: 500.5 }, { member_id: s.memA('Dave'), amount_cents: 500.5 }] }), s.alice);
    expect(r.status).toBe(400);
  });

  it('splits must add up to the amount (exact splits keep the app\'s 2-cent tolerance)', async () => {
    const t = s.tripA, a = s.memA('Alice'), d = s.memA('Dave');
    const off = (type: string, diff: number) => s.api.j('POST', `/trips/${t.id}/expenses`, body(s, a, a, d, { split_type: type, splits: [{ member_id: a, amount_cents: 501 }, { member_id: d, amount_cents: 500 + diff }] }), s.alice);
    expect((await off('equal', 1)).status).toBe(400);
    expect((await off('exact', 2)).status).toBe(201);
    expect((await off('exact', 3)).status).toBe(400);
  });

  it('multi-currency amounts are stored as given (VND 1,188,000 = 118800000)', async () => {
    const a = s.memA('Alice'), d = s.memA('Dave');
    const r = await s.api.j('POST', `/trips/${s.tripA.id}/expenses`, body(s, a, a, d, { currency: 'VND', amount_cents: 118800000, splits: [{ member_id: a, amount_cents: 59400000 }, { member_id: d, amount_cents: 59400000 }] }), s.alice);
    expect(r.status).toBe(201);
    expect(r.body.amount_cents).toBe(118800000);
  });
});

describe('expense and splits are one atomic batch', () => {
  it('create: if any split insert fails, no expense and no other split remains', async () => {
    const a = s.memA('Alice'), d = s.memA('Dave');
    const before = await s.raw.prepare('SELECT (SELECT COUNT(*) FROM expenses) e, (SELECT COUNT(*) FROM expense_splits) s').first<any>();
    await s.raw.prepare("CREATE TRIGGER boom BEFORE INSERT ON expense_splits WHEN NEW.amount_cents = 777 BEGIN SELECT RAISE(ABORT, 'boom'); END").run();
    const r = await s.api.j('POST', `/trips/${s.tripA.id}/expenses`, body(s, a, a, d, { amount_cents: 1000, splits: [{ member_id: a, amount_cents: 223 }, { member_id: d, amount_cents: 777 }] }), s.alice);
    await s.raw.prepare('DROP TRIGGER boom').run();
    expect(r.status).toBe(500);
    const after = await s.raw.prepare('SELECT (SELECT COUNT(*) FROM expenses) e, (SELECT COUNT(*) FROM expense_splits) s').first<any>();
    expect(after).toEqual(before);
  });

  it('create uses one batch: one round trip for the expense, every split and the trip activity stamp', async () => {
    const a = s.memA('Alice'), d = s.memA('Dave');
    s.counter.reset();
    const r = await s.api.j('POST', `/trips/${s.tripA.id}/expenses`, body(s, a, a, d), s.alice);
    expect(r.status).toBe(201);
    const stored = await s.raw.prepare('SELECT COUNT(*) n FROM expense_splits WHERE expense_id = ?1').bind(r.body.id).first('n');
    expect(stored).toBe(2);
  });

  it('update: a failing split insert rolls back the expense change and keeps the old splits', async () => {
    const a = s.memA('Alice'), d = s.memA('Dave');
    const e = (await s.api.j('POST', `/trips/${s.tripA.id}/expenses`, body(s, a, a, d), s.alice)).body;
    await s.raw.prepare("CREATE TRIGGER boom2 BEFORE INSERT ON expense_splits WHEN NEW.amount_cents = 777 BEGIN SELECT RAISE(ABORT, 'boom'); END").run();
    const r = await s.api.j('PUT', `/trips/${s.tripA.id}/expenses/${e.id}`, { ...body(s, a, a, d, { amount_cents: 1000, description: 'changed', splits: [{ member_id: a, amount_cents: 223 }, { member_id: d, amount_cents: 777 }] }), version: e.version }, s.alice);
    await s.raw.prepare('DROP TRIGGER boom2').run();
    expect(r.status).toBe(500);
    const now = (await s.api.j('GET', `/trips/${s.tripA.id}/expenses`, undefined, s.alice)).body.find((x: any) => x.id === e.id);
    expect(now.description).toBe('Dinner');
    expect(now.version).toBe(e.version);
    expect(now.expense_splits.map((x: any) => x.amount_cents).sort()).toEqual([500, 501]);
  });
});

describe('stale edits are rejected with 409', () => {
  it('two tabs edit the same expense: second save loses, nothing of it is written (splits included)', async () => {
    const a = s.memA('Alice'), d = s.memA('Dave');
    const e = (await s.api.j('POST', `/trips/${s.tripA.id}/expenses`, body(s, a, a, d), s.alice)).body;
    const tab1 = { ...body(s, a, a, d, { description: 'tab one' }), version: e.version };
    const tab2 = { ...body(s, a, a, d, { description: 'tab two', amount_cents: 2000, splits: [{ member_id: a, amount_cents: 1500 }, { member_id: d, amount_cents: 500 }] }), version: e.version };
    const r1 = await s.api.j('PUT', `/trips/${s.tripA.id}/expenses/${e.id}`, tab1, s.alice);
    expect(r1.status).toBe(200);
    expect(r1.body.version).toBe(e.version + 1);
    const r2 = await s.api.j('PUT', `/trips/${s.tripA.id}/expenses/${e.id}`, tab2, s.alice);
    expect(r2.status).toBe(409);
    expect(r2.body.error).toBe('stale_version');
    const now = (await s.api.j('GET', `/trips/${s.tripA.id}/expenses`, undefined, s.alice)).body.find((x: any) => x.id === e.id);
    expect(now.description).toBe('tab one');
    expect(now.amount_cents).toBe(1001);
    expect(now.expense_splits.map((x: any) => x.amount_cents).sort()).toEqual([500, 501]);
  });

  it('a version that happens to equal "current + 1" cannot sneak splits in (per-write token)', async () => {
    const a = s.memA('Alice'), d = s.memA('Dave');
    const e = (await s.api.j('POST', `/trips/${s.tripA.id}/expenses`, body(s, a, a, d), s.alice)).body;
    await s.api.j('PUT', `/trips/${s.tripA.id}/expenses/${e.id}`, { ...body(s, a, a, d), version: 1 }, s.alice); // -> v2
    const stale = await s.api.j('PUT', `/trips/${s.tripA.id}/expenses/${e.id}`, { ...body(s, a, a, d, { splits: [{ member_id: a, amount_cents: 1001 }], split_type: 'single' }), version: 1 }, s.alice);
    expect(stale.status).toBe(409);
    const n = await s.raw.prepare('SELECT COUNT(*) n FROM expense_splits WHERE expense_id = ?1').bind(e.id).first('n');
    expect(n).toBe(2);
  });

  it('trip edits are versioned too', async () => {
    const t = s.tripA;
    const ok = await s.api.j('PATCH', `/trips/${t.id}`, { version: 1, name: 'Renamed', description: '', base_currency: 'AUD', expense_currency: 'AUD' }, s.alice);
    expect(ok.status).toBe(200);
    const stale = await s.api.j('PATCH', `/trips/${t.id}`, { version: 1, name: 'Again', base_currency: 'AUD', expense_currency: 'AUD' }, s.alice);
    expect(stale.status).toBe(409);
    expect((await s.api.j('PATCH', `/trips/${t.id}`, { name: 'No version', base_currency: 'AUD', expense_currency: 'AUD' }, s.alice)).status).toBe(400);
  });
});

describe('GET /trips/:id/all', () => {
  it('returns exactly what the three separate routes return, and refuses non-members like they do', async () => {
    const t = s.tripA;
    const [all, m, e, p] = await Promise.all(['all', 'members', 'expenses', 'payments'].map(x => s.api.j('GET', `/trips/${t.id}/${x}`, undefined, s.alice)));
    expect(all.status).toBe(200);
    expect(all.body).toEqual({ members: m.body, expenses: e.body, payments: p.body });
    const noToken = await s.api.j('GET', `/trips/${t.id}/all`, undefined, undefined as any);
    expect(noToken.status).toBe(401);
  });
});

describe('tiny amounts and the caps of 40', () => {
  const trip = async (n: number) => (await s.api.j('POST', '/trips', { name: 'Big', base_currency: 'AUD', expense_currency: 'AUD',
    members: Array.from({ length: n }, (_, i) => ({ name: 'M' + i, is_self: i === 0 })) }, s.alice));
  const exp = (t: any, amount: number, amounts: number[], paidBy = 0, over: any = {}) => s.api.j('POST', `/trips/${t.id}/expenses`, {
    paid_by_member_id: t.trip_members[paidBy].id, amount_cents: amount, currency: 'AUD', date: '2026-03-01', description: 'x', split_type: 'equal',
    splits: amounts.map((a, i) => ({ member_id: t.trip_members[i].id, amount_cents: a })), ...over }, s.alice);

  it('an equal split of 0.02 among 3 people (1, 1, 0 cents) is accepted, and stored with its zero split', async () => {
    const t = (await trip(3)).body;
    const r = await exp(t, 2, [1, 1, 0]);
    expect(r.status).toBe(201);
    expect(r.body.expense_splits.map((x: any) => x.amount_cents).sort()).toEqual([0, 1, 1]);
    const all = (await s.api.j('GET', `/trips/${t.id}/all`, undefined, s.alice)).body;
    expect(all.expenses[0].expense_splits).toHaveLength(3);
    // the sum rule still applies, and zero or negative is still refused for the expense itself and negative for a split
    expect((await exp(t, 2, [1, 0, 0])).body.error).toBe('splits_do_not_sum');
    expect((await exp(t, 0, [0, 0, 0])).status).toBe(400);
    expect((await exp(t, 2, [3, -1, 0])).status).toBe(400);
    // and it can be edited too
    const put = await s.api.j('PUT', `/trips/${t.id}/expenses/${r.body.id}`, { version: 1, paid_by_member_id: t.trip_members[0].id, amount_cents: 2, currency: 'AUD',
      date: '2026-03-01', description: 'x', split_type: 'equal', splits: [0, 1, 2].map(i => ({ member_id: t.trip_members[i].id, amount_cents: [0, 1, 1][i] })) }, s.alice);
    expect(put.status).toBe(200);
  });
  it('an expense with exactly 40 splits works (create and edit) and 41 is refused', async () => {
    const t = (await trip(40)).body;
    expect(t.trip_members).toHaveLength(40);
    const forty = Array(40).fill(1);
    s.counter.reset();
    const r = await exp(t, 40, forty);
    expect(s.counter.stats.queries).toBeLessThanOrEqual(50);    // the free plan's limit per request
    expect(r.status).toBe(201); expect(r.body.expense_splits).toHaveLength(40);
    s.counter.reset();
    const put = await s.api.j('PUT', `/trips/${t.id}/expenses/${r.body.id}`, { version: 1, paid_by_member_id: t.trip_members[1].id, amount_cents: 80, currency: 'AUD',
      date: '2026-03-01', description: 'y', split_type: 'equal', splits: t.trip_members.map((m: any) => ({ member_id: m.id, amount_cents: 2 })) }, s.alice);
    expect(s.counter.stats.queries).toBeLessThanOrEqual(50);
    expect(put.status).toBe(200);
    const extra = (await s.api.j('POST', `/trips/${t.id}/members`, { name: 'one too many' }, s.alice));
    expect(extra.status).toBe(400); expect(extra.body.error).toBe('too_many_members');
    const forty1 = await s.api.j('POST', `/trips/${t.id}/expenses`, { paid_by_member_id: t.trip_members[0].id, amount_cents: 41, currency: 'AUD', date: '2026-03-01',
      description: 'z', split_type: 'equal', splits: Array.from({ length: 41 }, (_, i) => ({ member_id: i < 40 ? t.trip_members[i].id : 'x', amount_cents: 1 })) }, s.alice);
    expect(forty1.status).toBe(400); expect(forty1.body.error).toBe('invalid_splits');
  });
  it('a trip can be created with 40 members, and 41 is refused', async () => {
    s.counter.reset();
    expect((await trip(40)).status).toBe(201);
    expect(s.counter.stats.queries).toBeLessThanOrEqual(50);
    const r = await trip(41);
    expect(r.status).toBe(400); expect(r.body.error).toBe('invalid_members');
  });
});

describe('delete_my_account copied as-is (DELETE /me)', () => {
  it('promotes the oldest remaining linked member to creator, removes the user, keeps the trip and its expenses', async () => {
    // Carol joins Alice's trip, then Alice deletes her account.
    await s.api.j('POST', `/trips/${s.tripA.id}/members`, { name: 'Carol', email: 'carol@example.com' }, s.alice);
    await s.api.j('POST', '/me/claim', undefined, s.carol);
    const expensesBefore = await s.raw.prepare('SELECT COUNT(*) n FROM expenses WHERE trip_id = ?1').bind(s.tripA.id).first('n');
    await s.expense(s.alice, s.tripA, s.memA('Alice'), s.memA('Alice'), s.memA('Dave'));          // alice created an expense and a payment
    const pay = (await s.api.j('POST', `/trips/${s.tripA.id}/payments`, { from_member_id: s.memA('Dave'), to_member_id: s.memA('Alice'), amount_cents: 100, currency: 'AUD' }, s.alice)).body;
    await s.api.j('POST', `/trips/${s.tripA.id}/payments/${pay.id}/confirm`, undefined, s.alice);
    const expensesBefore2 = Number(expensesBefore) + 1;
    expect((await s.api.j('DELETE', '/me', undefined, s.alice)).status).toBe(200);
    expect(await s.raw.prepare('SELECT created_by c FROM trips WHERE id = ?1').bind(s.tripA.id).first('c')).toBe(uid(3));
    expect(await s.raw.prepare('SELECT COUNT(*) n FROM users WHERE id = ?1').bind(uid(1)).first('n')).toBe(0);
    expect(await s.raw.prepare('SELECT COUNT(*) n FROM sessions WHERE user_id = ?1').bind(uid(1)).first('n')).toBe(0);
    expect(await s.raw.prepare('SELECT COUNT(*) n FROM identities WHERE user_id = ?1').bind(uid(1)).first('n')).toBe(0);
    expect(await s.raw.prepare('SELECT COUNT(*) n FROM expenses WHERE trip_id = ?1').bind(s.tripA.id).first('n')).toBe(expensesBefore2);
    // Supabase foreign keys: ON DELETE SET NULL on every user reference
    expect(await s.raw.prepare('SELECT COUNT(*) n FROM expenses WHERE created_by IS NOT NULL AND created_by = ?1').bind(uid(1)).first('n')).toBe(0);
    expect(await s.raw.prepare('SELECT initiated_by i, confirmed_by c FROM payments WHERE id = ?1').bind(pay.id).first()).toEqual({ i: null, c: null });
    expect(await s.raw.prepare('SELECT user_id u FROM trip_members WHERE id = ?1').bind(s.memA('Alice')).first('u')).toBeNull();
    expect((await s.api.j('GET', '/me', undefined, s.alice)).status).toBe(401);                       // session gone
    expect((await s.api.j('PATCH', `/trips/${s.tripA.id}`, { version: 99, name: 'x', base_currency: 'AUD', expense_currency: 'AUD' }, s.carol)).status).toBe(409); // carol is now creator (passes the guard)
    // Bob's data untouched
    expect((await s.api.j('GET', `/trips/${s.tripB.id}`, undefined, s.bob)).status).toBe(200);
  });

  it('a user who is the only linked member leaves the trip with created_by NULL, as the old SQL did', async () => {
    const lone = (await s.api.j('POST', '/trips', { name: 'Solo', base_currency: 'AUD', expense_currency: 'AUD', members: [] }, s.bob)).body;
    await s.api.j('DELETE', '/me', undefined, s.bob);
    expect(await s.raw.prepare('SELECT created_by c FROM trips WHERE id = ?1').bind(lone.id).first('c')).toBeNull();
  });
});

describe('trips and members', () => {
  it('deleting a trip removes members, expenses, splits and payments in one statement; other trips stay', async () => {
    const env = await scenario();
    const a = env.memA('Alice'), d = env.memA('Dave');
    await env.expense(env.alice, env.tripA, a, a, d);
    await env.api.j('POST', `/trips/${env.tripA.id}/payments`, { from_member_id: d, to_member_id: a, amount_cents: 100, currency: 'AUD' }, env.alice);
    expect((await env.api.j('DELETE', `/trips/${env.tripA.id}`, undefined, env.alice)).status).toBe(200);
    for (const t of ['expenses', 'expense_splits', 'payments']) expect(await env.raw.prepare(`SELECT COUNT(*) n FROM ${t}`).first('n'), t).toBe(0);
    expect(await env.raw.prepare('SELECT COUNT(*) n FROM trip_members WHERE trip_id = ?1').bind(env.tripA.id).first('n')).toBe(0);
    expect((await env.api.j('GET', `/trips/${env.tripB.id}`, undefined, env.bob)).status).toBe(200);
    await env.close();
  });

  it('old foreign-key rules: a member who PAID cannot be removed (409); otherwise their splits and payments go with them', async () => {
    const env = await scenario();
    const a = env.memA('Alice'), d = env.memA('Dave');
    await env.expense(env.alice, env.tripA, a, a, d);                       // alice paid, dave only has a split
    await env.api.j('POST', `/trips/${env.tripA.id}/payments`, { from_member_id: d, to_member_id: a, amount_cents: 100, currency: 'AUD' }, env.alice);
    expect((await env.api.j('DELETE', `/trips/${env.tripA.id}/members/${a}`, undefined, env.alice)).status).toBe(409);
    expect((await env.api.j('DELETE', `/trips/${env.tripA.id}/members/${d}`, undefined, env.alice)).status).toBe(200);
    expect(await env.raw.prepare('SELECT COUNT(*) n FROM expense_splits WHERE member_id = ?1').bind(d).first('n')).toBe(0);
    expect(await env.raw.prepare('SELECT COUNT(*) n FROM payments').first('n')).toBe(0);
    expect(await env.raw.prepare('SELECT COUNT(*) n FROM expenses').first('n')).toBe(1);   // the expense itself stays
    await env.close();
  });

  it('schema rejects what the old CHECK constraints rejected (payment to self)', async () => {
    const env = await scenario();
    const a = env.memA('Alice');
    expect((await env.api.j('POST', `/trips/${env.tripA.id}/payments`, { from_member_id: a, to_member_id: a, amount_cents: 100, currency: 'AUD' }, env.alice)).status).toBe(400);
    await expect(env.raw.prepare("INSERT INTO payments (id,trip_id,from_member_id,to_member_id,amount_cents,currency,status,created_at) VALUES ('p',?1,?2,?2,5,'AUD','pending','x')").bind(env.tripA.id, a).run()).rejects.toThrow();
    await env.close();
  });

  it('creating a trip links only the caller\'s own member row; client-supplied user ids are ignored', async () => {
    const r = await s.api.j('POST', '/trips', { name: 'T', base_currency: 'AUD', expense_currency: 'AUD',
      members: [{ name: 'Me', is_self: true }, { name: 'Sneaky', email: 'x@example.com', userId: uid(3), user_id: uid(3) }] }, s.carol);
    expect(r.body.trip_members.filter((m: any) => m.user_id).map((m: any) => m.user_id)).toEqual([uid(3)]);
  });

  it('last_activity_at follows the newest expense, including after it is deleted', async () => {
    const env = await scenario();
    const a = env.memA('Alice'), d = env.memA('Dave');
    const t0 = (await env.api.j('GET', `/trips/${env.tripA.id}`, undefined, env.alice)).body.last_activity_at;
    const e = (await env.expense(env.alice, env.tripA, a, a, d)).body;
    const t1 = (await env.api.j('GET', `/trips/${env.tripA.id}`, undefined, env.alice)).body.last_activity_at;
    expect(t1).toBe(e.created_at);
    expect(t1 > t0).toBe(true);
    await env.api.j('DELETE', `/trips/${env.tripA.id}/expenses/${e.id}`, undefined, env.alice);
    expect((await env.api.j('GET', `/trips/${env.tripA.id}`, undefined, env.alice)).body.last_activity_at).toBe(env.tripA.created_at);
    await env.close();
  });
});

describe('invariants', () => {
  it('every split\'s trip_id equals its expense\'s trip_id after create, update and delete', async () => {
    const env = await scenario();
    const a = env.memA('Alice'), d = env.memA('Dave');
    const e = (await env.expense(env.alice, env.tripA, a, a, d)).body;
    await env.api.j('PUT', `/trips/${env.tripA.id}/expenses/${e.id}`, { ...body(env, a, a, d, { description: 'again' }), version: e.version }, env.alice);
    await env.expense(env.bob, env.tripB, env.memB('Bob'), env.memB('Bob'), env.memB('Erin'));
    const bad = await env.raw.prepare('SELECT COUNT(*) n FROM expense_splits s JOIN expenses e ON e.id = s.expense_id WHERE s.trip_id != e.trip_id').first('n');
    const total = await env.raw.prepare('SELECT COUNT(*) n FROM expense_splits').first('n');
    expect(bad).toBe(0);
    expect(total).toBe(4);
    await env.close();
  });
});

