// Shared helpers (errors, json, ids, hashing, readJson) live in core/. The validators below are SplitTrip's own.
import { bad } from '../core';
import { CURRENCIES } from './currencies';
export * from '../core/util';

export function str(v: unknown, field: string, max: number, opts: { optional?: boolean } = {}): string {
  if (v === undefined || v === null || v === '') {
    if (opts.optional) return '';
    throw bad('invalid_' + field);
  }
  if (typeof v !== 'string') throw bad('invalid_' + field);
  const t = v.trim();
  if (!t && !opts.optional) throw bad('invalid_' + field);
  if (t.length > max) throw bad('invalid_' + field);
  return t;
}

export function email(v: unknown, field = 'email'): string | null {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string') throw bad('invalid_' + field);
  const t = v.trim().toLowerCase();
  if (t.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t)) throw bad('invalid_' + field);
  return t;
}

export const currency = (v: unknown, field = 'currency'): string => {
  if (typeof v !== 'string' || !CURRENCIES.includes(v)) throw bad('invalid_' + field);
  return v;
};

export const isoDate = (v: unknown): string => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw bad('invalid_date');
  const d = new Date(v + 'T00:00:00Z');
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) throw bad('invalid_date');
  return v;
};

export const version = (v: unknown): number => {
  if (!Number.isInteger(v) || (v as number) < 1) throw bad('invalid_version');
  return v as number;
};
