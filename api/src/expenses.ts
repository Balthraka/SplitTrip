import type { Ctx } from './types';
import { cents } from './money';
import { bad, conflict, currency, forbidden, isoDate, json, newId, notFound, nowIso, randomToken, readJson, str, version } from './util';

const SPLIT_TYPES = ['equal', 'percent', 'exact', 'single'];
/** One expense write is one D1 batch: the expense, its splits and the trip stamp must stay under 50 statements (free plan). */
export const MAX_SPLITS = 40;

interface Parsed { paid_by: string; amount: number; cur: string; date: string; description: string; split_type: string; splits: { member_id: string; amount: number }[]; }

async function parseExpense(c: Ctx, b: Record<string, unknown>): Promise<Parsed> {
  const amount = cents(b.amount_cents);
  const split_type = String(b.split_type);
  if (!SPLIT_TYPES.includes(split_type)) throw bad('invalid_split_type');
  if (!Array.isArray(b.splits) || b.splits.length < 1 || b.splits.length > MAX_SPLITS) throw bad('invalid_splits');
  const seen = new Set<string>();
  const splits = (b.splits as any[]).map(s => {
    if (!s || typeof s.member_id !== 'string' || seen.has(s.member_id)) throw bad('invalid_splits');
    seen.add(s.member_id);
    return { member_id: s.member_id, amount: cents(s.amount_cents, 'split_amount_cents', { allowZero: true }) };   // 0 is legal: 0.02 split 3 ways is 1, 1, 0 cents
  });
  const paid_by = str(b.paid_by_member_id, 'paid_by_member_id', 64);
  if (split_type === 'single' && splits.length !== 1) throw bad('invalid_splits');

  // Same tolerance as today's form: exact splits may be off by up to 0.02, everything else must add up exactly.
  const sum = splits.reduce((a, s) => a + s.amount, 0);
  const tol = split_type === 'exact' ? 2 : 0;
  if (Math.abs(sum - amount) > tol) throw bad('splits_do_not_sum');

  // Everyone named must be a member of THIS trip (one indexed query, rows read = members of the trip).
  const mem = await c.env.DB.prepare('SELECT id FROM trip_members WHERE trip_id = ?1').bind(c.params.tripId).all<{ id: string }>();
  const ids = new Set(mem.results.map(r => r.id));
  if (!ids.has(paid_by) || splits.some(s => !ids.has(s.member_id))) throw bad('member_not_in_trip');

  return { paid_by, amount, cur: currency(b.currency), date: isoDate(b.date),
           description: str(b.description, 'description', 500), split_type, splits };
}

export async function listExpenses(c: Ctx) {
  return json(await expensesOf(c));
}

export async function expensesOf(c: Ctx) {
  const [ex, sp] = await c.env.DB.batch([
    c.env.DB.prepare('SELECT * FROM expenses WHERE trip_id = ?1 ORDER BY date DESC, created_at DESC').bind(c.params.tripId),
    c.env.DB.prepare('SELECT id, expense_id, member_id, amount_cents FROM expense_splits WHERE trip_id = ?1').bind(c.params.tripId),
  ]);
  const by = new Map<string, any[]>();
  for (const s of sp.results as any[]) {
    if (!by.has(s.expense_id)) by.set(s.expense_id, []);
    by.get(s.expense_id)!.push({ id: s.id, member_id: s.member_id, amount_cents: s.amount_cents });
  }
  return (ex.results as any[]).map(({ row_token, ...e }) => ({ ...e, expense_splits: by.get(e.id) ?? [] }));
}

/** POST: the expense and all its splits go in ONE D1 batch (a transaction): all rows or none. */
export async function createExpense(c: Ctx) {
  const p = await parseExpense(c, await readJson(c.req));
  const db = c.env.DB, id = newId(), now = nowIso();
  await db.batch([
    db.prepare(
      `INSERT INTO expenses (id, trip_id, paid_by_member_id, amount_cents, currency, date, description, created_by, created_at, split_type, version)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,1)`)
      .bind(id, c.params.tripId, p.paid_by, p.amount, p.cur, p.date, p.description, c.session.userId, now, p.split_type),
    ...p.splits.map(s => db.prepare('INSERT INTO expense_splits (id, expense_id, trip_id, member_id, amount_cents) VALUES (?1,?2,?3,?4,?5)')
      .bind(newId(), id, c.params.tripId, s.member_id, s.amount)),
    db.prepare('UPDATE trips SET last_activity_at = MAX(last_activity_at, ?2) WHERE id = ?1').bind(c.params.tripId, now),
  ]);
  return json(await loadOne(c, id), 201);
}

async function loadOne(c: Ctx, id: string) {
  const [ex, sp] = await c.env.DB.batch([
    c.env.DB.prepare('SELECT * FROM expenses WHERE id = ?1 AND trip_id = ?2').bind(id, c.params.tripId),
    c.env.DB.prepare('SELECT id, member_id, amount_cents FROM expense_splits WHERE expense_id = ?1').bind(id),
  ]);
  const e = (ex.results as any[])[0];
  if (!e) throw notFound();
  const { row_token, ...rest } = e;
  return { ...rest, expense_splits: sp.results };
}

/** Policy "Creator can update expense": only the person who created it. */
async function ownExpense(c: Ctx) {
  const e = await c.env.DB.prepare('SELECT id, created_by FROM expenses WHERE id = ?1 AND trip_id = ?2')
    .bind(c.params.expenseId, c.params.tripId).first<{ created_by: string | null }>();
  if (!e) throw notFound();
  if (e.created_by !== c.session.userId) throw forbidden();
}

/**
 * PUT: expense update + splits replaced in ONE batch, guarded by `version`.
 * The first statement only matches the version we were sent and stamps a per-request token; every later statement
 * only acts while that token is still on the row, so a stale edit changes nothing and returns 409.
 */
export async function updateExpense(c: Ctx) {
  const b = await readJson(c.req);
  const v = version(b.version);
  await ownExpense(c);
  const p = await parseExpense(c, b);
  const db = c.env.DB, token = randomToken(), id = c.params.expenseId;
  const res = await db.batch([
    db.prepare(
      `UPDATE expenses SET paid_by_member_id=?1, amount_cents=?2, currency=?3, date=?4, description=?5, split_type=?6,
              version = version + 1, row_token = ?7
        WHERE id = ?8 AND trip_id = ?9 AND version = ?10`)
      .bind(p.paid_by, p.amount, p.cur, p.date, p.description, p.split_type, token, id, c.params.tripId, v),
    db.prepare('DELETE FROM expense_splits WHERE expense_id = ?1 AND EXISTS (SELECT 1 FROM expenses WHERE id = ?1 AND row_token = ?2)').bind(id, token),
    ...p.splits.map(s => db.prepare(
      `INSERT INTO expense_splits (id, expense_id, trip_id, member_id, amount_cents)
       SELECT ?1, ?2, ?3, ?4, ?5 WHERE EXISTS (SELECT 1 FROM expenses WHERE id = ?2 AND row_token = ?6)`)
      .bind(newId(), id, c.params.tripId, s.member_id, s.amount, token)),
  ]);
  if (!res[0].meta.changes) throw conflict('stale_version');
  return json(await loadOne(c, id));
}

export async function deleteExpense(c: Ctx) {
  await ownExpense(c);
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM expenses WHERE id = ?1 AND trip_id = ?2').bind(c.params.expenseId, c.params.tripId), // splits cascade
    c.env.DB.prepare(
      'UPDATE trips SET last_activity_at = COALESCE((SELECT MAX(created_at) FROM expenses WHERE trip_id = ?1), created_at) WHERE id = ?1')
      .bind(c.params.tripId),
  ]);
  return json({ ok: true });
}
