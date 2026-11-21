import { computeBalances, frozenRates, type BExpense, type BPayment } from '../src/balances.ts';
import type { ImportInput } from './importer.ts';

export type TripBalances = Record<string, { balances: Record<string, number>; totalSpend: number }>;
export interface D1Rows { trips: any[]; trip_members: any[]; expenses: any[]; expense_splits: any[]; payments: any[]; }
type Rates = Record<string, Record<string, number>>;

const byApp = (a: any, b: any) =>
  a.date < b.date ? 1 : a.date > b.date ? -1 : a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0;

/** Balances exactly as the live app derives them from the Supabase rows (amounts parsed as the numeric values PostgREST returns). */
export function balancesFromSupabase(inp: ImportInput, table: Rates, today?: string): TripBalances {
  const rate = frozenRates(table, today);
  const out: TripBalances = {};
  for (const t of inp.trips) {
    const members = inp.trip_members.filter(m => m.trip_id === t.id).map(m => m.id);
    const exps: BExpense[] = inp.expenses.filter(e => e.trip_id === t.id).sort(byApp).map(e => ({
      currency: e.currency, date: e.date, paid_by_member_id: e.paid_by_member_id, amount: parseFloat(e.amount),
      splits: inp.expense_splits.filter(s => s.expense_id === e.id).map(s => ({ member_id: s.member_id, amount: parseFloat(s.amount) })),
    }));
    // PostgREST serialises timestamptz as ISO with a T; the app splits on 'T' to get the payment's rate date.
    const pays: BPayment[] = inp.payments.filter(p => p.trip_id === t.id && p.status === 'confirmed').map(p => ({
      currency: p.currency, from_member_id: p.from_member_id, to_member_id: p.to_member_id, amount: parseFloat(p.amount),
      confirmed_at: p.confirmed_at ? p.confirmed_at.replace(' ', 'T') : null }));
    out[t.id] = computeBalances(exps, members, t.base_currency, pays, rate, today);
  }
  return out;
}

/** The same maths from D1 rows (integer cents / 100 gives the identical double as the old 2dp numeric). */
export function balancesFromD1(d: D1Rows, table: Rates, today?: string): TripBalances {
  const rate = frozenRates(table, today);
  const out: TripBalances = {};
  for (const t of d.trips) {
    const members = d.trip_members.filter(m => m.trip_id === t.id).map(m => m.id);
    const exps: BExpense[] = d.expenses.filter(e => e.trip_id === t.id).sort(byApp).map(e => ({
      currency: e.currency, date: e.date, paid_by_member_id: e.paid_by_member_id, amount: e.amount_cents / 100,
      splits: d.expense_splits.filter(s => s.expense_id === e.id).map(s => ({ member_id: s.member_id, amount: s.amount_cents / 100 })),
    }));
    const pays: BPayment[] = d.payments.filter(p => p.trip_id === t.id && p.status === 'confirmed').map(p => ({
      currency: p.currency, from_member_id: p.from_member_id, to_member_id: p.to_member_id, amount: p.amount_cents / 100, confirmed_at: p.confirmed_at }));
    out[t.id] = computeBalances(exps, members, t.base_currency, pays, rate, today);
  }
  return out;
}

export interface Diff { trip: string; member: string; original: number | undefined; d1: number | undefined; }
/** Every trip and member must match to the cent (balances are already rounded to 2dp by computeBalances). */
export function compareBalances(orig: TripBalances, d1: TripBalances): Diff[] {
  const diffs: Diff[] = [];
  for (const trip of new Set([...Object.keys(orig), ...Object.keys(d1)])) {
    const a = orig[trip]?.balances ?? {}, b = d1[trip]?.balances ?? {};
    for (const m of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (a[m] === undefined || b[m] === undefined || Math.round(a[m] * 100) !== Math.round(b[m] * 100)) diffs.push({ trip, member: m, original: a[m], d1: b[m] });
    }
    if (Math.round((orig[trip]?.totalSpend ?? NaN) * 100) !== Math.round((d1[trip]?.totalSpend ?? NaN) * 100)) diffs.push({ trip, member: '(total spend)', original: orig[trip]?.totalSpend, d1: d1[trip]?.totalSpend });
  }
  return diffs;
}
