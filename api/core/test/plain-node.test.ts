import { describe, expect, it } from 'vitest';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const core = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('the core runs in plain Node (the other apps run their tests without TypeScript)', () => {
  it('core/ holds only JavaScript (tests aside), and it loads and answers requests with no TypeScript tooling', () => {
    const files = readdirSync(core).filter(f => !['test'].includes(f));
    expect(files.filter(f => f.endsWith('.ts'))).toEqual([]);
    const code = `
      import { createApp, publicGuard, userGuard, json } from ${JSON.stringify(join(core, 'index.js'))};
      const app = createApp({ routes: [{ method: 'GET', path: '/open', guard: 'public', handler: async () => json({ ok: true }) },
                                       { method: 'GET', path: '/me', guard: 'user', handler: async () => json({}) }],
                              guards: { public: publicGuard, user: userGuard } });
      const env = { DB: null, ALLOWED_ORIGINS: 'https://a.example.com' };
      const s = [];
      s.push((await app.handle(new Request('https://x.test/open'), env)).status);
      s.push((await app.handle(new Request('https://x.test/open', { headers: { origin: 'https://evil.example.com' } }), env)).status);
      s.push((await app.handle(new Request('https://x.test/%'), env)).status);
      s.push((await app.handle(new Request('https://x.test/me'), env)).status);
      console.log(s.join(','));`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.stdout.trim()).toBe('200,403,404,401');
  });
});
