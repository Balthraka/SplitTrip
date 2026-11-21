// Writes the made-up export from test/fakeExport.ts as CSV files, to rehearse the real runbook without any real data.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FAKE_RATES, fakeExport } from '../test/fakeExport.ts';
const dir = process.argv[2] ?? '/tmp/fake-export';
mkdirSync(dir, { recursive: true });
const esc = (v: string) => /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
const csv = (rows: Record<string, string>[]) => [Object.keys(rows[0]).join(','), ...rows.map(r => Object.values(r).map(esc).join(','))].join('\n') + '\n';
const e = fakeExport();
writeFileSync(join(dir, 'auth_users.csv'), csv(e.authUsers));
writeFileSync(join(dir, 'profiles_rows.csv'), csv(e.profiles));
writeFileSync(join(dir, 'trips_rows.csv'), csv(e.trips));
writeFileSync(join(dir, 'trip_members_rows.csv'), csv(e.trip_members));
writeFileSync(join(dir, 'expenses_rows.csv'), csv(e.expenses));
writeFileSync(join(dir, 'expense_splits_rows.csv'), csv(e.expense_splits));
writeFileSync(join(dir, 'payments_rows.csv'), csv(e.payments));
writeFileSync(join(dir, 'rates.json'), JSON.stringify(FAKE_RATES));
console.log('wrote fake export to', dir);
