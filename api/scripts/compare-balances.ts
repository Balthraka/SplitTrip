// Usage: npx tsx scripts/compare-balances.ts --dir <csv folder> --rates rates.json (--local | --remote) [--db splittrip] [--today YYYY-MM-DD]
// Computes every trip's per-member balance twice, the way the live app does it: once from the Supabase CSV export and once from D1
// (read-only SELECTs through wrangler), with the same frozen rates. Exits 1 if any trip/member differs by even one cent.
// Reads about one row per record in the database (a few hundred), well inside the free daily limit.
import { execFileSync, execSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { parseCsv } from './csv.ts';
import { balancesFromD1, balancesFromSupabase, compareBalances } from './compare.ts';
import type { ImportInput } from './importer.ts';

const { values } = parseArgs({ options: {
  dir: { type: 'string' }, rates: { type: 'string' }, local: { type: 'boolean' }, remote: { type: 'boolean' },
  db: { type: 'string', default: 'splittrip' }, today: { type: 'string' },
} });
if (!values.dir || !values.rates || (!values.local && !values.remote)) throw new Error('need --dir, --rates and --local or --remote');
const dir: string = values.dir;
const read = (suffix: string) => parseCsv(readFileSync(join(dir, readdirSync(dir).find(f => f.endsWith(suffix))!), 'utf8'));
const src: ImportInput = { authUsers: [], profiles: [], trips: read('trips_rows.csv'), trip_members: read('trip_members_rows.csv'),
  expenses: read('expenses_rows.csv'), expense_splits: read('expense_splits_rows.csv'), payments: read('payments_rows.csv') };

// A capped export (the dashboard stops at 100 rows) makes this comparison meaningless, so refuse to run on one.
const exIds = new Set(src.expenses.map(e => e.id));
const orphan = src.expense_splits.filter(s => !exIds.has(s.expense_id)).length;
const noSplits = src.expenses.filter(e => !src.expense_splits.some(s => s.expense_id === e.id)).length;
if (orphan || noSplits) {
  console.error(`The export looks truncated (${orphan} splits without an expense, ${noSplits} expenses without splits). Re-export every table in full and try again.`);
  process.exit(3);
}

const q = (table: string) => {
  const args = ['wrangler', 'd1', 'execute', values.db!, values.remote ? '--remote' : '--local', '--json', '--command', `SELECT * FROM ${table}`];
  // On Windows `npx` is a .cmd file, which Node only runs through a shell, so the command is quoted by hand there.
  const out = process.platform === 'win32'
    ? execSync(['npx', ...args.map(a => (/\s|\*/.test(a) ? `"${a}"` : a))].join(' '), { encoding: 'utf8', maxBuffer: 1 << 28 })
    : execFileSync('npx', args, { encoding: 'utf8', maxBuffer: 1 << 28 });
  return JSON.parse(out)[0].results as any[];
};
const d1 = { trips: q('trips'), trip_members: q('trip_members'), expenses: q('expenses'), expense_splits: q('expense_splits'), payments: q('payments') };
const rates = JSON.parse(readFileSync(values.rates, 'utf8'));
const orig = balancesFromSupabase(src, rates, values.today);
const mine = balancesFromD1(d1, rates, values.today);
const names = new Map(src.trip_members.map(m => [m.id, m.name]));
for (const t of src.trips) {
  console.log(`\n${t.name}  (${t.base_currency}, total spend ${orig[t.id].totalSpend.toFixed(2)})`);
  for (const [m, v] of Object.entries(orig[t.id].balances)) console.log(`  ${(names.get(m) ?? m).padEnd(16)} original ${v.toFixed(2).padStart(10)}   d1 ${(mine[t.id]?.balances[m] ?? NaN).toFixed(2).padStart(10)}`);
}
const diffs = compareBalances(orig, mine);
console.log(diffs.length ? `\nMISMATCH in ${diffs.length} place(s):\n${JSON.stringify(diffs, null, 2)}` : '\nAll trips and members match to the cent.');
process.exit(diffs.length ? 1 : 0);
