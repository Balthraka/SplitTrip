import { createApp, forbidden, login, logout, notFound, publicGuard, userGuard, type GuardFn } from '../core';
import type { Ctx } from './types';
import { claim, deleteMe, getMe, patchMe } from './me';
import { addMember, createTrip, deleteTrip, getTrip, listMembers, listTrips, patchTrip, removeMember, tripData } from './trips';
import { createExpense, deleteExpense, listExpenses, updateExpense } from './expenses';
import { confirmPayment, createPayment, deletePayment, listPayments } from './payments';

/**
 * SplitTrip's route table. Each route names a guard; the core runs the guard before the handler, so a handler never
 * decides for itself whether to check sign-in or membership (see `guards` below for what each name means).
 *   public  - only /auth/*: no token needed
 *   user    - valid bearer token
 *   member  - user + member of :tripId (else 404, so non-members cannot probe trip ids)
 *   creator - user + trips.created_by = user (else 404 for strangers, 403 for members)
 */
export type Guard = 'public' | 'user' | 'member' | 'creator';
export interface Route { method: string; path: string; guard: Guard; handler: (c: Ctx) => Promise<Response>; }

export const routes: Route[] = [
  { method: 'POST',   path: '/auth/google',    guard: 'public',  handler: c => login('google', c) },
  { method: 'POST',   path: '/auth/microsoft', guard: 'public',  handler: c => login('microsoft', c) },

  { method: 'GET',    path: '/me',        guard: 'user', handler: getMe },
  { method: 'PATCH',  path: '/me',        guard: 'user', handler: patchMe },
  { method: 'DELETE', path: '/me',        guard: 'user', handler: deleteMe },
  { method: 'POST',   path: '/me/claim',  guard: 'user', handler: claim },
  { method: 'POST',   path: '/me/logout', guard: 'user', handler: logout },

  { method: 'GET',    path: '/trips',                     guard: 'user',    handler: listTrips },
  { method: 'POST',   path: '/trips',                     guard: 'user',    handler: createTrip },
  { method: 'GET',    path: '/trips/:tripId',             guard: 'member',  handler: getTrip },
  { method: 'GET',    path: '/trips/:tripId/all',         guard: 'member',  handler: tripData },
  { method: 'PATCH',  path: '/trips/:tripId',             guard: 'creator', handler: patchTrip },
  { method: 'DELETE', path: '/trips/:tripId',             guard: 'creator', handler: deleteTrip },

  { method: 'GET',    path: '/trips/:tripId/members',            guard: 'member',  handler: listMembers },
  { method: 'POST',   path: '/trips/:tripId/members',            guard: 'member',  handler: addMember },
  { method: 'DELETE', path: '/trips/:tripId/members/:memberId',  guard: 'creator', handler: removeMember },

  { method: 'GET',    path: '/trips/:tripId/expenses',              guard: 'member', handler: listExpenses },
  { method: 'POST',   path: '/trips/:tripId/expenses',              guard: 'member', handler: createExpense },
  { method: 'PUT',    path: '/trips/:tripId/expenses/:expenseId',   guard: 'member', handler: updateExpense },
  { method: 'DELETE', path: '/trips/:tripId/expenses/:expenseId',   guard: 'member', handler: deleteExpense },

  { method: 'GET',    path: '/trips/:tripId/payments',                       guard: 'member', handler: listPayments },
  { method: 'POST',   path: '/trips/:tripId/payments',                       guard: 'member', handler: createPayment },
  { method: 'POST',   path: '/trips/:tripId/payments/:paymentId/confirm',    guard: 'member', handler: confirmPayment },
  { method: 'DELETE', path: '/trips/:tripId/payments/:paymentId',            guard: 'member', handler: deletePayment },
];

/** member and creator guards: the signed-in check from the core, then the trip checks that only SplitTrip has. */
const tripGuard = (kind: 'member' | 'creator'): GuardFn<Ctx> => async (ctx) => {
  await userGuard(ctx);
  const tripId = ctx.params.tripId;
  const [trip, mem] = await ctx.env.DB.batch([
    ctx.env.DB.prepare('SELECT id, created_by, base_currency, expense_currency, version FROM trips WHERE id = ?1').bind(tripId),
    ctx.env.DB.prepare('SELECT 1 AS x FROM trip_members WHERE trip_id = ?1 AND user_id = ?2 LIMIT 1').bind(tripId, ctx.session.userId),
  ]);
  const t = (trip.results as any[])[0];
  const isMember = mem.results.length > 0;
  if (!t) throw notFound();
  if (kind === 'member' && !isMember) throw notFound();
  if (kind === 'creator' && t.created_by !== ctx.session.userId) throw isMember ? forbidden() : notFound();
  ctx.trip = { ...t, isMember };
};

export const guards: Record<Guard, GuardFn<Ctx>> = {
  public: publicGuard,
  user: userGuard,
  member: tripGuard('member'),
  creator: tripGuard('creator'),
};

/** SplitTrip's users table calls the display name `name`, and so does its JSON. */
export const app = createApp<Ctx>({ routes, guards, naming: { column: 'name', field: 'name' } });
