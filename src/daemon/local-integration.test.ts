import { expect, test } from 'bun:test';
import { DEFAULT_CONFIG } from '../config/types';
import { localIntegrationEnabled } from './local-integration';
import { stripDaemonSecrets } from '../util/model-exec-env';
const env = { HOME: '/tmp/local-acceptance/home', JARVIS_HOME: '/tmp/local-acceptance/data', JARVIS_LOCAL_INTEGRATION: '1' };
function config() { const c = structuredClone(DEFAULT_CONFIG); c.daemon.data_dir = env.JARVIS_HOME; c.daemon.db_path = env.JARVIS_HOME + '/jarvis.db'; c.daemon.port = 3143; c.daemon.public_url = 'http://localhost:3143'; return c; }
test('ordinary startup never authorizes local integration', () => { expect(localIntegrationEnabled(DEFAULT_CONFIG, {})).toBe(false); });
test('explicit isolated self-hosted local mode is accepted', () => { expect(localIntegrationEnabled(config(), env)).toBe(true); });
test('local mode refuses a normal HOME, different vault and hosted/public/open access', () => {
  expect(() => localIntegrationEnabled(config(), { ...env, HOME: '/home/user' })).toThrow();
  for (const mutate of [(c: ReturnType<typeof config>) => { c.daemon.db_path = '/home/user/.jarvis/jarvis.db'; },
    (c: ReturnType<typeof config>) => { c.daemon.public_url = 'https://example.com'; },
    (c: ReturnType<typeof config>) => { c.auth = { insecure_open_access: true }; },
    (c: ReturnType<typeof config>) => { c.daemon.listen = 'unix:/tmp/brain.sock'; }]) {
    const c = config(); mutate(c); expect(() => localIntegrationEnabled(c, env)).toThrow();
  }
});
test('model-directed children cannot inherit local integration authorization', () => { expect(stripDaemonSecrets(env).JARVIS_LOCAL_INTEGRATION).toBeUndefined(); });
test('bun run dev stays the hot-reload daemon; only dev:local starts the local integration', async () => {
  const root = new URL('../../', import.meta.url);
  const { scripts } = await Bun.file(new URL('package.json', root)).json();
  expect(scripts.dev).toBe('bun --hot run src/daemon/index.ts');
  expect(scripts['dev:local']).toBe('bun --no-env-file run scripts/integration/dev.ts');
  expect(Object.values(scripts).filter(command => String(command).includes('scripts/integration/dev.ts'))).toHaveLength(1);
  expect(await Bun.file(new URL('README.md', root)).text()).toContain('bun run dev             # Hot-reload daemon');
});
