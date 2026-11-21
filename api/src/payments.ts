import type { Ctx } from './types';
import { cents } from './money';
import { bad, conflict, currency, forbidden, json, newId, notFound, nowIso, readJson, str } from './util';

export async function paymentsOf(c: Ctx) {
  const r = await c.env.DB.prepare('SELECT * FROM payments WHERE trip_id = ?1 ORDER BY created_at DESC').bind(c.params.tripId).all();
  return r.results;
}
export async function listPayments(c: Ctx) {
  return json(await paymentsOf(c));
}

export async function createPayment(c: Ctx) {
  const b = await readJson(c.req);
  const from = str(b.from_member_id, 'from_member_id', 64), to = str(b.to_member_id, 'to_member_id', 64);
  if (from === to) throw bad('same_member');
  const amount = cents(b.amount_cents), cur = currency(b.currency);
  const mem = await c.env.DB.prepare('SELECT id FROM trip_members WHERE trip_id = ?1 AND id IN (?2, ?3)').bind(c.params.tripId, from, to).all();
  if (mem.results.length !== 2) throw bad('member_not_in_trip');
  const id = newId(), now = nowIso();
  await c.env.DB.prepare(
    `INSERT INTO payments (id, trip_id, from_member_id, to_member_id, amount_cents, currency, status, initiated_by, created_at, version)
     VALUES (?1,?2,?3,?4,?5,?6,'pending',?7,?8,1)`).bind(id, c.params.tripId, from, to, amount, cur, c.session.userId, now).run();
  return json(await c.env.DB.prepare('SELECT * FROM payments WHERE id = ?1').bind(id).first(), 201);
}

/** Policy "Trip members can update payments" + the app's `.eq('status','pending')` guard: only a pending payment can be confirmed. */
export async function confirmPayment(c: Ctx) {
  const now = nowIso();
  const r = await c.env.DB.prepare(
    `UPDATE payments SET status='confirmed', confirmed_by=?1, confirmed_at=?2, version = version + 1
      WHERE id = ?3 AND trip_id = ?4 AND status = 'pending'`).bind(c.session.userId, now, c.params.paymentId, c.params.tripId).run();
  if (!r.meta.changes) {
    const exists = await c.env.DB.prepare('SELECT 1 AS x FROM payments WHERE id = ?1 AND trip_id = ?2').bind(c.params.paymentId, c.params.tripId).first();
    throw exists ? conflict('not_pending') : notFound();
  }
  return json(await c.env.DB.prepare('SELECT * FROM payments WHERE id = ?1').bind(c.params.paymentId).first());
}

/** Policy "Initiator can delete pending payments": pending only, by the initiator or either side of the payment. */
export async function deletePayment(c: Ctx) {
  const r = await c.env.DB.prepare(
    `DELETE FROM payments WHERE id = ?1 AND trip_id = ?2 AND status = 'pending'
        AND (initiated_by = ?3
          OR from_member_id IN (SELECT id FROM trip_members WHERE user_id = ?3 AND trip_id = ?2)
          OR to_member_id   IN (SELECT id FROM trip_members WHERE user_id = ?3 AND trip_id = ?2))`)
    .bind(c.params.paymentId, c.params.tripId, c.session.userId).run();
  if (!r.meta.changes) {
    const p = await c.env.DB.prepare('SELECT status FROM payments WHERE id = ?1 AND trip_id = ?2').bind(c.params.paymentId, c.params.tripId).first<{ status: string }>();
    if (!p) throw notFound();
    throw p.status === 'pending' ? forbidden() : conflict('not_pending');
  }
  return json({ ok: true });
}
