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
import {
  MODEL_EXEC_ENV_KEY_FLAG,
  MODEL_EXEC_MARKER_ENV,
  hadEnvWorkflowKey,
  isModelExecProcess,
  modelExecCliWarning,
  modelExecDaemonWarning,
  modelExecMarkers,
  modelExecRestartWarning,
  parentWorkflowKeyCheck,
  workflowKeyCheck,
} from './model-exec-marker.ts';

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
    expect(isDaemonSecretEnvName(MODEL_EXEC_ENV_KEY_FLAG)).toBe(false);
  });

  test('flags the env key only when this process holds it or inherited the flag', () => {
    const saved = { key: process.env.JARVIS_WORKFLOW_ENCRYPTION_KEY, flag: process.env[MODEL_EXEC_ENV_KEY_FLAG] };
    try {
      delete process.env.JARVIS_WORKFLOW_ENCRYPTION_KEY;
      delete process.env[MODEL_EXEC_ENV_KEY_FLAG];
      expect(modelExecEnv()[MODEL_EXEC_ENV_KEY_FLAG]).toBeUndefined();
      process.env.JARVIS_WORKFLOW_ENCRYPTION_KEY = SENTINEL;
      const env = modelExecEnv({ [MODEL_EXEC_ENV_KEY_FLAG]: undefined });
      expect(env[MODEL_EXEC_ENV_KEY_FLAG]).toBe(workflowKeyCheck(SENTINEL));
      expect(env.JARVIS_WORKFLOW_ENCRYPTION_KEY).toBeUndefined(); // the check, not the key
      delete process.env.JARVIS_WORKFLOW_ENCRYPTION_KEY;
      process.env[MODEL_EXEC_ENV_KEY_FLAG] = 'abcdef0123456789';
      expect(modelExecEnv()[MODEL_EXEC_ENV_KEY_FLAG]).toBe('abcdef0123456789'); // inherited, passed on
    } finally {
      for (const [name, v] of [['JARVIS_WORKFLOW_ENCRYPTION_KEY', saved.key], [MODEL_EXEC_ENV_KEY_FLAG, saved.flag]] as const) {
        if (v === undefined) delete process.env[name];
        else process.env[name] = v;
      }
    }
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
    // The failure prints what to do, not just the names.
    const fix = unclassified.length === 0 ? null
      : 'A setting (e.g. JARVIS_BROWSER_NO_SANDBOX from #521): add it to JARVIS_SETTINGS_ENV_NAMES in '
        + 'src/util/model-exec-env.ts. A secret: DAEMON_SECRET_ENV_NAMES. Set only on processes the daemon '
        + 'starts itself: JARVIS_INTERNAL_ENV_NAMES.';
    expect({ unclassified, fix }).toEqual({ unclassified: [], fix: null });
  });

  test('the three buckets do not overlap', () => {
    const all = [...DAEMON_SECRET_ENV_NAMES, ...JARVIS_SETTINGS_ENV_NAMES, ...JARVIS_INTERNAL_ENV_NAMES];
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('the model-exec markers (#514)', () => {
  const KEY = 'a'.repeat(64);
  const CHECK = workflowKeyCheck(KEY);
  const FLAGGED = { [MODEL_EXEC_MARKER_ENV]: '1', [MODEL_EXEC_ENV_KEY_FLAG]: CHECK };
  const LEGACY = { [MODEL_EXEC_MARKER_ENV]: '1', [MODEL_EXEC_ENV_KEY_FLAG]: '1' };

  test('the key check: 16 hex chars, stable, case-insensitive, and not the key', () => {
    // Known answer, FROZEN: one release sets the flag and the next checks it,
    // so a changed label, parameter or normalisation must fail here first.
    expect(workflowKeyCheck('a'.repeat(64))).toBe('2449f493d03b759a');
    expect(workflowKeyCheck(` ${'A'.repeat(64)}\n`)).toBe('2449f493d03b759a');
    expect(CHECK).toMatch(/^[0-9a-f]{16}$/);
    expect(workflowKeyCheck(KEY.toUpperCase())).toBe(CHECK);
    expect(workflowKeyCheck('b'.repeat(64))).not.toBe(CHECK);
    expect(KEY).not.toContain(CHECK);
  });

  test('the marker is exactly "1"; the flag is a check value or an older parent\'s "1"', () => {
    expect(isModelExecProcess({ [MODEL_EXEC_MARKER_ENV]: '1' })).toBe(true);
    expect(parentWorkflowKeyCheck({ [MODEL_EXEC_ENV_KEY_FLAG]: CHECK })).toBe(CHECK);
    expect(parentWorkflowKeyCheck({ [MODEL_EXEC_ENV_KEY_FLAG]: '1' })).toBe('1');
    for (const v of [undefined, '', '0', 'true', CHECK.toUpperCase(), CHECK.slice(1)]) {
      expect({ v, marked: isModelExecProcess({ [MODEL_EXEC_MARKER_ENV]: v }) }).toEqual({ v, marked: false });
      expect({ v, flagged: hadEnvWorkflowKey({ [MODEL_EXEC_ENV_KEY_FLAG]: v }) }).toEqual({ v, flagged: false });
    }
  });

  test('modelExecMarkers: the parent env key sets the check, an inherited flag passes on unchanged', () => {
    expect(modelExecMarkers({})).toEqual({ [MODEL_EXEC_MARKER_ENV]: '1' });
    expect(modelExecMarkers({ JARVIS_WORKFLOW_ENCRYPTION_KEY: KEY })).toEqual(FLAGGED);
    expect(modelExecMarkers({ [MODEL_EXEC_ENV_KEY_FLAG]: CHECK })).toEqual(FLAGGED);
    expect(modelExecMarkers({ [MODEL_EXEC_ENV_KEY_FLAG]: '1' })).toEqual(LEGACY);
    // A key handed in along the way does not replace the ancestor's check.
    expect(modelExecMarkers({ ...FLAGGED, JARVIS_WORKFLOW_ENCRYPTION_KEY: 'b'.repeat(64) })).toEqual(FLAGGED);
  });

  test('silent for a file-key install, marked or not', () => {
    for (const env of [{}, { [MODEL_EXEC_MARKER_ENV]: '1' }]) {
      expect(modelExecDaemonWarning(env)).toBeNull();
      expect(modelExecRestartWarning(env)).toBeNull();
      expect(modelExecCliWarning('restart', ['-d'], env)).toBeNull();
    }
  });

  test('warns while the parent\'s key is missing or a different one is set; silent once it is back', () => {
    expect(modelExecDaemonWarning(FLAGGED)).toContain('kept its workflow key in JARVIS_WORKFLOW_ENCRYPTION_KEY');
    expect(modelExecDaemonWarning(FLAGGED)).toContain('unset JARVIS_MODEL_EXEC_ENV_KEY deliberately');
    expect(modelExecRestartWarning(FLAGGED)).toContain('systemctl --user restart jarvis');
    expect(modelExecDaemonWarning({ ...FLAGGED, JARVIS_WORKFLOW_ENCRYPTION_KEY: 'b'.repeat(64) })).not.toBeNull();
    const back = { ...FLAGGED, JARVIS_WORKFLOW_ENCRYPTION_KEY: KEY };
    expect(modelExecDaemonWarning(back)).toBeNull();
    expect(modelExecRestartWarning(back)).toBeNull();
    // An older parent's `1` cannot judge an env key; one being set is enough.
    expect(modelExecDaemonWarning({ ...LEGACY, JARVIS_WORKFLOW_ENCRYPTION_KEY: KEY })).toBeNull();
    expect(modelExecDaemonWarning(LEGACY)).not.toBeNull();
  });

  test('the CLI warns only for a detached start or restart', () => {
    // Foreground start/restart IS the daemon, which warns itself; update warns
    // from update.ts, and only where it restarts anything.
    const warns = (command: string, args: string[]) => modelExecCliWarning(command, args, FLAGGED) !== null;
    expect(warns('start', ['-d'])).toBe(true);
    expect(warns('restart', ['--detach'])).toBe(true);
    expect(warns('start', [])).toBe(false);
    expect(warns('start', ['--no-open'])).toBe(false); // the child `start -d` spawns
    expect(warns('restart', [])).toBe(false);
    expect(warns('update', [])).toBe(false);
    expect(warns('status', ['-d'])).toBe(false);
  });
});
