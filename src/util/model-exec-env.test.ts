/**
 * The rule behind modelExecEnv() (#514). What each call site actually hands
 * its child is asserted per site in src/model-exec-env-sites.test.ts; this
 * file pins the rule itself, and that every JARVIS_ name in the source is
 * classified.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';
import {
  DAEMON_SECRET_ENV_NAMES,
  JARVIS_INTERNAL_ENV_NAMES,
  JARVIS_SETTINGS_ENV_NAMES,
  isDaemonSecretEnvName,
  modelExecEnv,
  stripDaemonSecrets,
} from './model-exec-env.ts';
import { MODEL_EXEC_MARKER_ENV, isModelExecProcess, modelExecDaemonWarning } from './model-exec-marker.ts';

const SENTINEL = 'sentinel-do-not-log';

/**
 * What a user's shell and desktop carry and these children must keep. Includes
 * the user's OWN credentials (GITHUB_TOKEN, AWS_*, NPM_TOKEN), forwarded by
 * decision -- see the model-exec-env.ts header -- and the names the generic
 * secret-shaped patterns would wrongly catch (XAUTHORITY, SSH_AUTH_SOCK,
 * GNOME_KEYRING_CONTROL).
 */
const USER_ENV: Record<string, string> = {
  PATH: '/home/u/.nvm/versions/node/v22/bin:/home/u/venv/bin:/usr/bin',
  HOME: '/home/u',
  SHELL: '/bin/zsh',
  LANG: 'en_US.UTF-8',
  LC_ALL: 'en_US.UTF-8',
  TERM: 'xterm-256color',
  SSH_AUTH_SOCK: '/run/user/1000/ssh-agent.socket',
  DISPLAY: ':0',
  WAYLAND_DISPLAY: 'wayland-0',
  XAUTHORITY: '/run/user/1000/xauth',
  XDG_RUNTIME_DIR: '/run/user/1000',
  XDG_SESSION_TYPE: 'wayland',
  DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
  GNOME_KEYRING_CONTROL: '/run/user/1000/keyring',
  VIRTUAL_ENV: '/home/u/venv',
  NVM_DIR: '/home/u/.nvm',
  HTTPS_PROXY: 'http://proxy:3128',
  NODE_EXTRA_CA_CERTS: '/etc/ssl/corp.pem',
  WSL_INTEROP: '/run/WSL/1_interop',
  WSLENV: 'USERPROFILE/p',
  GITHUB_TOKEN: 'users-own-token',
  AWS_PROFILE: 'dev',
  AWS_SECRET_ACCESS_KEY: 'users-own-aws',
  NPM_TOKEN: 'users-own-npm',
  MY_PROJECT_SETTING: 'custom',
  JARVIS_HOME: '/srv/jarvis',
  JARVIS_PORT: '3142',
  JARVIS_SECRETS_DIR: '/srv/jarvis-secrets',
  JARVIS_WORKFLOW_ENCRYPTION_KEY_FILE: '/run/secrets/wf.key',
  JARVIS_REQUIRE_ENCRYPTED_CREDENTIALS: '1',
};

describe('the daemon-secret rule', () => {
  test('every listed daemon secret is stripped, in any case', () => {
    for (const name of DAEMON_SECRET_ENV_NAMES) {
      expect({ name, stripped: isDaemonSecretEnvName(name) }).toEqual({ name, stripped: true });
      expect({ name, stripped: isDaemonSecretEnvName(name.toLowerCase()) }).toEqual({ name, stripped: true });
    }
    // Windows spells them as it likes, and so does a user.
    expect(isDaemonSecretEnvName('Jarvis_GitHub_Token')).toBe(true);
    expect(isDaemonSecretEnvName('anthropic_api_key')).toBe(true);
  });

  test('the sources the header cites are the names on the list', () => {
    // Pinned: widening or narrowing it is a reviewed edit to this line.
    expect([...DAEMON_SECRET_ENV_NAMES].sort()).toEqual([
      'ANTHROPIC_API_KEY', 'JARVIS_API_KEY', 'JARVIS_DEBUG_RPC', 'JARVIS_GITHUB_TOKEN',
      'JARVIS_GROQ_KEY', 'JARVIS_LITELLM_KEY', 'JARVIS_OPENAI_KEY', 'JARVIS_OPENROUTER_KEY',
      'JARVIS_WORKFLOW_ENCRYPTION_KEY', 'NVIDIA_API_KEY', 'OPENAI_API_KEY',
    ]);
  });

  test('an unclassified JARVIS_ name is stripped: a future secret fails closed', () => {
    // None of these matches a secret-shaped pattern; the namespace rule is
    // what catches them. JARVIS_DEBUG_RPC is the real one of the kind.
    for (const name of ['JARVIS_DEBUG_RPC', 'JARVIS_SIGNING_SALT', 'JARVIS_BRIDGE_PWD', 'JARVIS_DB_DSN', 'JARVIS_NEW_SETTING']) {
      expect({ name, stripped: isDaemonSecretEnvName(name) }).toEqual({ name, stripped: true });
    }
  });

  test('settings stay, and no daemon secret is on the settings list', () => {
    for (const name of JARVIS_SETTINGS_ENV_NAMES) {
      expect({ name, stripped: isDaemonSecretEnvName(name) }).toEqual({ name, stripped: false });
      expect(DAEMON_SECRET_ENV_NAMES).not.toContain(name);
    }
  });

  test('the engine wiring names are known, internal, and stripped', () => {
    for (const name of JARVIS_INTERNAL_ENV_NAMES) {
      expect({ name, stripped: isDaemonSecretEnvName(name) }).toEqual({ name, stripped: true });
      expect(JARVIS_SETTINGS_ENV_NAMES).not.toContain(name);
      expect(DAEMON_SECRET_ENV_NAMES).not.toContain(name);
    }
  });

  test("the user's shell and desktop survive whole, their own credentials included", () => {
    expect(stripDaemonSecrets(USER_ENV)).toEqual(USER_ENV);
  });

  test('stripping removes exactly the daemon secrets and nothing else', () => {
    const secrets = Object.fromEntries(
      [...DAEMON_SECRET_ENV_NAMES, 'JARVIS_FUTURE_TOKEN', 'jarvis_github_token'].map(n => [n, SENTINEL]),
    );
    const out = stripDaemonSecrets({ ...USER_ENV, ...secrets, UNSET: undefined });
    expect(out).toEqual(USER_ENV);
  });
});

describe('modelExecEnv()', () => {
  test('marks the child JARVIS_MODEL_EXEC=1, and no extra can take the mark off', () => {
    expect(modelExecEnv()[MODEL_EXEC_MARKER_ENV]).toBe('1');
    expect(modelExecEnv({ [MODEL_EXEC_MARKER_ENV]: undefined })[MODEL_EXEC_MARKER_ENV]).toBe('1');
    expect(modelExecEnv({ [MODEL_EXEC_MARKER_ENV]: '0' })[MODEL_EXEC_MARKER_ENV]).toBe('1');
    // A setting, so a grandchild started by that child keeps it too.
    expect(isDaemonSecretEnvName(MODEL_EXEC_MARKER_ENV)).toBe(false);
  });

  test('an extra cannot put a daemon secret back, nor can a spread of process.env', () => {
    const had = process.env.JARVIS_GITHUB_TOKEN;
    process.env.JARVIS_GITHUB_TOKEN = SENTINEL;
    try {
      const env = modelExecEnv({ ...process.env, ANTHROPIC_API_KEY: SENTINEL, FOO: 'bar' });
      expect(env.JARVIS_GITHUB_TOKEN).toBeUndefined();
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.FOO).toBe('bar');
      expect(env.PATH).toBe(process.env.PATH!);
    } finally {
      if (had === undefined) delete process.env.JARVIS_GITHUB_TOKEN;
      else process.env.JARVIS_GITHUB_TOKEN = had;
    }
  });

  test('an undefined extra removes the key; the result is always an object', () => {
    expect(modelExecEnv({ PATH: undefined }).PATH).toBeUndefined();
    expect(typeof modelExecEnv()).toBe('object');
  });
});

// ---------------------------------------------------------------------------
// Every JARVIS_ name the source uses is classified
// ---------------------------------------------------------------------------

const SRC = join(import.meta.dir, '..');
const ROOT = join(SRC, '..');

/** Non-test sources under src/, bin/ and scripts/, minus installed and built trees. */
function sources(): string[] {
  const out: string[] = [];
  for (const dir of ['src', 'bin', 'scripts']) {
    for (const p of new Bun.Glob('**/*.{ts,tsx,mts,cts,js,mjs,cjs}').scanSync({ cwd: join(ROOT, dir), onlyFiles: true })) {
      const parts = p.split(sep);
      if (parts.some(d => d === 'node_modules' || d === 'dist')) continue;
      if (/\.test\.[cm]?[jt]sx?$/.test(p)) continue;
      out.push(join(ROOT, dir, p));
    }
  }
  return out;
}

/**
 * JARVIS_ names used as env names, found on the AST so that prose in comments
 * (`a future JARVIS_FOO_KEY`) is not mistaken for code:
 *   - a string or no-substitution template literal that is exactly a name
 *     ("JARVIS_X", env['JARVIS_X'], a constant like DEBUG_RPC_ENV);
 *   - a member access on something called env: process.env.X, env?.X, Bun.env.X;
 *   - a destructured binding: const { JARVIS_X } = process.env.
 * Identifiers that merely start with JARVIS_ (a TS constant like JARVIS_DIR)
 * are not env names. A literal ending in `_` is a prefix
 * (engine-runtime/spawn.ts), not a name. A name this misses fails closed:
 * stripped, not leaked.
 */
const NAME = /^JARVIS_[A-Za-z0-9_]*[A-Za-z0-9]$/;

function jarvisEnvNames(): Map<string, string> {
  const found = new Map<string, string>();
  for (const file of sources()) {
    const text = readFileSync(file, 'utf8');
    if (!text.includes('JARVIS_')) continue;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const add = (name: string) => {
      if (NAME.test(name) && !found.has(name.toUpperCase())) found.set(name.toUpperCase(), relative(ROOT, file));
    };
    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) add(node.text);
      if (ts.isPropertyAccessExpression(node)) {
        const obj = node.expression;
        const objName = ts.isIdentifier(obj) ? obj.text : ts.isPropertyAccessExpression(obj) ? obj.name.text : '';
        if (objName === 'env') add(node.name.text);
      }
      if (ts.isBindingElement(node)) {
        const key = node.propertyName ?? node.name;
        if (ts.isIdentifier(key)) add(key.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return found;
}

describe('every JARVIS_ env name in src/, bin/ and scripts/ is classified', () => {
  const names = jarvisEnvNames();

  test('the scan sees the names it must (not blind)', () => {
    // One per form: property access, bracket literal, a constant holding the
    // name, and a literal in scripts/.
    for (const name of ['JARVIS_HOME', 'JARVIS_WORKFLOW_ENCRYPTION_KEY', 'JARVIS_GITHUB_TOKEN', 'JARVIS_DEBUG_RPC', 'JARVIS_ENGINE_MARKER', 'JARVIS_OPENAI_KEY']) {
      expect({ name, seen: names.has(name) }).toEqual({ name, seen: true });
    }
  });

  test('each is either a daemon secret or a listed setting', () => {
    // If this fails you added a JARVIS_ variable. It is stripped from
    // run_command, launched apps and the browser until classified: add it to
    // JARVIS_SETTINGS_ENV_NAMES in util/model-exec-env.ts if a `jarvis` CLI
    // run from the model's shell needs it, to DAEMON_SECRET_ENV_NAMES if it
    // holds a secret, or to JARVIS_INTERNAL_ENV_NAMES if the daemon only sets
    // it on processes it starts itself.
    const known = new Set([...DAEMON_SECRET_ENV_NAMES, ...JARVIS_SETTINGS_ENV_NAMES, ...JARVIS_INTERNAL_ENV_NAMES]);
    const unclassified = [...names].filter(([n]) => !known.has(n)).map(([n, f]) => `${n} (${f})`);
    expect(unclassified).toEqual([]);
  });

  test('the three buckets do not overlap', () => {
    const all = [...DAEMON_SECRET_ENV_NAMES, ...JARVIS_SETTINGS_ENV_NAMES, ...JARVIS_INTERNAL_ENV_NAMES];
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('the model-exec marker (#514)', () => {
  test('is recognised only as exactly "1"', () => {
    expect(isModelExecProcess({ [MODEL_EXEC_MARKER_ENV]: '1' })).toBe(true);
    for (const v of [undefined, '', '0', 'true']) {
      expect({ v, marked: isModelExecProcess({ [MODEL_EXEC_MARKER_ENV]: v }) }).toEqual({ v, marked: false });
    }
  });

  test('no warning on the normal path: a daemon the user or a service manager starts', () => {
    expect(modelExecDaemonWarning({})).toBeNull();
    expect(modelExecDaemonWarning({}, 'cli')).toBeNull();
  });

  test('under the marker, the daemon and the CLI name what is missing', () => {
    const env = { [MODEL_EXEC_MARKER_ENV]: '1' };
    for (const text of [modelExecDaemonWarning(env)!, modelExecDaemonWarning(env, 'cli')!]) {
      expect(text).toContain('JARVIS_WORKFLOW_ENCRYPTION_KEY');
      expect(text).toContain('JARVIS_GITHUB_TOKEN');
    }
    // The CLI cannot tell whether a service manager does the restart.
    expect(modelExecDaemonWarning(env, 'cli')).toContain('systemd or launchd is unaffected');
  });

  test('names only what is actually missing, and is silent when nothing is', () => {
    // Passed inside the command, or re-exported by the shell's rc.
    const withKey = { [MODEL_EXEC_MARKER_ENV]: '1', JARVIS_WORKFLOW_ENCRYPTION_KEY: 'x' };
    expect(modelExecDaemonWarning(withKey)).not.toContain('JARVIS_WORKFLOW_ENCRYPTION_KEY');
    expect(modelExecDaemonWarning(withKey)).toContain('JARVIS_GITHUB_TOKEN');
    expect(modelExecDaemonWarning({ ...withKey, JARVIS_GITHUB_TOKEN: 'y' })).toBeNull();
  });
});
