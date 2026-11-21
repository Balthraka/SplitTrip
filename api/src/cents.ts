/**
 * Exact decimal-string -> integer cents, no floats. Used by the importer.
 * "29.18" -> 2918, "125000.00" -> 12500000, "5" -> 500. Rejects more than 2 decimals.
 * (No imports on purpose: scripts run it directly under node.)
 */
export function parseCents(s: string): number {
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(s.trim());
  if (!m) throw new Error(`not a 2dp decimal: ${JSON.stringify(s)}`);
  const n = Number(m[2]) * 100 + Number((m[3] ?? '').padEnd(2, '0'));
  return m[1] ? -n : n;
}
