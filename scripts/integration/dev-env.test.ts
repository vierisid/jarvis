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

  // The first try at an organisation with a second person, 20 November 2026:
  // "JARVIS_PEERS_ENGINE=... scripts/notch/try.sh" started a brain with no
  // engine and no row to make an organisation with, because the launcher
  // builds its environment from scratch and the name was not in it.
  test('carries the place of the peers engine across, with the notch on and only as a path from the root', () => {
    const engine = '/opt/collab/collab-claude';
    expect(devEnv({ PATH: '/bin', JARVIS_NOTCH: '1', JARVIS_PEERS_ENGINE: engine }, paths, 3143).JARVIS_PEERS_ENGINE).toBe(engine);
    expect(devEnv({ PATH: '/bin', JARVIS_NOTCH: '1', JARVIS_PEERS_ENGINE: `  ${engine} ` }, paths, 3143).JARVIS_PEERS_ENGINE).toBe(engine);
    // Without the notch nothing would show what it asks.
    expect('JARVIS_PEERS_ENGINE' in devEnv({ PATH: '/bin', JARVIS_PEERS_ENGINE: engine }, paths, 3143)).toBe(false);
    // What gets run must not depend on the folder the launcher was started in.
    expect('JARVIS_PEERS_ENGINE' in devEnv({ PATH: '/bin', JARVIS_NOTCH: '1', JARVIS_PEERS_ENGINE: 'collab-claude' }, paths, 3143)).toBe(false);
    expect('JARVIS_PEERS_ENGINE' in devEnv({ PATH: '/bin', JARVIS_NOTCH: '1', JARVIS_PEERS_ENGINE: '' }, paths, 3143)).toBe(false);
  });

  test('what the engine may be given from outside travels with it, and never without it', () => {
    const given = { COLLAB_SERVER_URL: 'https://collab.example', COLLAB_DEVICE_NAME: 'Desk', XDG_RUNTIME_DIR: '/run/user/1000', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' };
    const withEngine = devEnv({ PATH: '/bin', JARVIS_NOTCH: '1', JARVIS_PEERS_ENGINE: '/opt/collab/collab-claude', ...given, COLLAB_UNATTENDED_TASKS: '1' }, paths, 3143);
    for (const [key, value] of Object.entries(given)) expect(withEngine[key]).toBe(value);
    // A setting of the engine's that is not the person's to make is not carried.
    expect('COLLAB_UNATTENDED_TASKS' in withEngine).toBe(false);
    const without = devEnv({ PATH: '/bin', JARVIS_NOTCH: '1', ...given }, paths, 3143);
    for (const key of Object.keys(given)) expect(key in without).toBe(false);
  });
  test('carries the switch with no engine yet, and the engine\'s source, with the notch on only', () => {
    const on = devEnv({ PATH: '/bin', JARVIS_NOTCH: '1', JARVIS_PEERS: '1', JARVIS_PEERS_SOURCE: ' /home/sam/collab ', COLLAB_KEYSTORE: 'file' }, paths, 3143);
    expect(on.JARVIS_PEERS).toBe('1');
    expect(on.JARVIS_PEERS_SOURCE).toBe('/home/sam/collab');
    expect(on.COLLAB_KEYSTORE).toBe('file');
    // By exactly "1", and a path from the root.
    const loose = devEnv({ PATH: '/bin', JARVIS_NOTCH: '1', JARVIS_PEERS: 'yes', JARVIS_PEERS_SOURCE: 'collab', COLLAB_KEYSTORE: 'file' }, paths, 3143);
    expect('JARVIS_PEERS' in loose).toBe(false);
    expect('JARVIS_PEERS_SOURCE' in loose).toBe(false);
    expect('COLLAB_KEYSTORE' in loose).toBe(false);
    const dark = devEnv({ PATH: '/bin', JARVIS_PEERS: '1', JARVIS_PEERS_SOURCE: '/home/sam/collab' }, paths, 3143);
    expect('JARVIS_PEERS' in dark).toBe(false);
    expect('JARVIS_PEERS_SOURCE' in dark).toBe(false);
  });
});
