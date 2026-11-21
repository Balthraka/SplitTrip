// Builds the CSS a run-time compiler would produce: every class present in the DOM the browser really rendered (all screens and states).
import { readFileSync, writeFileSync } from 'node:fs';
import { buildCss } from '/home/claude/splittrip-api/scripts/build-css.mjs';
const extra = readFileSync(process.argv[2], 'utf8');
const html = readFileSync('/home/claude/splittrip-api/web/index.html', 'utf8');
const css = buildCss(html, extra);
writeFileSync(process.argv[3], css);
const shipped = html.match(/<style>(@tailwind|\*,|[^<]*?)<\/style>\s*<!-- tailwind:end/)[0];
console.log('runtime CSS bytes', css.length);
const rules = s => new Set(s.replace(/\/\*[\s\S]*?\*\//g, '').split('}').map(x => x.trim()).filter(Boolean));
const have = rules(html.slice(html.indexOf('<!-- tailwind:start'), html.indexOf('<!-- tailwind:end')).replace(/^[\s\S]*?<style>/, '').replace(/<\/style>[\s\S]*$/, ''));
const want = rules(css);
const missing = [...want].filter(r => !have.has(r));
console.log('rules in a runtime build but missing from the shipped CSS:', missing.length); missing.slice(0, 30).forEach(r => console.log('  ' + r.slice(0, 120)));
