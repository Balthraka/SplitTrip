import { parseCents } from '../src/cents.ts';

export interface ImportInput {
  authUsers: Record<string, string>[];      // id,email,created_at   (auth.users)
  profiles: Record<string, string>[];       // id,name,email,created_at
  trips: Record<string, string>[];
  trip_members: Record<string, string>[];
  expenses: Record<string, string>[];
  expense_splits: Record<string, string>[];
  payments: Record<string, string>[];
}
export interface ImportOptions {
  emailOverrides?: Record<string, string>;
  dropUsers?: string[];
  /**
   * Make D1 match the export exactly: first delete every trip (foreign keys cascade its members, expenses, splits and
   * payments), then insert. Users, identities and sessions are NOT touched, so nobody is signed out. Without this the
   * import only adds and updates, so a second run keeps rows that were deleted in the source and doubles the splits of an
   * expense that was edited there.
   */
  replace?: boolean;
}
export interface ImportReport {
  rows: Record<string, number>;             // rows that will be written, per table
  skipped: { orphanSplits: number };
  warnings: string[];
  estimatedRowsWritten: number;             // rows + one write per index entry, as D1 counts
}

// Indexes per table in schema/0001_init.sql, including the automatic index behind each TEXT PRIMARY KEY / UNIQUE.
const INDEXES: Record<string, number> = { users: 2, trips: 2, trip_members: 5, expenses: 5, expense_splits: 4, payments: 6 };

const q = (v: string | number | null): string =>
  v === null ? 'NULL' : typeof v === 'number' ? String(v) : `'${v.replace(/'/g, "''")}'`;

/** "2026-06-20 11:20:11.158322+00" -> "2026-06-20T11:20:11.158322Z" (6 fractional digits, like the Worker writes). */
export function toIso(s: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(?:\+00(?::?00)?|Z)$/.exec(s.trim());
  if (!m) throw new Error(`unexpected timestamp: ${JSON.stringify(s)}`);
  return `${m[1]}T${m[2]}.${(m[3] ?? '').padEnd(6, '0')}Z`;
}

export function buildImport(inp: ImportInput, opts: ImportOptions = {}) {
  const warnings: string[] = [];
  const fail = (m: string): never => { throw new Error(m); };
  const sql: string[] = [];
  const rows: Record<string, number> = {};
  const add = (table: string, stmt: string) => { sql.push(stmt); rows[table] = (rows[table] ?? 0) + 1; };
  if (opts.replace) sql.push('DELETE FROM trips;');   // cascades to trip_members, expenses, expense_splits, payments

  // users = auth.users joined to profiles (name). No password data exists in these exports and none is imported.
  const nameById = new Map(inp.profiles.map(p => [p.id, p.name]));
  const overrides = opts.emailOverrides ?? {};
  for (const id of Object.keys(overrides)) if (!inp.authUsers.some(u => u.id === id)) fail(`--email refers to unknown user id ${id}`);
  // --drop <userId>: leave an account out (e.g. an unused duplicate). Refused later if any trip, member, expense or payment points at it.
  const dropped = new Set(opts.dropUsers ?? []);
  for (const id of dropped) if (!inp.authUsers.some(u => u.id === id)) fail(`--drop refers to unknown user id ${id}`);
  const emails = new Map<string, string>();
  const userIds = new Set<string>();
  for (const u of inp.authUsers.filter(x => !dropped.has(x.id))) {
    const email = (overrides[u.id] ?? u.email).trim().toLowerCase();
    if (emails.has(email)) fail(`two users would share the email ${email} (${emails.get(email)} and ${u.id})`);
    emails.set(email, u.id); userIds.add(u.id);
    add('users', `INSERT INTO users (id, email, name, created_at) VALUES (${q(u.id)}, ${q(email)}, ${q(nameById.get(u.id) ?? '')}, ${q(toIso(u.created_at))})
      ON CONFLICT(id) DO UPDATE SET email = excluded.email, name = excluded.name;`);
  }
  for (const p of inp.profiles) if (!userIds.has(p.id) && !dropped.has(p.id)) warnings.push(`profile ${p.id} has no auth user`);

  const lastActivity = new Map<string, string>();
  for (const e of inp.expenses) {
    const c = toIso(e.created_at);
    if (!lastActivity.has(e.trip_id) || c > lastActivity.get(e.trip_id)!) lastActivity.set(e.trip_id, c);
  }
  const tripIds = new Set<string>();
  for (const t of inp.trips) {
    tripIds.add(t.id);
    const created = toIso(t.created_at);
    add('trips', `INSERT INTO trips (id, name, description, base_currency, expense_currency, created_by, created_at, last_activity_at, version)
      VALUES (${q(t.id)}, ${q(t.name)}, ${q(t.description || null)}, ${q(t.base_currency)}, ${q(t.expense_currency || t.base_currency)}, ${q(t.created_by || null)}, ${q(created)}, ${q(lastActivity.get(t.id) ?? created)}, 1)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description, base_currency = excluded.base_currency,
        expense_currency = excluded.expense_currency, created_by = excluded.created_by, last_activity_at = excluded.last_activity_at;`);
    if (t.created_by && !userIds.has(t.created_by)) fail(`trip ${t.id}: created_by is not a known user`);
  }

  const memberTrip = new Map<string, string>();
  for (const m of inp.trip_members) {
    if (!tripIds.has(m.trip_id)) fail(`member ${m.id} belongs to unknown trip`);
    if (m.user_id && !userIds.has(m.user_id)) fail(`member ${m.id} links to unknown user ${m.user_id}`);
    memberTrip.set(m.id, m.trip_id);
    add('trip_members', `INSERT INTO trip_members (id, trip_id, user_id, name, email, created_at)
      VALUES (${q(m.id)}, ${q(m.trip_id)}, ${q(m.user_id || null)}, ${q(m.name)}, ${q(m.email ? m.email.trim().toLowerCase() : null)}, ${q(toIso(m.created_at))})
      ON CONFLICT(id) DO UPDATE SET user_id = excluded.user_id, name = excluded.name, email = excluded.email;`);
  }

  const expenseTrip = new Map<string, string>();
  const expenseCents = new Map<string, number>();
  for (const e of inp.expenses) {
    if (!tripIds.has(e.trip_id)) fail(`expense ${e.id} belongs to unknown trip`);
    if (memberTrip.get(e.paid_by_member_id) !== e.trip_id) fail(`expense ${e.id}: payer is not a member of its trip`);
    if (e.created_by && !userIds.has(e.created_by)) fail(`expense ${e.id}: created_by is not a known user`);
    const amt = parseCents(e.amount);
    expenseTrip.set(e.id, e.trip_id); expenseCents.set(e.id, amt);
    add('expenses', `INSERT INTO expenses (id, trip_id, paid_by_member_id, amount_cents, currency, date, description, created_by, created_at, split_type, version)
      VALUES (${q(e.id)}, ${q(e.trip_id)}, ${q(e.paid_by_member_id)}, ${amt}, ${q(e.currency)}, ${q(e.date)}, ${q(e.description)}, ${q(e.created_by || null)}, ${q(toIso(e.created_at))}, ${q(e.split_type)}, 1)
      ON CONFLICT(id) DO UPDATE SET paid_by_member_id = excluded.paid_by_member_id, amount_cents = excluded.amount_cents, currency = excluded.currency,
        date = excluded.date, description = excluded.description, split_type = excluded.split_type;`);
  }

  let orphanSplits = 0;
  const splitSum = new Map<string, number>();
  for (const s of inp.expense_splits) {
    if (!expenseTrip.has(s.expense_id)) { orphanSplits++; continue; }
    if (memberTrip.get(s.member_id) !== expenseTrip.get(s.expense_id)) fail(`split ${s.id}: member is not in the expense's trip`);
    const amt = parseCents(s.amount);
    splitSum.set(s.expense_id, (splitSum.get(s.expense_id) ?? 0) + amt);
    add('expense_splits', `INSERT INTO expense_splits (id, expense_id, trip_id, member_id, amount_cents) VALUES (${q(s.id)}, ${q(s.expense_id)}, ${q(expenseTrip.get(s.expense_id)!)}, ${q(s.member_id)}, ${amt})
      ON CONFLICT(id) DO UPDATE SET expense_id = excluded.expense_id, trip_id = excluded.trip_id, member_id = excluded.member_id, amount_cents = excluded.amount_cents;`);
  }
  if (orphanSplits) warnings.push(`${orphanSplits} splits point to expenses that are not in the expenses export and were skipped (is the export capped at 100 rows?)`);
  const noSplits = [...expenseCents.keys()].filter(id => !splitSum.has(id)).length;
  if (noSplits) warnings.push(`${noSplits} expenses have no splits in the export`);
  const unbalanced = [...splitSum].filter(([id, sum]) => Math.abs(sum - expenseCents.get(id)!) > 2).length;
  if (unbalanced) warnings.push(`${unbalanced} expenses have splits that differ from the expense amount by more than 0.02`);

  for (const p of inp.payments) {
    if (!tripIds.has(p.trip_id)) fail(`payment ${p.id} belongs to unknown trip`);
    if (memberTrip.get(p.from_member_id) !== p.trip_id || memberTrip.get(p.to_member_id) !== p.trip_id) fail(`payment ${p.id}: member not in trip`);
    for (const u of [p.initiated_by, p.confirmed_by]) if (u && !userIds.has(u)) fail(`payment ${p.id}: user ${u} is not a known user`);
    add('payments', `INSERT INTO payments (id, trip_id, from_member_id, to_member_id, amount_cents, currency, status, initiated_by, confirmed_by, created_at, confirmed_at, version)
      VALUES (${q(p.id)}, ${q(p.trip_id)}, ${q(p.from_member_id)}, ${q(p.to_member_id)}, ${parseCents(p.amount)}, ${q(p.currency)}, ${q(p.status)}, ${q(p.initiated_by || null)}, ${q(p.confirmed_by || null)}, ${q(toIso(p.created_at))}, ${q(p.confirmed_at ? toIso(p.confirmed_at) : null)}, 1)
      ON CONFLICT(id) DO UPDATE SET status = excluded.status, confirmed_by = excluded.confirmed_by, confirmed_at = excluded.confirmed_at, amount_cents = excluded.amount_cents;`);
  }

  let estimatedRowsWritten = Object.entries(rows).reduce((a, [t, n]) => a + n * (1 + INDEXES[t]), 0);
  if (opts.replace) {
    // The delete removes the rows that are already there (about as many as the export holds) and their index entries.
    const deleted = ['trips', 'trip_members', 'expenses', 'expense_splits', 'payments'].reduce((a, t) => a + (rows[t] ?? 0) * (1 + INDEXES[t]), 0);
    estimatedRowsWritten += deleted;
    warnings.push(`--replace deletes every existing trip first (members, expenses, splits and payments with it), then re-inserts: about ${deleted} extra rows written. Anything entered in D1 since the last import is discarded, and members linked to a login are re-linked the next time that person opens the app.`);
  }
  const report: ImportReport = { rows, skipped: { orphanSplits }, warnings, estimatedRowsWritten };
  return { sql, report };
}
