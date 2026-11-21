import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const script = join(__dirname, '../scripts/check-core.mjs');
const run = (...dirs: string[]) => spawnSync('node', [script, ...dirs], { encoding: 'utf8' });
const runWithTests = (...dirs: string[]) => spawnSync('node', [script, '--with-tests', ...dirs], { encoding: 'utf8' });
const make = (files: Record<string, string>) => {
  const d = mkdtempSync(join(tmpdir(), 'cc-'));
  for (const [f, c] of Object.entries(files)) { mkdirSync(join(d, 'core', f, '..'), { recursive: true }); writeFileSync(join(d, 'core', f), c); }
  return d;
};
const base = { 'app.js': 'a\n', 'util.js': 'b\n', 'test/x.test.ts': 't\n' };

describe('scripts/check-core.mjs', () => {
  it('passes when the core folders are identical, and works on the real core compared with a copy of itself', () => {
    const a = make(base), b = make(base);
    const r = run(a, b); expect(r.status).toBe(0); expect(r.stdout).toContain('OK: 2 files');          // core/test is skipped by default
    expect(runWithTests(a, b).stdout).toContain('OK: 3 files');
    const copy = mkdtempSync(join(tmpdir(), 'cc-')); cpSync(join(__dirname, '../core'), join(copy, 'core'), { recursive: true });
    expect(run(join(__dirname, '..'), copy, a.replace(/^/, '')).status).toBe(1);      // a is not the real core
    expect(run(join(__dirname, '..'), copy).status).toBe(0);
    for (const d of [a, b, copy]) rmSync(d, { recursive: true });
  });
  it('fails and names the file when one byte differs, when a file is missing or extra, and with three folders', () => {
    const a = make(base), b = make({ ...base, 'util.js': 'B\n' }), c = make({ 'app.js': 'a\n', 'util.js': 'b\n' }), d = make({ ...base, 'extra.js': 'x' });
    let r = run(a, b); expect(r.status).toBe(1); expect(r.stderr).toContain('util.js: differs');
    expect(run(a, c).status).toBe(0);                                                          // tests ignored by default
    r = runWithTests(a, c); expect(r.status).toBe(1); expect(r.stderr).toContain('test/x.test.ts: missing in');
    r = run(a, d); expect(r.status).toBe(1); expect(r.stderr).toContain('extra.js: missing in');
    r = run(a, a, b); expect(r.status).toBe(1);
    for (const x of [a, b, c, d]) rmSync(x, { recursive: true });
  });
  it('ignores line-ending differences (a Windows checkout is not a difference)', () => {
    const a = make({ 'app.js': 'one\ntwo\n' }), b = make({ 'app.js': 'one\r\ntwo\r\n' });
    expect(run(a, b).status).toBe(0);
    rmSync(a, { recursive: true }); rmSync(b, { recursive: true });
  });
  it('bad usage: fewer than two folders, or a folder with no core/', () => {
    const a = make(base);
    expect(run(a).status).toBe(2);
    expect(run(a, tmpdir()).status).toBe(2);
    rmSync(a, { recursive: true });
  });
});
