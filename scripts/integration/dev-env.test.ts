import { describe, expect, test } from 'bun:test';
import { devEnv } from './dev-env.ts';

const paths = { home: '/x/home', data: '/x/data', tmp: '/x/tmp' };

describe('the dev:local environment', () => {
  test('inherits nothing it was not told to', () => {
    const env = devEnv({ PATH: '/bin', OPENAI_API_KEY: 'sk-secret', JARVIS_HOME: '/real/home', JARVIS_DASHBOARD: 'rooms' }, paths, 3143);
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.JARVIS_DASHBOARD).toBeUndefined();
    expect(env.JARVIS_HOME).toBe('/x/data');
    expect(env.HOME).toBe('/x/home');
    expect(env.JARVIS_PUBLIC_URL).toBe('http://localhost:3143');
    expect(env.JARVIS_LOCAL_INTEGRATION).toBe('1');
  });

  test('leaves the notch off unless asked', () => {
    expect('JARVIS_NOTCH' in devEnv({ PATH: '/bin' }, paths, 3143)).toBe(false);
    expect('JARVIS_NOTCH' in devEnv({ PATH: '/bin', JARVIS_NOTCH: 'true' }, paths, 3143)).toBe(false);
    expect('JARVIS_NOTCH' in devEnv({ PATH: '/bin', JARVIS_NOTCH: '0' }, paths, 3143)).toBe(false);
  });

  // Fails if the passthrough line is removed: the launcher builds its
  // environment from scratch, so without it scripts/notch/try.sh could never
  // turn the notch on.
  test('carries the notch switch across when it is exactly "1"', () => {
    expect(devEnv({ PATH: '/bin', JARVIS_NOTCH: '1' }, paths, 3143).JARVIS_NOTCH).toBe('1');
  });

  // The demo secret travels with the switch and never without it.
  test('carries the notch demo secret only together with the switch', () => {
    const secret = 'a-secret-of-sixteen-or-more';
    expect(devEnv({ PATH: '/bin', JARVIS_NOTCH: '1', JARVIS_NOTCH_DEMO: secret }, paths, 3143).JARVIS_NOTCH_DEMO).toBe(secret);
    expect('JARVIS_NOTCH_DEMO' in devEnv({ PATH: '/bin', JARVIS_NOTCH_DEMO: secret }, paths, 3143)).toBe(false);
    expect('JARVIS_NOTCH_DEMO' in devEnv({ PATH: '/bin', JARVIS_NOTCH: '1' }, paths, 3143)).toBe(false);
  });
});
