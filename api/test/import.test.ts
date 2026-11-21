import { describe, expect, it } from 'vitest';
import { buildImport } from '../scripts/importer';
import { parseCsv } from '../scripts/csv';
import { balancesFromD1, balancesFromSupabase, compareBalances } from '../scripts/compare';
import { FAKE_RATES, fakeExport } from './fakeExport';
import { makeApi, makeEnv, makeIdp, signIn, uid } from './helpers';

const TABLES = ['users', 'trips', 'trip_members', 'expenses', 'expense_splits', 'payments'] as const;
const dump = async (raw: D1Database) => {
  const out: Record<string, unknown[]> = {};
  for (const t of TABLES) out[t] = (await raw.prepare(`SELECT * FROM ${t} ORDER BY id`).all()).results;
  return out;
};
const runSql = async (raw: D1Database, sql: string[]) => {
  const res = await raw.batch(sql.map(s => raw.prepare(s)));
  return res.reduce((a, r) => a + (r.meta.rows_written ?? 0), 0);
};
const TODAY = '2026-11-20';

describe('CSV reader', () => {
  it('handles quotes, commas and newlines inside fields', () => {
    const rows = parseCsv('a,b\n"x, ""y""\nz",2\n3,4\n');
    expect(rows).toEqual([{ a: 'x, "y"\nz', b: '2' }, { a: '3', b: '4' }]);
  });
});

describe('importer', () => {
  it('row counts match the export and the data survives quoting, newlines and apostrophes', async () => {
    const inp = fakeExport();
    const { sql, report } = buildImport(inp);
    const { raw, close } = await makeEnv();
    await runSql(raw, sql);
    const counts = Object.fromEntries(await Promise.all(TABLES.map(async t => [t, await raw.prepare(`SELECT COUNT(*) n FROM ${t}`).first('n')])));
    expect(counts).toEqual({ users: inp.authUsers.length, trips: inp.trips.length, trip_members: inp.trip_members.length, expenses: inp.expenses.length, expense_splits: inp.expense_splits.length, payments: inp.payments.length });
    expect(report.rows).toEqual(counts);
    expect(await raw.prepare('SELECT COUNT(*) n FROM expense_splits s JOIN expenses e ON e.id = s.expense_id WHERE s.trip_id != e.trip_id').first('n')).toBe(0);
    expect(await raw.prepare('SELECT name FROM trips WHERE id = ?1').bind(uid(201)).first('name')).toBe('Fake Trip, "Quoted"\nSecond line');
    expect(await raw.prepare("SELECT description FROM expenses WHERE description LIKE 'Dinner%'").first('description')).toBe("Dinner, with \"quotes\" and an apostrophe's");
    expect(await raw.prepare('SELECT email FROM users WHERE id = ?1').bind(uid(102)).first('email')).toBe('ben.test@example.com'); // lowercased
    expect(await raw.prepare('SELECT amount_cents c FROM expenses WHERE description = ?1').bind('Massage').first('c')).toBe(118800000);
    expect(await raw.prepare('SELECT amount_cents c FROM expenses WHERE description = ?1').bind('Snacks').first('c')).toBe(1999);
    await close();
  });

  it('is rerunnable: a second run changes nothing, and keeps ids, versions and sessions', async () => {
    const inp = fakeExport();
    const { sql } = buildImport(inp);
    const { raw, close } = await makeEnv();
    await runSql(raw, sql);
    // a real edit and a real sign-in happen between runs
    await raw.prepare("UPDATE expenses SET version = 5 WHERE description = 'Pizza'").run();
    await raw.prepare("INSERT INTO identities VALUES ('google','sub-ann',?1,'x')").bind(uid(101)).run();
    const first = await dump(raw);
    await runSql(raw, sql);
    const second = await dump(raw);
    const strip = (d: any) => JSON.stringify(d);
    expect(strip(second)).toBe(strip(first));
    expect(await raw.prepare('SELECT COUNT(*) n FROM identities').first('n')).toBe(1);
    expect(await raw.prepare("SELECT version v FROM expenses WHERE description = 'Pizza'").first('v')).toBe(5);
    await close();
  });

  it('--email links a user by hand to a new address, and refuses a clash or an unknown id', async () => {
    const inp = fakeExport();
    const { sql } = buildImport(inp, { emailOverrides: { [uid(101)]: 'ann.new@example.com' } });
    const { raw, close } = await makeEnv();
    await runSql(raw, sql);
    expect(await raw.prepare('SELECT email e FROM users WHERE id = ?1').bind(uid(101)).first('e')).toBe('ann.new@example.com');
    expect(() => buildImport(inp, { emailOverrides: { [uid(101)]: 'cat@example.com' } })).toThrow(/share the email/);
    expect(() => buildImport(inp, { emailOverrides: { [uid(999)]: 'x@example.com' } })).toThrow(/unknown user/);
    await close();
  });

  it('--drop leaves out an unused account, and refuses one that trips, members or payments still point at', () => {
    const inp = fakeExport();
    const spare = { id: uid(150), email: 'spare@example.com', created_at: '2026-05-04 10:00:00+00' };
    inp.authUsers.push(spare); inp.profiles.push({ id: spare.id, name: 'spare', email: spare.email, created_at: spare.created_at });
    const withSpare = buildImport(inp, {});
    const dropped = buildImport(inp, { dropUsers: [uid(150)] });
    expect(withSpare.report.rows.users).toBe(dropped.report.rows.users + 1);
    expect(dropped.sql.join('\n')).not.toContain('spare@example.com');
    expect(dropped.report.warnings).toEqual([]);
    expect(() => buildImport(inp, { dropUsers: [uid(103)] })).toThrow(/unknown user/);      // Cat is a member
    expect(() => buildImport(inp, { dropUsers: [uid(999)] })).toThrow(/unknown user/);
  });

  it('a capped export is reported, not hidden: orphan splits are skipped with a warning', () => {
    const inp = fakeExport();
    inp.expenses = inp.expenses.slice(0, 3);            // simulate a 100-row cap on expenses only
    const { report } = buildImport(inp);
    expect(report.skipped.orphanSplits).toBeGreaterThan(0);
    expect(report.warnings.join(' ')).toMatch(/capped/);
  });

  it('rejects data that would corrupt balances: payer or split member from another trip, more than 2 decimals', () => {
    const a = fakeExport(); a.expenses[0].paid_by_member_id = uid(305);
    expect(() => buildImport(a)).toThrow(/payer/);
    const b = fakeExport(); b.expense_splits[0].member_id = uid(305);
    expect(() => buildImport(b)).toThrow(/split/);
    const c = fakeExport(); c.expenses[0].amount = '10.005';
    expect(() => buildImport(c)).toThrow(/2dp/);
  });

  it('the estimate of rows written is at least what D1 actually reports', async () => {
    const { sql, report } = buildImport(fakeExport());
    const { raw, close } = await makeEnv();
    const written = await runSql(raw, sql);
    console.log(`import estimate ${report.estimatedRowsWritten} vs measured rows_written ${written}`);
    expect(report.estimatedRowsWritten).toBeGreaterThanOrEqual(written);
    await close();
  });
});

describe('balances: original export vs D1 after import, to the cent', () => {
  it('every trip and member matches, via the real API routes (cents / 100) and a frozen rate table', async () => {
    const inp = fakeExport();
    const { raw, env, close } = await makeEnv();
    await runSql(raw, buildImport(inp).sql);
    const idp = await makeIdp(); const api = makeApi(env, idp.deps);
    const token = await signIn(api, idp, 'ann@example.com'); // ann is a member of both trips
    const d1 = { trips: [] as any[], trip_members: [] as any[], expenses: [] as any[], expense_splits: [] as any[], payments: [] as any[] };
    for (const t of (await api.j('GET', '/trips', undefined, token)).body) {
      d1.trips.push(t);
      d1.trip_members.push(...(await api.j('GET', `/trips/${t.id}/members`, undefined, token)).body);
      for (const e of (await api.j('GET', `/trips/${t.id}/expenses`, undefined, token)).body) {
        d1.expenses.push(e);
        d1.expense_splits.push(...e.expense_splits.map((s: any) => ({ ...s, expense_id: e.id })));
      }
      d1.payments.push(...(await api.j('GET', `/trips/${t.id}/payments`, undefined, token)).body);
    }
    const orig = balancesFromSupabase(inp, FAKE_RATES, TODAY);
    const mine = balancesFromD1(d1, FAKE_RATES, TODAY);
    expect(compareBalances(orig, mine)).toEqual([]);
    // sanity: the comparison is not vacuous. Trip 1 has non-zero balances, mixed currencies and a foreign-currency payment.
    const t1 = orig[uid(201)];
    expect(Object.values(t1.balances).some(v => v !== 0)).toBe(true);
    expect(Math.round(Object.values(t1.balances).reduce((a, b) => a + b, 0) * 100)).toBeLessThanOrEqual(2); // balances sum to ~0
    // and a one-cent change in D1 is caught
    await raw.prepare("UPDATE expense_splits SET amount_cents = amount_cents + 1 WHERE id = (SELECT id FROM expense_splits WHERE amount_cents = 3334 LIMIT 1)").run();
    const split = d1.expense_splits.find((s: any) => s.amount_cents === 3334); split.amount_cents += 1;
    const diffs = compareBalances(orig, balancesFromD1(d1, FAKE_RATES, TODAY));
    expect(diffs.length).toBeGreaterThan(0);
    await close();
  });
});

describe('importing a second time (the final import before cutover)', () => {
  const changedSource = () => {
    const b = fakeExport();
    const gone = b.expenses.pop()!;                                              // deleted in the source
    b.expense_splits = b.expense_splits.filter((s: any) => s.expense_id !== gone.id);
    const edited = b.expenses[0];                                                // edited in the source: Supabase gives its splits new ids
    b.expense_splits.filter((s: any) => s.expense_id === edited.id).forEach((s: any, i: number) => { s.id = '99999999-0000-4000-8000-00000000000' + i; });
    return { b, gone, edited };
  };
  const n = async (raw: D1Database, t: string) => raw.prepare(`SELECT COUNT(*) n FROM ${t}`).first('n');

  it('without --replace a second import keeps deleted rows and doubles an edited expense\'s splits (why the option exists)', async () => {
    const { raw, close } = await makeEnv();
    await runSql(raw, buildImport(fakeExport()).sql);
    const { b, gone, edited } = changedSource();
    await runSql(raw, buildImport(b).sql);
    expect(await n(raw, 'expenses')).toBe(b.expenses.length + 1);                // the deleted one is still there
    expect(await raw.prepare('SELECT COUNT(*) c FROM expenses WHERE id = ?1').bind(gone.id).first('c')).toBe(1);
    const inSource = b.expense_splits.filter((s: any) => s.expense_id === edited.id).length;
    expect(await raw.prepare('SELECT COUNT(*) c FROM expense_splits WHERE expense_id = ?1').bind(edited.id).first('c')).toBe(inSource * 2);
    await close();
  });

  it('with --replace D1 matches the new export exactly, users and sessions are untouched, and the balances match', async () => {
    const { raw, close } = await makeEnv();
    await runSql(raw, buildImport(fakeExport()).sql);
    await raw.prepare("INSERT INTO identities (provider, subject, user_id, created_at) VALUES ('google','g-sub-1',?1,'2026-01-01T00:00:00.000000Z')").bind(uid(101)).run();
    await raw.prepare("INSERT INTO sessions (token_hash, user_id, verified_email, created_at, expires_at) VALUES ('h1',?1,1,'2026-01-01T00:00:00.000000Z','2099-01-01T00:00:00.000000Z')").bind(uid(101)).run();
    // a row created in D1 only (beta use): must be discarded, because the source of truth is the export
    await raw.prepare("INSERT INTO trips (id, name, base_currency, expense_currency, created_by, created_at, last_activity_at, version) VALUES ('beta-trip','Beta','AUD','AUD',?1,'2026-01-01T00:00:00.000000Z','2026-01-01T00:00:00.000000Z',1)").bind(uid(101)).run();
    const { b } = changedSource();
    const { sql, report } = buildImport(b, { replace: true });
    expect(sql[0]).toBe('DELETE FROM trips;');
    expect(report.warnings.some(w => w.includes('--replace'))).toBe(true);
    await runSql(raw, sql);
    const counts = Object.fromEntries(await Promise.all(TABLES.map(async t => [t, await n(raw, t)])));
    expect(counts).toEqual({ users: b.authUsers.length, trips: b.trips.length, trip_members: b.trip_members.length, expenses: b.expenses.length, expense_splits: b.expense_splits.length, payments: b.payments.length });
    expect(await raw.prepare("SELECT COUNT(*) c FROM trips WHERE id = 'beta-trip'").first('c')).toBe(0);
    expect(await n(raw, 'identities')).toBe(1);
    expect(await n(raw, 'sessions')).toBe(1);
    expect(await raw.prepare('SELECT COUNT(*) c FROM expense_splits s JOIN expenses e ON e.id = s.expense_id WHERE s.trip_id != e.trip_id').first('c')).toBe(0);
    // no orphans anywhere
    expect(await raw.prepare('SELECT COUNT(*) c FROM expense_splits WHERE expense_id NOT IN (SELECT id FROM expenses)').first('c')).toBe(0);
    // balances from D1 equal balances from the new export, to the cent
    const dump = async () => Object.fromEntries(await Promise.all(TABLES.map(async t => [t, (await raw.prepare(`SELECT * FROM ${t}`).all()).results])));
    const diffs = compareBalances(balancesFromSupabase(b, FAKE_RATES, TODAY), balancesFromD1(await dump() as any, FAKE_RATES, TODAY));
    expect(diffs).toEqual([]);
    // running the same replace import again changes nothing (rerunnable)
    await runSql(raw, buildImport(b, { replace: true }).sql);
    expect(Object.fromEntries(await Promise.all(TABLES.map(async t => [t, await n(raw, t)])))).toEqual(counts);
    await close();
  });
});

describe('a trip member with no login (like a person who was added to a trip by name only)', () => {
  it('stays a member with no user, through a first import and a --replace import, and the balances still match', async () => {
    const { raw, close } = await makeEnv();
    const b = fakeExport();
    const lee = b.trip_members.find((m: any) => m.name === 'Lee (no account)')!;
    expect(lee.user_id).toBe('');                                                // the made-up export has one member without a login
    const usersInExport = b.authUsers.length;
    const check = async () => {
      const row = await raw.prepare('SELECT user_id, email, name FROM trip_members WHERE id = ?1').bind(lee.id).first<any>();
      expect(row).toBeTruthy(); expect(row.user_id).toBeNull(); expect(row.name).toBe('Lee (no account)');
      expect(await raw.prepare('SELECT COUNT(*) c FROM users').first('c')).toBe(usersInExport);   // no user was invented for him
      expect(await raw.prepare('SELECT COUNT(*) c FROM identities').first('c')).toBe(0);
      expect(await raw.prepare('SELECT COUNT(*) c FROM expense_splits WHERE member_id = ?1').bind(lee.id).first('c')).toBeGreaterThan(0);   // he still owes / is owed
      const all = Object.fromEntries(await Promise.all(TABLES.map(async t => [t, (await raw.prepare(`SELECT * FROM ${t}`).all()).results])));
      expect(compareBalances(balancesFromSupabase(b, FAKE_RATES, TODAY), balancesFromD1(all as any, FAKE_RATES, TODAY))).toEqual([]);
    };
    await runSql(raw, buildImport(b).sql); await check();
    await runSql(raw, buildImport(b, { replace: true }).sql); await check();
    await close();
  });
});
