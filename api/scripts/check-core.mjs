#!/usr/bin/env node
// Checks that the core/ folders of two or more apps are identical, file by file, by SHA-256 hash.
//
//   node scripts/check-core.mjs ../packr-api ../splittrip-api ../mycellar-api
//   node scripts/check-core.mjs --with-tests ../splittrip-api ../other-app
//
// Each argument is an app folder (its core/ subfolder is compared) or a core folder itself.
// core/test/ (the core's own vitest tests) is skipped unless --with-tests is given: the tests live in one app (SplitTrip),
// and the other apps only need the code.
// Exit code 0 = all identical, 1 = a difference (listed), 2 = bad usage.
// Line endings are ignored (CRLF is treated as LF), so a Windows checkout does not cause a false alarm.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';

const SKIP = new Set(['node_modules', '.git', '.DS_Store', '.wrangler']);

/** Every file under `dir`, as relative paths with forward slashes. */
function walk(dir, base = dir, out = [], withTests = false) {
  for (const name of readdirSync(dir).sort()) {
    if (SKIP.has(name)) continue;
    if (!withTests && dir === base && name === 'test') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, base, out, withTests);
    else out.push(relative(base, full).split('\\').join('/'));
  }
  return out;
}

const hash = (file) => createHash('sha256').update(readFileSync(file, 'utf8').replace(/\r\n/g, '\n')).digest('hex');

/** @returns {Map<string, string>} relative path -> hash */
function hashesOf(coreDir, withTests) {
  return new Map(walk(coreDir, coreDir, [], withTests).map(f => [f, hash(join(coreDir, f))]));
}

export function compareCores(folders, { withTests = false } = {}) {
  const cores = folders.map(f => {
    const p = resolve(f);
    const core = existsSync(join(p, 'core')) ? join(p, 'core') : (basename(p) === 'core' && existsSync(p) ? p : null);
    if (!core) throw new Error(`no core/ folder in ${f}`);
    return { label: f, hashes: hashesOf(core, withTests) };
  });
  const names = [...new Set(cores.flatMap(c => [...c.hashes.keys()]))].sort();
  const problems = [];
  for (const name of names) {
    const missing = cores.filter(c => !c.hashes.has(name)).map(c => c.label);
    if (missing.length) { problems.push(`${name}: missing in ${missing.join(', ')}`); continue; }
    const distinct = new Set(cores.map(c => c.hashes.get(name)));
    if (distinct.size > 1) problems.push(`${name}: differs (${cores.map(c => `${c.label} ${c.hashes.get(name).slice(0, 8)}`).join(' | ')})`);
  }
  return { problems, files: names.length };
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('check-core.mjs')) {
  const args = process.argv.slice(2);
  const withTests = args.includes('--with-tests');
  const folders = args.filter(a => a !== '--with-tests');
  if (folders.length < 2) { console.error('usage: node scripts/check-core.mjs [--with-tests] <app-folder> <app-folder> [...]'); process.exit(2); }
  try {
    const { problems, files } = compareCores(folders, { withTests });
    if (problems.length) { console.error(`core/ folders DIFFER (${problems.length} problem${problems.length > 1 ? 's' : ''}):`); for (const p of problems) console.error('  ' + p); process.exit(1); }
    console.log(`OK: ${files} files, identical in ${folders.length} folders`);
  } catch (e) { console.error(String(e.message ?? e)); process.exit(2); }
}
