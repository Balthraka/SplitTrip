// A made-up trip with 500 expenses (splits, payments, mixed currencies and split types) driven through the real routes.
// The expected balances come from a separate integer-cents ledger kept by the test, not from the code under test.
import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { computeBalances, frozenRates } from '../src/balances';
import { bindStats, scenario, seenSql } from './helpers';

const N = 500;
let rnd = 987654321;
const rand = (n: number) => { rnd = (rnd * 1103515245 + 12345) & 0x7fffffff; return rnd % n; };
const rows: string[] = [];

afterAll(() => {
  mkdirSync('docs', { recursive: true });
  writeFileSync('docs/usage-table-500.md',
`| Route (one trip with ${N}+ expenses, ~1,500 splits, 5 members) | Queries | Rows read | Rows written |
|---|---|---|---|
${rows.join('\n')}
`);
});

describe(`a ${N}-expense trip through every route`, () => {
  it('loads, edits, deletes and settles correctly, within 50 queries and 100 bound parameters per call', async () => {
    const s = await scenario();
    const t = s.tripA.id;
    const ids: string[] = [s.memA('Alice'), s.memA('Dave')];
    for (const name of ['Erin', 'Frank', 'Gus']) ids.push((await s.api.j('POST', `/trips/${t}/members`, { name }, s.alice)).body.id);

    interface L { id: string; version: number; paid: string; amount: number; cur: string; date: string; splits: Record<string, number> }
    const ledger = new Map<string, L>();
    const RATE: Record<string, number> = { AUD: 1, USD: 2 };               // USD x2 keeps the independent maths exact in integers
    const date = (i: number) => `2026-03-${String(1 + (i % 28)).padStart(2, '0')}`;

    const make = (i: number) => {
      const cur = i % 7 === 0 ? 'USD' : 'AUD';
      const k = 1 + rand(5), who = ids.slice(0, k), amount = 100 + rand(90000);
      const type = k === 1 ? 'single' : ['equal', 'exact', 'percent'][rand(3)];
      const base = Math.floor(amount / k), splits: Record<string, number> = {};
      who.forEach((m, j) => { splits[m] = j === 0 ? amount - base * (k - 1) : base; });
      return { cur, amount, type, splits, paid: ids[rand(5)], date: date(i) };
    };
    const payload = (x: ReturnType<typeof make>, version?: number) => ({ paid_by_member_id: x.paid, amount_cents: x.amount, currency: x.cur, date: x.date, description: 'Made-up expense', split_type: x.type,
      splits: Object.entries(x.splits).map(([member_id, amount_cents]) => ({ member_id, amount_cents })), ...(version ? { version } : {}) });

    s.counter.reset();
    let maxQueries = 0;
    const call = async (label: string | null, method: string, path: string, body?: unknown, token = s.alice) => {
      s.counter.reset();
      const r = await s.api.j(method, path, body, token);
      maxQueries = Math.max(maxQueries, s.counter.stats.queries);
      expect(s.counter.stats.queries, `${method} ${path}`).toBeLessThanOrEqual(50);
      if (label) rows.push(`| ${label} | ${s.counter.stats.queries} | ${s.counter.stats.rowsRead} | ${s.counter.stats.rowsWritten} |`);
      return r;
    };

    // 1. create 500 through POST; the first and the last are recorded for the table (the last runs against the fullest trip)
    for (let i = 0; i < N; i++) {
      const x = make(i);
      const r = await call(i === N - 1 ? `POST expense (trip already holds ${N - 1})` : null, 'POST', `/trips/${t}/expenses`, payload(x));
      expect(r.status).toBe(201);
      ledger.set(r.body.id, { id: r.body.id, version: 1, paid: x.paid, amount: x.amount, cur: x.cur, date: x.date, splits: x.splits });
    }

    // 2. load everything: every expense and every split comes back, and equals the ledger
    const list = await call(`GET expenses (${N} expenses)`, 'GET', `/trips/${t}/expenses`);
    expect(list.body.length).toBe(N);
    for (const e of list.body) {
      const l = ledger.get(e.id)!;
      expect(e.amount_cents).toBe(l.amount);
      expect(Object.fromEntries(e.expense_splits.map((x: any) => [x.member_id, x.amount_cents]))).toEqual(l.splits);
    }

    // 3. edit 25 and delete 25 through PUT/DELETE
    const all = [...ledger.values()];
    for (let i = 0; i < 25; i++) {
      const l = all[i * 7];
      const x = make(1000 + i); x.cur = l.cur; x.date = l.date;
      const r = await call(i === 0 ? 'PUT expense (trip holds 500)' : null, 'PUT', `/trips/${t}/expenses/${l.id}`, payload(x, l.version));
      expect(r.status).toBe(200);
      Object.assign(l, { version: l.version + 1, paid: x.paid, amount: x.amount, splits: x.splits });
    }
    for (let i = 0; i < 25; i++) {
      const l = all[3 + i * 11];
      const r = await call(i === 0 ? 'DELETE expense (trip holds 500)' : null, 'DELETE', `/trips/${t}/expenses/${l.id}`);
      expect(r.status).toBe(200);
      ledger.delete(l.id);
    }

    // 4. payments: create 5, confirm 3, cancel 1 pending
    const pays: { id: string; from: string; to: string; amount: number; cur: string; confirmed: boolean }[] = [];
    for (let i = 0; i < 5; i++) {
      const from = ids[i], to = ids[(i + 1) % 5], amount = 1000 + i * 137, cur = i === 2 ? 'USD' : 'AUD';
      const r = await call(i === 0 ? 'POST payment' : null, 'POST', `/trips/${t}/payments`, { from_member_id: from, to_member_id: to, amount_cents: amount, currency: cur });
      expect(r.status).toBe(201);
      pays.push({ id: r.body.id, from, to, amount, cur, confirmed: false });
    }
    for (let i = 0; i < 3; i++) { expect((await call(i === 0 ? 'POST payment confirm' : null, 'POST', `/trips/${t}/payments/${pays[i].id}/confirm`)).status).toBe(200); pays[i].confirmed = true; }
    expect((await call('DELETE payment (pending)', 'DELETE', `/trips/${t}/payments/${pays[4].id}`)).status).toBe(200);
    pays.pop();

    // 5. reload from the API and settle: balances must equal an independent integer-cents ledger, to the cent
    const list2 = (await call(`GET expenses (${ledger.size} expenses, after edits)`, 'GET', `/trips/${t}/expenses`)).body;
    const payList = (await call('GET payments', 'GET', `/trips/${t}/payments`)).body;
    expect(list2.length).toBe(ledger.size);
    expect(payList.length).toBe(4);
    const trips = (await call('GET /trips', 'GET', '/trips')).body;
    expect(trips.length).toBe(1);

    const expected: Record<string, number> = Object.fromEntries(ids.map(m => [m, 0]));
    for (const l of ledger.values()) {
      expected[l.paid] += l.amount * RATE[l.cur];
      for (const [m, a] of Object.entries(l.splits)) expected[m] -= a * RATE[l.cur];
    }
    for (const p of pays.filter(p => p.confirmed)) { expected[p.from] += p.amount * RATE[p.cur]; expected[p.to] -= p.amount * RATE[p.cur]; }

    const table: Record<string, Record<string, number>> = {};
    for (let d = 1; d <= 28; d++) table[`usd@2026-03-${String(d).padStart(2, '0')}`] = { aud: 2 };
    table['usd@latest'] = { aud: 2 };                         // payments confirmed today use the app's 'latest' rate
    const got = computeBalances(
      list2.map((e: any) => ({ currency: e.currency, date: e.date, paid_by_member_id: e.paid_by_member_id, amount: e.amount_cents / 100,
        splits: e.expense_splits.map((x: any) => ({ member_id: x.member_id, amount: x.amount_cents / 100 })) })),
      ids, 'AUD',
      payList.filter((p: any) => p.status === 'confirmed').map((p: any) => ({ currency: p.currency, from_member_id: p.from_member_id, to_member_id: p.to_member_id, amount: p.amount_cents / 100, confirmed_at: p.confirmed_at })),
      frozenRates(table));
    for (const m of ids) expect(Math.round(got.balances[m] * 100), `balance of ${m}`).toBe(expected[m]);
    expect(Object.values(expected).reduce((a, b) => a + b, 0)).toBe(0);                     // a real ledger sums to zero
    expect(Object.values(expected).some(v => Math.abs(v) > 10000)).toBe(true);              // and is not trivially all zero

    // 6. last activity and the home screen did not need every expense row
    expect(trips[0].last_activity_at >= trips[0].created_at).toBe(true);

    // 7. no query bound more than 100 parameters, and none scans a big table
    expect(bindStats.max).toBeLessThanOrEqual(100);
    for (const [sql, binds] of seenSql) {
      const plan = await s.raw.prepare('EXPLAIN QUERY PLAN ' + sql).bind(...binds).all<{ detail: string }>();
      for (const r of plan.results) expect(r.detail, sql.replace(/\s+/g, ' ').slice(0, 80)).not.toMatch(/\bSCAN (expenses|expense_splits|trip_members|payments)\b/);
    }

    // 8. deleting the whole trip, once, at this size
    const del = await call(`DELETE trip (${ledger.size} expenses)`, 'DELETE', `/trips/${t}`);
    expect(del.status).toBe(200);
    expect(await s.raw.prepare('SELECT COUNT(*) n FROM expenses WHERE trip_id = ?1').bind(t).first('n')).toBe(0);
    expect(await s.raw.prepare('SELECT COUNT(*) n FROM expense_splits WHERE trip_id = ?1').bind(t).first('n')).toBe(0);
    console.log('max queries in any call:', maxQueries);
    await s.close();
  }, 600_000);
});
