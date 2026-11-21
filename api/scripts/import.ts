// Usage: node scripts/import.ts --dir <folder with the CSV exports> --auth <auth.users csv> [--email <userId>=<newEmail>]... [--drop <userId>]... [--out import-out/import.sql] [--replace] [--force]
// Writes a SQL file only. It never talks to Cloudflare. Rehearse with `wrangler d1 execute splittrip --local --file ...`.
// Re-use the same --email flags on every re-run, otherwise the user's email is reset to the old address.
// FIRST import: no --replace needed. Every later import (the final one before cutover): use --replace, otherwise rows deleted or
// edited in the source stay or double up in D1. --replace deletes all trips (and their members/expenses/splits/payments) first.
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { parseCsv } from './csv.ts';
import { buildImport } from './importer.ts';

const { values } = parseArgs({ options: {
  dir: { type: 'string' }, auth: { type: 'string' }, email: { type: 'string', multiple: true }, drop: { type: 'string', multiple: true },
  out: { type: 'string', default: 'import-out/import.sql' }, force: { type: 'boolean', default: false }, replace: { type: 'boolean', default: false },
} });
if (!values.dir || !values.auth) throw new Error('need --dir and --auth');
const dir: string = values.dir, authFile: string = values.auth;

const files = readdirSync(dir);
const read = (suffix: string) => {
  const hits = files.filter(f => f.endsWith(suffix));
  if (hits.length !== 1) throw new Error(`expected exactly one file ending in ${suffix} in ${dir}, found ${hits.length}`);
  return parseCsv(readFileSync(join(dir, hits[0]), 'utf8'));
};
const emailOverrides: Record<string, string> = {};
for (const e of values.email ?? []) { const [id, ...rest] = e.split('='); emailOverrides[id] = rest.join('='); }

const { sql, report } = buildImport({
  authUsers: parseCsv(readFileSync(authFile, 'utf8')),
  profiles: read('profiles_rows.csv'), trips: read('trips_rows.csv'), trip_members: read('trip_members_rows.csv'),
  expenses: read('expenses_rows.csv'), expense_splits: read('expense_splits_rows.csv'), payments: read('payments_rows.csv'),
}, { emailOverrides, dropUsers: values.drop ?? [], replace: values.replace });

console.log(JSON.stringify(report, null, 2));
if (report.estimatedRowsWritten > 3000 && !values.force) {
  console.error(`\nSTOP: estimated ${report.estimatedRowsWritten} rows written is over the 3,000 limit in decisions-and-rules.md. Tell the project owner before any remote import (use --force only for a local rehearsal).`);
  process.exit(2);
}
mkdirSync(dirname(values.out!), { recursive: true });
writeFileSync(values.out!, sql.join('\n') + '\n');
console.log(`\nwrote ${sql.length} statements to ${values.out}`);
