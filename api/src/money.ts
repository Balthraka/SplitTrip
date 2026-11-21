import { bad } from './util';

export const MAX_CENTS = 10_000_000_000_000; // 1e13 minor units, well inside 2^53

/** API money is always an integer count of 1/100 of the currency unit (VND included, so 1,188,000 VND = 118800000). */
export function cents(v: unknown, field = 'amount_cents', opts: { allowZero?: boolean } = {}): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) throw bad('invalid_' + field);
  if (v < (opts.allowZero ? 0 : 1) || v > MAX_CENTS) throw bad('invalid_' + field);
  return v;
}

export { parseCents } from './cents';
