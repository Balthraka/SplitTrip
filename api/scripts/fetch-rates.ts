// Usage: npx tsx scripts/fetch-rates.ts --dir <csv folder> [--out rates.json]
// Fetches, from the same public API the live app uses, every (currency, date) rate the export needs, and freezes them in one file
// so the "original vs D1" balance comparison uses identical rates on both sides. Run it from your own computer (needs the internet).
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { parseCsv } from './csv.ts';

const { values } = parseArgs({ options: { dir: { type: 'string' }, out: { type: 'string', default: 'rates.json' } } });
if (!values.dir) throw new Error('need --dir');
const dir: string = values.dir;
const read = (suffix: string) => parseCsv(readFileSync(join(dir, readdirSync(dir).find(f => f.endsWith(suffix))!), 'utf8'));
const trips = read('trips_rows.csv'), expenses = read('expenses_rows.csv'), payments = read('payments_rows.csv');
const base = new Map(trips.map(t => [t.id, t.base_currency]));
const today = new Date().toISOString().split('T')[0];
const need = new Set<string>();
for (const e of expenses) if (e.currency !== base.get(e.trip_id)) need.add(`${e.currency.toLowerCase()}@${e.date >= today ? 'latest' : e.date}`);
for (const p of payments) if (p.status === 'confirmed' && p.currency !== base.get(p.trip_id)) {
  const d = p.confirmed_at.split(' ')[0]; need.add(`${p.currency.toLowerCase()}@${d >= today ? 'latest' : d}`);
}
const table: Record<string, Record<string, number>> = {};
for (const key of need) {
  const [from, date] = key.split('@');
  const res = await fetch(`https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${date}/v1/currencies/${from}.json`);
  if (!res.ok) throw new Error(`rate API ${res.status} for ${key}`);
  table[key] = ((await res.json()) as any)[from];
  console.log('fetched', key);
}
writeFileSync(values.out!, JSON.stringify(table));
console.log(`wrote ${Object.keys(table).length} rate sets to ${values.out} (keep this file out of git)`);
