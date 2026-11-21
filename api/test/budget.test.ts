// SplitTrip usage budget (decisions-and-rules.md): query plans, rows read/written per route, 10x scale.
// Made-up data only. Results are written to docs/usage-table.md for the README.
import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { bindStats, makeApi, makeEnv, makeIdp, seenSql, signIn, uid } from './helpers';
import type { Env } from '../src/types';

const EXPENSES_PER_TRIP = 200, MEMBERS = 5;

async function seed(raw: D1Database, trips: number) {
  let seq = 10_000; const id = () => uid(seq++);
  let rnd = 12345; const rand = (n: number) => { rnd = (rnd * 1103515245 + 12345) & 0x7fffffff; return rnd % n; };
  const stmts: D1PreparedStatement[] = [];
  const flush = async () => { while (stmts.length) await raw.batch(stmts.splice(0, 80)); };
  for (let u = 1; u <= 6; u++) stmts.push(raw.prepare('INSERT INTO users VALUES (?1,?2,?3,?4)').bind(uid(u), `user${u}@example.com`, `User ${u}`, '2026-01-01T00:00:00.000000Z'));
  const tripIds: string[] = [];
  const memberIds: string[][] = [];
  for (let t = 0; t < trips; t++) {
    const tid = uid(5000 + t); tripIds.push(tid);
    const created = `2026-02-${String(1 + (t % 27)).padStart(2, '0')}T00:00:00.000000Z`;
    stmts.push(raw.prepare('INSERT INTO trips VALUES (?1,?2,?3,?4,?5,?6,?7,?8,1)').bind(tid, `Trip ${t}`, null, 'AUD', 'AUD', uid(1), created, created));
    const ms: string[] = [];
    for (let m = 0; m < MEMBERS; m++) {
      const mid = id(); ms.push(mid);
      // user 1 (the "heavy" user) is in every trip; users 2-5 in some; the rest are unlinked invitees
      const user = m === 0 ? uid(1) : m <= 4 && (t + m) % 4 === 0 ? uid(1 + m) : null;
      stmts.push(raw.prepare('INSERT INTO trip_members VALUES (?1,?2,?3,?4,?5,?6)').bind(mid, tid, user, `M${m}`, user ? null : `invitee${t}_${m}@example.com`, created));
    }
    memberIds.push(ms);
    for (let e = 0; e < EXPENSES_PER_TRIP; e++) {
      const eid = id(); const k = 2 + rand(3); const amount = 1000 + rand(50000);
      const people = ms.slice(0, k); const base = Math.floor(amount / k);
      stmts.push(raw.prepare('INSERT INTO expenses VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,1,NULL)')
        .bind(eid, tid, ms[rand(MEMBERS)], amount, 'AUD', `2026-03-${String(1 + (e % 28)).padStart(2, '0')}`, `Expense ${e}`, uid(1), `2026-03-${String(1 + (e % 28)).padStart(2, '0')}T${String(e % 24).padStart(2, '0')}:00:00.${String(100000 + e)}Z`, 'equal'));
      people.forEach((p, i) => stmts.push(raw.prepare('INSERT INTO expense_splits VALUES (?1,?2,?3,?4,?5)').bind(id(), eid, tid, p, i === 0 ? amount - base * (k - 1) : base)));
      if (stmts.length > 400) await flush();
    }
    for (let p = 0; p < 10; p++) stmts.push(raw.prepare('INSERT INTO payments VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,1)')
      .bind(id(), tid, ms[1], ms[0], 500 + p, 'AUD', p < 8 ? 'confirmed' : 'pending', uid(1), p < 8 ? uid(1) : null, created, p < 8 ? created : null));
  }
  await flush();
  return { tripIds, memberIds };
}

interface Row { route: string; queries: number; read: number; written: number; note?: string }
const table: Row[] = [];
const results: Record<string, Row> = {};

async function world(trips: number, idp: Awaited<ReturnType<typeof makeIdp>>) {
  const ctx = await makeEnv();
  const t0 = Date.now();
  const data = await seed(ctx.raw, trips);
  console.log(`seeded ${trips} trips in ${Date.now() - t0} ms`);
  const api = makeApi(ctx.env, idp.deps);
  const heavy = await signIn(api, idp, 'user1@example.com');
  const measure = async (label: string, fn: () => Promise<{ status: number }>, expect2xx = true, note?: string) => {
    ctx.counter.reset();
    const r = await fn();
    if (expect2xx) expect(r.status, label).toBeLessThan(300);
    const row: Row = { route: label, queries: ctx.counter.stats.queries, read: ctx.counter.stats.rowsRead, written: ctx.counter.stats.rowsWritten, note };
    results[`${trips}:${label}`] = row;
    return row;
  };
  return { ...ctx, ...data, idp, api, heavy, measure };
}

afterAll(() => {
  mkdirSync('docs', { recursive: true });
  const rows = table.map(r => `| ${r.route} | ${r.queries} | ${r.read} | ${r.written} | ${r.note ?? ''} |`);
  writeFileSync('docs/usage-table.md',
`| Route (10x dataset: 20 trips x 200 expenses, ~18,000 rows) | Queries | Rows read | Rows written | Note |
|---|---|---|---|---|
${rows.join('\n')}
`);
});

describe('usage budget, local D1 on made-up data', () => {
  let big: Awaited<ReturnType<typeof world>>;
  let small: Awaited<ReturnType<typeof world>>;

  it('measures every route at 10x scale and at one-trip scale', async () => {
    const idp = await makeIdp();
    big = await world(20, idp);
    small = await world(1, idp);
    const T = big.tripIds[0];                         // the same trip content exists in both databases
    const m = big.memberIds[0];
    const run = async (w: typeof big, rec: boolean) => {
      const out: Record<string, Row> = {};
      const t = w.tripIds[0], mm = w.memberIds[0];
      const add = async (label: string, fn: () => Promise<{ status: number }>, note?: string) => { out[label] = await w.measure(label, fn, true, note); if (rec) table.push(out[label]); };
      await add('POST /auth/google (sign-in)', async () => w.api.j('POST', '/auth/google', { idToken: await w.idp.google('user1@example.com') }));
      await add('GET /me', () => w.api.j('GET', '/me', undefined, w.heavy));
      await add('GET /trips (user in all 20 trips)', () => w.api.j('GET', '/trips', undefined, w.heavy), 'worst case: 20 trips, 100 members');
      await add('GET /trips/:id', () => w.api.j('GET', `/trips/${t}`, undefined, w.heavy));
      await add('GET /trips/:id/members', () => w.api.j('GET', `/trips/${t}/members`, undefined, w.heavy));
      await add('GET /trips/:id/expenses (200 expenses + splits)', () => w.api.j('GET', `/trips/${t}/expenses`, undefined, w.heavy), 'whole trip, as the app needs for balances');
      await add('GET /trips/:id/payments (10)', () => w.api.j('GET', `/trips/${t}/payments`, undefined, w.heavy));
      await add('GET /trips/:id/all (members + 200 expenses + payments)', () => w.api.j('GET', `/trips/${t}/all`, undefined, w.heavy), 'the page uses this: one request instead of three');
      let created: any;
      await add('POST /trips/:id/expenses (3 splits)', async () => {
        created = await w.api.j('POST', `/trips/${t}/expenses`, { paid_by_member_id: mm[0], amount_cents: 3000, currency: 'AUD', date: '2026-04-01', description: 'New', split_type: 'equal',
          splits: [0, 1, 2].map(i => ({ member_id: mm[i], amount_cents: 1000 })) }, w.heavy); return created; });
      await add('PUT /trips/:id/expenses/:eid (3 splits)', () => w.api.j('PUT', `/trips/${t}/expenses/${created.body.id}`, { version: 1, paid_by_member_id: mm[0], amount_cents: 3000, currency: 'AUD', date: '2026-04-01', description: 'Edit', split_type: 'equal',
          splits: [0, 1, 2].map(i => ({ member_id: mm[i], amount_cents: 1000 })) }, w.heavy));
      await add('DELETE /trips/:id/expenses/:eid', () => w.api.j('DELETE', `/trips/${t}/expenses/${created.body.id}`, undefined, w.heavy));
      let pay: any;
      await add('POST /trips/:id/payments', async () => { pay = await w.api.j('POST', `/trips/${t}/payments`, { from_member_id: mm[2], to_member_id: mm[0], amount_cents: 900, currency: 'AUD' }, w.heavy); return pay; });
      await add('POST /trips/:id/payments/:pid/confirm', () => w.api.j('POST', `/trips/${t}/payments/${pay.body.id}/confirm`, undefined, w.heavy));
      let pay2: any; pay2 = await w.api.j('POST', `/trips/${t}/payments`, { from_member_id: mm[2], to_member_id: mm[0], amount_cents: 901, currency: 'AUD' }, w.heavy);
      await add('DELETE /trips/:id/payments/:pid (pending)', () => w.api.j('DELETE', `/trips/${t}/payments/${pay2.body.id}`, undefined, w.heavy));
      let mem: any;
      await add('POST /trips/:id/members', async () => { mem = await w.api.j('POST', `/trips/${t}/members`, { name: 'Zed', email: 'zed@example.com' }, w.heavy); return mem; });
      await add('DELETE /trips/:id/members/:mid (unused member)', () => w.api.j('DELETE', `/trips/${t}/members/${mem.body.id}`, undefined, w.heavy));
      await add('PATCH /trips/:id', () => w.api.j('PATCH', `/trips/${t}`, { version: 1, name: 'Renamed', base_currency: 'AUD', expense_currency: 'AUD' }, w.heavy));
      await add('PATCH /me (rename)', () => w.api.j('PATCH', '/me', { name: 'Heavy User' }, w.heavy), 'also renames the user\'s member rows');
      await add('POST /me/claim', () => w.api.j('POST', '/me/claim', undefined, w.heavy));
      await add('DELETE /trips/:id (200 expenses, cascade)', () => w.api.j('DELETE', `/trips/${t}`, undefined, w.heavy), 'rare; one-off cost of removing a whole trip');
      await add('DELETE /me (user in 20 trips)', () => w.api.j('DELETE', '/me', undefined, w.heavy), 'rare; promotes a new creator on each owned trip');
      return out;
    };
    // The small world first without recording; then the big one, recorded.
    const s1 = await run(small, false);
    const b1 = await run(big, true);
    void T; void m;

    const SCOPED = ['GET /trips/:id', 'GET /trips/:id/members', 'GET /trips/:id/expenses (200 expenses + splits)', 'GET /trips/:id/payments (10)', 'GET /trips/:id/all (members + 200 expenses + payments)',
      'POST /trips/:id/expenses (3 splits)', 'PUT /trips/:id/expenses/:eid (3 splits)', 'DELETE /trips/:id/expenses/:eid', 'POST /trips/:id/payments',
      'POST /trips/:id/payments/:pid/confirm', 'DELETE /trips/:id/payments/:pid (pending)', 'POST /trips/:id/members', 'PATCH /trips/:id'];
    for (const k of SCOPED) {
      // reads must grow with the size of the one trip, not with the whole database (19 more trips = ~17,000 more rows)
      expect(b1[k].read, `${k}: 10x database reads vs 1-trip database`).toBeLessThanOrEqual(s1[k].read + 5);
      expect(b1[k].queries, k).toBeLessThanOrEqual(50);
    }
    for (const r of Object.values(b1)) expect(r.queries, r.route).toBeLessThanOrEqual(50);
    for (const r of table) console.log(`${r.route.padEnd(58)} q=${String(r.queries).padStart(2)} read=${String(r.read).padStart(5)} written=${String(r.written).padStart(5)}`);
  }, 240_000);

  it('EXPLAIN QUERY PLAN: no SCAN on the big tables for any query the routes ran', async () => {
    const plans: string[] = [];
    const failures: string[] = [];
    for (const [sql, binds] of seenSql) {
      let res;
      try { res = await big.raw.prepare('EXPLAIN QUERY PLAN ' + sql).bind(...binds).all<{ detail: string }>(); }
      catch (e) { failures.push(`could not explain: ${sql.slice(0, 80)} (${e})`); continue; }
      for (const r of res.results) {
        plans.push(`${r.detail}   <=   ${sql.replace(/\s+/g, ' ').slice(0, 70)}`);
        if (/\bSCAN (expenses|expense_splits|trip_members|payments)\b/.test(r.detail)) failures.push(`${r.detail}  <=  ${sql.replace(/\s+/g, ' ').slice(0, 90)}`);
      }
    }
    mkdirSync('docs', { recursive: true });
    writeFileSync('docs/query-plans.txt', [...new Set(plans)].join('\n') + '\n');
    console.log(`explained ${seenSql.size} distinct queries`);
    expect(failures).toEqual([]);
    expect(seenSql.size).toBeGreaterThan(30);
    expect(bindStats.max, 'most parameters bound by any single query (D1 limit is 100)').toBeLessThanOrEqual(100);
    await big.close(); await small.close();
  }, 60_000);
});
