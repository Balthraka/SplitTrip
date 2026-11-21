import type { Ctx } from './types';
import { json, readJson, str } from './util';

export const getMe = async (c: Ctx) => json({ id: c.session.userId, email: c.session.email, name: c.session.name });

/** Old rpc `update_profile_name`: rename the profile and every trip_members row of this user, atomically. */
export async function patchMe(c: Ctx) {
  const body = await readJson(c.req);
  const name = str(body.name, 'name', 100);
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE users SET name = ?1 WHERE id = ?2').bind(name, c.session.userId),
    c.env.DB.prepare('UPDATE trip_members SET name = ?1 WHERE user_id = ?2').bind(name, c.session.userId),
  ]);
  return json({ id: c.session.userId, email: c.session.email, name });
}

/**
 * Old rpc `claim_memberships`: attach trip_members rows invited by email to this user.
 * Only on a provider-verified email (Google). A Microsoft session claims nothing.
 */
export async function claim(c: Ctx) {
  // The reply also carries the signed-in user (the same fields as GET /me), so the page can open with this one call.
  const user = { id: c.session.userId, email: c.session.email, name: c.session.name };
  if (!c.session.verifiedEmail) return json({ claimed: 0, ...user });
  const r = await c.env.DB.prepare(
    'UPDATE trip_members SET user_id = ?1 WHERE email = ?2 AND user_id IS NULL'
  ).bind(c.session.userId, c.session.email).run();
  return json({ claimed: r.meta.changes ?? 0, ...user });
}

/**
 * Old rpc `delete_my_account`, copied as it is today:
 *   1. for every trip the user created, promote the oldest remaining linked member to creator
 *      (NULL if there is none, as in the old SQL), then
 *   2. delete the user.
 * Deleting the user removes their profile (users row), sessions and identities, and, exactly as the Supabase foreign keys
 * do (ON DELETE SET NULL), blanks trips.created_by, trip_members.user_id, expenses.created_by and payments.initiated_by /
 * confirmed_by. Their trip_members rows stay so shared expense history keeps adding up.
 * Only this app's data is touched: there is no shared delete.
 */
export async function deleteMe(c: Ctx) {
  const id = c.session.userId;
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE trips SET created_by = (
         SELECT tm.user_id FROM trip_members tm
          WHERE tm.trip_id = trips.id AND tm.user_id IS NOT NULL AND tm.user_id != ?1
          ORDER BY tm.created_at ASC LIMIT 1)
       WHERE created_by = ?1`).bind(id),
    c.env.DB.prepare('DELETE FROM users WHERE id = ?1').bind(id), // cascades sessions + identities, nulls trip_members.user_id
  ]);
  return json({ ok: true });
}
