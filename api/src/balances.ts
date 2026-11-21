/**
 * Per-member net balance for one trip, a line-for-line port of the live app's computeSettlements (index.html),
 * with the exchange-rate lookup made a plain function so the same maths can run on the Supabase export and on D1.
 * Amounts are in major units (the old numeric values, or cents / 100 for D1) and are accumulated in the same
 * order with the same float operations, so rounding is identical to what users see today.
 */
export interface BExpense { currency: string; date: string; paid_by_member_id: string; amount: number; splits: { member_id: string; amount: number }[]; }
export interface BPayment { currency: string; from_member_id: string; to_member_id: string; amount: number; confirmed_at: string | null; }
export type RateFn = (from: string, to: string, date: string) => number;

export function computeBalances(
  expenses: BExpense[], memberIds: string[], baseCurrency: string, confirmedPayments: BPayment[],
  rate: RateFn, today = new Date().toISOString().split('T')[0],
) {
  const balances: Record<string, number> = {};
  memberIds.forEach(id => { balances[id] = 0; });
  let totalSpend = 0;
  for (const exp of expenses) {
    const r = rate(exp.currency, baseCurrency, exp.date);
    totalSpend += exp.amount * r;
    if (balances[exp.paid_by_member_id] !== undefined) balances[exp.paid_by_member_id] += exp.amount * r;
    for (const s of exp.splits) if (balances[s.member_id] !== undefined) balances[s.member_id] -= s.amount * r;
  }
  for (const p of confirmedPayments) {
    let r = 1;
    if (p.currency !== baseCurrency) {
      try { r = rate(p.currency, baseCurrency, p.confirmed_at ? p.confirmed_at.split('T')[0] : today); } catch { /* rate 1, as today */ }
    }
    const converted = p.amount * r;
    if (balances[p.from_member_id] !== undefined) balances[p.from_member_id] += converted;
    if (balances[p.to_member_id] !== undefined) balances[p.to_member_id] -= converted;
  }
  Object.keys(balances).forEach(k => { balances[k] = Math.round(balances[k] * 100) / 100; });
  totalSpend = Math.round(totalSpend * 100) / 100;
  return { balances, totalSpend };
}

/** Rate lookup over a frozen table shaped like the app's _ratesCache: { "vnd@2026-06-14": { aud: 0.0000586, ... } }. */
export function frozenRates(table: Record<string, Record<string, number>>, today = new Date().toISOString().split('T')[0]): RateFn {
  return (from, to, date) => {
    if (from === to) return 1;
    const apiDate = date >= today ? 'latest' : date;
    const rate = table[`${from.toLowerCase()}@${apiDate}`]?.[to.toLowerCase()];
    if (!rate) throw new Error(`No rate found for ${from}->${to} on ${apiDate}`);
    return rate;
  };
}
