import type { Ctx } from './types';
import { expensesOf } from './expenses';
import { paymentsOf } from './payments';
import { bad, conflict, currency, email, forbidden, json, newId, notFound, nowIso, readJson, str, version } from './util';

/** GET /trips: trips the user is a member of or created (policy "Members and creator can view their trips"), with members. */
export async function listTrips(c: Ctx) {
  const me = c.session.userId;
  const [trips, members] = await c.env.DB.batch([
    c.env.DB.prepare(
      `SELECT * FROM trips WHERE id IN (SELECT trip_id FROM trip_members WHERE user_id = ?1)
       UNION SELECT * FROM trips WHERE created_by = ?1
       ORDER BY last_activity_at DESC`).bind(me),
    c.env.DB.prepare(
      `SELECT id, trip_id, user_id, name FROM trip_members
        WHERE trip_id IN (SELECT trip_id FROM trip_members WHERE user_id = ?1 UNION SELECT id FROM trips WHERE created_by = ?1)
        ORDER BY created_at`).bind(me),
  ]);
  const byTrip = new Map<string, any[]>();
  for (const m of members.results as any[]) {
    if (!byTrip.has(m.trip_id)) byTrip.set(m.trip_id, []);
    byTrip.get(m.trip_id)!.push({ id: m.id, name: m.name, user_id: m.user_id });
  }
  return json((trips.results as any[]).map(t => ({ ...t, trip_members: byTrip.get(t.id) ?? [] })));
}

/** Creating a trip is one D1 batch (trip + every member), so it must stay under 50 statements on the free plan. */
export const MAX_MEMBERS = 40;

/** POST /trips. Only the caller's own member row is linked to a user; other members are invited by email and claimed later. */
export async function createTrip(c: Ctx) {
  const b = await readJson(c.req);
  const name = str(b.name, 'name', 120);
  const description = str(b.description, 'description', 500, { optional: true }) || null;
  const baseCur = currency(b.base_currency, 'base_currency');
  const expCur = currency(b.expense_currency ?? b.base_currency, 'expense_currency');
  if (!Array.isArray(b.members) || b.members.length > MAX_MEMBERS) throw bad('invalid_members');

  const tripId = newId();
  const now = nowIso();
  const db = c.env.DB;
  const stmts = [db.prepare(
    `INSERT INTO trips (id, name, description, base_currency, expense_currency, created_by, created_at, last_activity_at, version)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, 1)`).bind(tripId, name, description, baseCur, expCur, c.session.userId, now)];

  let selfIncluded = false;
  const memberOut: any[] = [];
  for (const raw of b.members as any[]) {
    if (!raw || typeof raw !== 'object') throw bad('invalid_members');
    const mName = str(raw.name, 'member_name', 100);
    const mEmail = email(raw.email, 'member_email');
    const isSelf = raw.is_self === true || (mEmail !== null && mEmail === c.session.email);
    const uid = isSelf && !selfIncluded ? c.session.userId : null;
    if (uid) selfIncluded = true;
    const id = newId();
    memberOut.push({ id, name: mName, user_id: uid });
    stmts.push(db.prepare('INSERT INTO trip_members (id, trip_id, user_id, name, email, created_at) VALUES (?1,?2,?3,?4,?5,?6)')
      .bind(id, tripId, uid, mName, mEmail, now));
  }
  if (!selfIncluded) {
    const id = newId();
    memberOut.unshift({ id, name: c.session.name || c.session.email, user_id: c.session.userId });
    stmts.push(db.prepare('INSERT INTO trip_members (id, trip_id, user_id, name, email, created_at) VALUES (?1,?2,?3,?4,?5,?6)')
      .bind(id, tripId, c.session.userId, c.session.name || c.session.email, c.session.email, now));
  }
  await db.batch(stmts);
  return json({ id: tripId, name, description, base_currency: baseCur, expense_currency: expCur, created_by: c.session.userId,
    created_at: now, last_activity_at: now, version: 1, trip_members: memberOut }, 201);
}

export async function getTrip(c: Ctx) {
  const t = await c.env.DB.prepare('SELECT * FROM trips WHERE id = ?1').bind(c.params.tripId).first();
  return json(t);
}

/**
 * GET /trips/:id/all: members, expenses (with splits) and payments in ONE request. Same data and same checks as the three
 * separate routes (the dispatcher's member guard runs once); it only saves two requests per trip open.
 */
export async function tripData(c: Ctx) {
  const [members, expenses, payments] = await Promise.all([membersOf(c), expensesOf(c), paymentsOf(c)]);
  return json({ members, expenses, payments });
}

/** PATCH /trips/:id: creator only (policy "Trip creator can update their trip"); stale edit -> 409. */
export async function patchTrip(c: Ctx) {
  const b = await readJson(c.req);
  const v = version(b.version);
  const name = str(b.name, 'name', 120);
  const description = str(b.description, 'description', 500, { optional: true }) || null;
  const baseCur = currency(b.base_currency, 'base_currency');
  const expCur = currency(b.expense_currency, 'expense_currency');
  const r = await c.env.DB.prepare(
    `UPDATE trips SET name=?1, description=?2, base_currency=?3, expense_currency=?4, version = version + 1
      WHERE id = ?5 AND version = ?6`).bind(name, description, baseCur, expCur, c.params.tripId, v).run();
  if (!r.meta.changes) throw conflict('stale_version');
  return json(await c.env.DB.prepare('SELECT * FROM trips WHERE id = ?1').bind(c.params.tripId).first());
}

/** DELETE /trips/:id: creator only. One statement; foreign keys cascade members, expenses, splits and payments atomically. */
export async function deleteTrip(c: Ctx) {
  await c.env.DB.prepare('DELETE FROM trips WHERE id = ?1').bind(c.params.tripId).run();
  return json({ ok: true });
}

export async function membersOf(c: Ctx) {
  const r = await c.env.DB.prepare('SELECT * FROM trip_members WHERE trip_id = ?1 ORDER BY created_at').bind(c.params.tripId).all();
  return r.results;
}
export async function listMembers(c: Ctx) {
  return json(await membersOf(c));
}

/** POST /trips/:id/members: any member may add (policy "Trip creator or members can add members"). */
export async function addMember(c: Ctx) {
  const b = await readJson(c.req);
  const name = str(b.name, 'name', 100);
  const mEmail = email(b.email);
  const id = newId(), now = nowIso();
  const count = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM trip_members WHERE trip_id = ?1').bind(c.params.tripId).first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_MEMBERS) throw bad('too_many_members');
  await c.env.DB.prepare('INSERT INTO trip_members (id, trip_id, user_id, name, email, created_at) VALUES (?1,?2,?3,?4,?5,?6)')
    .bind(id, c.params.tripId, null, name, mEmail, now).run();
  return json({ id, trip_id: c.params.tripId, user_id: null, name, email: mEmail, created_at: now }, 201);
}

/**
 * DELETE /trips/:id/members/:mid: creator only. Copies the old foreign keys: a member who PAID an expense cannot be removed
 * (ON DELETE RESTRICT -> 409); otherwise their splits and payments are removed with them (ON DELETE CASCADE).
 */
export async function removeMember(c: Ctx) {
  const mid = c.params.memberId;
  const m = await c.env.DB.prepare('SELECT id FROM trip_members WHERE id = ?1 AND trip_id = ?2').bind(mid, c.params.tripId).first();
  if (!m) throw notFound();
  const paid = await c.env.DB.prepare('SELECT 1 AS x FROM expenses WHERE paid_by_member_id = ?1 LIMIT 1').bind(mid).first();
  if (paid) throw conflict('member_paid_expenses');
  await c.env.DB.prepare('DELETE FROM trip_members WHERE id = ?1 AND trip_id = ?2').bind(mid, c.params.tripId).run();
  return json({ ok: true });
}
