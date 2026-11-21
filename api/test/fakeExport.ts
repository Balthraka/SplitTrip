// A made-up Supabase export in the exact CSV shape of the real one. Names, addresses and amounts are invented.
import type { ImportInput } from '../scripts/importer';
import { uid } from './helpers';

export function fakeExport(): ImportInput {
  const U = { ann: uid(101), ben: uid(102), cat: uid(103) };
  const T1 = uid(201), T2 = uid(202);
  const M = { ann1: uid(301), ben1: uid(302), cat1: uid(303), lee1: uid(304), ann2: uid(305), ben2: uid(306) };
  const ts = (d: string, t = '10:00:00.123456') => `${d} ${t}+00`;
  const authUsers = [
    { id: U.ann, email: 'ann@example.com', created_at: ts('2026-05-01') },
    { id: U.ben, email: 'Ben.Test@example.com', created_at: ts('2026-05-02') },
    { id: U.cat, email: 'cat@example.com', created_at: ts('2026-05-03') },
  ];
  const profiles = authUsers.map(u => ({ id: u.id, name: u.email.split('@')[0], email: u.email, created_at: u.created_at }));
  const trips = [
    { id: T1, name: 'Fake Trip, "Quoted"\nSecond line', description: "It's a test", base_currency: 'AUD', created_by: U.ann, created_at: ts('2026-05-10'), expense_currency: 'AUD' },
    { id: T2, name: 'Weekend', description: '', base_currency: 'AUD', created_by: U.ben, created_at: ts('2026-06-01'), expense_currency: 'AUD' },
  ];
  const mem = (id: string, trip: string, user: string, name: string, email: string) => ({ id, trip_id: trip, user_id: user, name, email, created_at: ts('2026-05-10', '11:00:00.5') });
  const trip_members = [
    mem(M.ann1, T1, U.ann, 'Ann', 'ann@example.com'), mem(M.ben1, T1, U.ben, 'Ben', 'ben.test@example.com'),
    mem(M.cat1, T1, U.cat, 'Cat', 'cat@example.com'), mem(M.lee1, T1, '', 'Lee (no account)', ''),
    mem(M.ann2, T2, U.ann, 'Ann', 'ann@example.com'), mem(M.ben2, T2, U.ben, 'Ben', 'ben.test@example.com'),
  ];
  const expenses: Record<string, string>[] = []; const expense_splits: Record<string, string>[] = []; let n = 400;
  const ex = (trip: string, paid: string, amount: string, cur: string, date: string, desc: string, type: string, splits: [string, string][], by = U.ann) => {
    const id = uid(n++);
    expenses.push({ id, trip_id: trip, paid_by_member_id: paid, amount, currency: cur, date, description: desc, created_by: by, created_at: ts(date, `0${n % 10}:30:00.${100000 + n}`), split_type: type });
    for (const [member, a] of splits) expense_splits.push({ id: uid(n++ + 1000), expense_id: id, member_id: member, amount: a });
  };
  // uneven equal split: 100.01 over three people
  ex(T1, M.ann1, '100.01', 'AUD', '2026-06-01', 'Dinner, with "quotes" and an apostrophe\'s', 'equal', [[M.ann1, '33.34'], [M.ben1, '33.34'], [M.cat1, '33.33']]);
  ex(T1, M.ben1, '1188000.00', 'VND', '2026-06-02', 'Massage', 'equal', [[M.ann1, '594000.00'], [M.ben1, '594000.00']]);
  ex(T1, M.cat1, '19.99', 'AUD', '2026-06-02', 'Snacks', 'single', [[M.lee1, '19.99']]);
  ex(T1, M.ann1, '27.86', 'AUD', '2026-06-03', 'Happy hour', 'percent', [[M.ann1, '8.35'], [M.ben1, '11.14'], [M.cat1, '8.37']]);
  ex(T1, M.ben1, '188000.00', 'VND', '2026-06-03', 'Banh mi', 'exact', [[M.ann1, '100000.00'], [M.cat1, '88000.00']]);
  ex(T1, M.cat1, '10.00', 'SGD', '2026-06-04', 'Cash', 'equal', [[M.ann1, '2.50'], [M.ben1, '2.50'], [M.cat1, '2.50'], [M.lee1, '2.50']]);
  ex(T1, M.ann1, '0.07', 'AUD', '2026-06-04', 'Tiny', 'single', [[M.ben1, '0.07']]);
  ex(T2, M.ann2, '45.50', 'AUD', '2026-06-05', 'Pizza', 'equal', [[M.ann2, '22.75'], [M.ben2, '22.75']], U.ben);
  ex(T2, M.ben2, '12.34', 'AUD', '2026-06-06', 'Coffee', 'equal', [[M.ann2, '6.17'], [M.ben2, '6.17']], U.ben);
  const pay = (id: number, trip: string, from: string, to: string, amount: string, cur: string, status: string, confirmed: string) => ({
    id: uid(id), trip_id: trip, from_member_id: from, to_member_id: to, amount, currency: cur, status, initiated_by: U.ann,
    confirmed_by: confirmed ? U.ben : '', created_at: ts('2026-06-10', '01:02:03.4'), confirmed_at: confirmed ? ts(confirmed, '02:03:04.5') : '' });
  const payments = [
    pay(700, T1, M.cat1, M.ann1, '15.00', 'AUD', 'confirmed', '2026-06-11'),
    pay(701, T1, M.ben1, M.ann1, '200000.00', 'VND', 'confirmed', '2026-06-12'),
    pay(702, T1, M.lee1, M.cat1, '5.00', 'AUD', 'pending', ''),
    pay(703, T2, M.ben2, M.ann2, '10.00', 'AUD', 'confirmed', '2026-06-12'),
  ];
  return { authUsers, profiles, trips, trip_members, expenses, expense_splits, payments };
}

/** Frozen rate table in the app's cache shape; both sides of the comparison use it. */
export const FAKE_RATES = {
  'vnd@2026-06-02': { aud: 0.0000591 }, 'vnd@2026-06-03': { aud: 0.0000593 }, 'vnd@2026-06-12': { aud: 0.0000588 },
  'sgd@2026-06-04': { aud: 1.1517 }, 'sgd@2026-06-11': { aud: 1.1502 },
};
