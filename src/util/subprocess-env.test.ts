import { describe, expect, test } from 'bun:test';
import {
  EXTRA_ENV_KEYS,
  SUBPROCESS_ENV_ALLOWLIST,
  filterEnv,
  isAllowedEnvName,
  isSecretEnvName,
  sanitizedEnv,
} from './subprocess-env.ts';

const SENTINEL = 'sentinel-do-not-log';

describe('filterEnv drops credentials', () => {
  test('strips the names the old denylist already caught', () => {
    const out = filterEnv({
      PATH: '/usr/bin',
      ANTHROPIC_API_KEY: SENTINEL,
      JARVIS_API_KEY: SENTINEL,
      JARVIS_AUTH_TOKEN: SENTINEL,
      JARVIS_GITHUB_TOKEN: SENTINEL,
      OPENAI_API_KEY: SENTINEL,
      AWS_SECRET_ACCESS_KEY: SENTINEL,
      DB_PASSWORD: SENTINEL,
    });

    expect(out.PATH).toBe('/usr/bin');
    expect(Object.keys(out)).toEqual(['PATH']);
    expect(JSON.stringify(out)).not.toContain(SENTINEL);
  });

  test('strips the names the old denylist MISSED', () => {
    // The regression this module exists for. Every one of these is forwarded
    // by a denylist of api[_-]?key / secret / token / password / credential.
    const missedByDenylist = {
      // Real variable in this repo (src/workflows), matched by none of them.
      JARVIS_WORKFLOW_ENCRYPTION_KEY: SENTINEL,
      JARVIS_WORKFLOW_ENCRYPTION_KEY_FILE: SENTINEL,
      // Named in the issue as the motivating shapes.
      ENCRYPTION_KEY: SENTINEL,
      VAULT_KEY: SENTINEL,
      // "OPENAI_KEY" contains no "API", so the shape rule never matched it;
      // only an exact-name entry saved it.
      JARVIS_OPENAI_KEY: SENTINEL,
      JARVIS_OPENROUTER_KEY: SENTINEL,
      // Arbitrary future names an allowlist excludes by construction.
      SIGNING_KEY: SENTINEL,
      SOME_VENDOR_PRIVATE_KEY: SENTINEL,
      CLAUDE_CODE_MESSAGING_SOCKET: SENTINEL,
      SSH_AUTH_SOCK: SENTINEL,
      GIT_DIR: SENTINEL,
      GIT_ASKPASS: SENTINEL,
    };

    const out = filterEnv({ PATH: '/usr/bin', ...missedByDenylist });

    expect(Object.keys(out)).toEqual(['PATH']);
    for (const key of Object.keys(missedByDenylist)) {
      expect(out[key]).toBeUndefined();
    }
  });

  test('an unknown name is dropped even when it looks harmless', () => {
    const out = filterEnv({ PATH: '/usr/bin', TOTALLY_BENIGN_LOOKING: 'x' });
    expect(out.TOTALLY_BENIGN_LOOKING).toBeUndefined();
  });
});

describe('filterEnv keeps what the toolchain needs', () => {
  test('forwards the six variables a real scaffold was proven to need', () => {
    const base = {
      PATH: '/usr/bin',
      HOME: '/home/dev',
      LANG: 'C.UTF-8',
      TERM: 'xterm',
      TMPDIR: '/tmp',
      BUN_INSTALL: '/home/dev/.bun',
    };
    expect(filterEnv(base)).toEqual(base);
  });

  test('forwards proxy, TLS-trust and registry configuration', () => {
    const base = {
      HTTPS_PROXY: 'http://proxy:8080',
      https_proxy: 'http://proxy:8080',
      NO_PROXY: 'localhost',
      NODE_EXTRA_CA_CERTS: '/etc/ssl/corp.pem',
      SSL_CERT_FILE: '/etc/ssl/cert.pem',
      NPM_CONFIG_REGISTRY: 'https://registry.internal',
    };
    expect(filterEnv(base)).toEqual(base);
  });

  test('forwards the lowercase npm_config_* spelling npm actually exports', () => {
    // npm exports the lowercase form to child processes and POSIX name
    // comparison is case-sensitive, so uppercase-only entries would silently
    // drop a developer's registry and turn `make install` into a 404.
    const base = {
      npm_config_registry: 'https://registry.internal',
      npm_config_cache: '/var/cache/npm',
    };
    expect(filterEnv(base)).toEqual(base);
    // ...but not the credentialed members of the same family.
    expect(filterEnv({ npm_config__authToken: SENTINEL })).toEqual({});
  });

  test('forwards anchored LC_ locale names but not a lookalike', () => {
    const out = filterEnv({ LC_ALL: 'C', LC_CTYPE: 'C', MY_SECRET_LC_KEY: SENTINEL });
    expect(out.LC_ALL).toBe('C');
    expect(out.LC_CTYPE).toBe('C');
    expect(out.MY_SECRET_LC_KEY).toBeUndefined();
  });

  test('drops undefined values rather than stringifying them', () => {
    const out = filterEnv({ PATH: '/usr/bin', HOME: undefined });
    expect('HOME' in out).toBe(false);
  });
});

describe('extra additions', () => {
  test('are applied on top of the sanitized base', () => {
    const out = filterEnv(
      { PATH: '/usr/bin', ANTHROPIC_API_KEY: SENTINEL },
      { PORT: '3000', HOST: '127.0.0.1', NODE_ENV: 'development' },
    );
    expect(out).toEqual({ PATH: '/usr/bin', PORT: '3000', HOST: '127.0.0.1', NODE_ENV: 'development' });
  });

  test('an extra is written even when the base supplies the same name (base entry is dropped first)', () => {
    // Named for what it actually proves. A real base-vs-extra override is not
    // reachable: no EXTRA_ENV_KEYS member is allowlisted, so the base value is
    // dropped before the extras loop runs. The disjointness test below is what
    // pins that, and tells the next maintainer to revisit ordering if they
    // ever allowlist one of these names.
    const out = filterEnv({ NODE_ENV: 'production' } as Record<string, string>, { NODE_ENV: 'development' });
    expect(out.NODE_ENV).toBe('development');
    expect(filterEnv({ NODE_ENV: 'production' } as Record<string, string>)).toEqual({});
  });

  test('an undefined extra removes the key instead of writing "undefined"', () => {
    const out = filterEnv({ PATH: '/usr/bin' }, { PORT: undefined });
    expect('PORT' in out).toBe(false);
    expect(JSON.stringify(out)).not.toContain('undefined');
  });

  test('a full-env spread cast through extra cannot reinstate the leak', () => {
    // The type-level guard (OnlyExtraEnvKeys) rejects this shape at compile
    // time -- verified separately with tsc. This proves the RUNTIME half, which
    // is what survives a cast, an `as never`, or plain JS.
    const out = filterEnv(
      { PATH: '/usr/bin' },
      {
        ANTHROPIC_API_KEY: SENTINEL,
        JARVIS_WORKFLOW_ENCRYPTION_KEY: SENTINEL,
        DISPLAY: ':0',
        GIT_TERMINAL_PROMPT: '0',
      } as never,
    );

    expect(out).toEqual({ PATH: '/usr/bin', GIT_TERMINAL_PROMPT: '0' });
    expect(JSON.stringify(out)).not.toContain(SENTINEL);
  });

  test('an unknown-but-innocuous extra key is dropped rather than trusted', () => {
    const out = filterEnv({ PATH: '/usr/bin' }, { SOME_NEW_KNOB: 'x' } as never);
    expect(out.SOME_NEW_KNOB).toBeUndefined();
  });

  test('a credential-named extra never arrives', () => {
    // Dropped by the EXTRA_ENV_KEYS union check before the backstop is even
    // reached. Both guards are pinned separately: the union by the two tests
    // above, the backstop by the EXTRA_ENV_KEYS consistency test below.
    const out = filterEnv({ PATH: '/usr/bin' }, { API_TOKEN: SENTINEL } as never);
    expect(out).toEqual({ PATH: '/usr/bin' });
  });
});

describe('list consistency', () => {
  test('no allowlisted name is caught by the backstop denylist', () => {
    // If these two lists ever contradict each other, the toolchain breaks in a
    // way that looks like a mysterious install failure. Fail here instead.
    const selfBlocked = SUBPROCESS_ENV_ALLOWLIST.filter(isSecretEnvName);
    expect(selfBlocked).toEqual([]);
  });

  test('the backstop recognises credential-shaped names', () => {
    for (const name of [
      'ENCRYPTION_KEY', 'VAULT_KEY', 'API_TOKEN', 'DB_PASSWORD',
      'SOME_SECRET', 'AWS_CREDENTIALS', 'SSH_AUTH_SOCK', 'PRIVATE_KEY',
    ]) {
      expect(isSecretEnvName(name)).toBe(true);
    }
  });

  test('names this module must never forward, whatever the allowlist says', () => {
    // The subset assertions elsewhere import the allowlist from the
    // implementation, so they can only catch a POLICY VIOLATION, never POLICY
    // DRIFT: adding any of these names to SUBPROCESS_ENV_ALLOWLIST would
    // otherwise make zero tests fail. Several are not credential-shaped, so
    // the backstop would not catch them either.
    const mustNeverForward = [
      // Locates the daemon's own secret store (.secrets.key / .secrets.enc).
      'JARVIS_HOME',
      // Would re-point a project's git commands at another repository.
      'GIT_DIR', 'GIT_CONFIG_GLOBAL', 'GIT_WORK_TREE', 'GIT_INDEX_FILE',
      // Code execution in the child.
      'NODE_OPTIONS', 'LD_PRELOAD', 'BUN_INSPECT',
      // Capability handles: the user's ssh agent and desktop session.
      'SSH_AUTH_SOCK', 'DISPLAY', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR',
      'CLAUDE_CODE_MESSAGING_SOCKET',
      // TLS verification kill switch.
      'NODE_TLS_REJECT_UNAUTHORIZED',
      // Credentials by any other name.
      'AWS_ACCESS_KEY_ID', 'GOOGLE_APPLICATION_CREDENTIALS', 'NPM_TOKEN',
    ];

    for (const name of mustNeverForward) {
      expect({ name, forwarded: filterEnv({ [name]: SENTINEL }) }).toEqual({ name, forwarded: {} });
    }
  });

  test('the allowlist is immutable', () => {
    expect(Object.isFrozen(SUBPROCESS_ENV_ALLOWLIST)).toBe(true);
  });

  test('no EXTRA_ENV_KEYS member is caught by the backstop', () => {
    // Without this, adding e.g. NPM_TOKEN to EXTRA_ENV_KEYS would compile,
    // typecheck and pass every other test, then be silently dropped at
    // runtime by the backstop with no diagnostic anywhere.
    expect(EXTRA_ENV_KEYS.filter(isSecretEnvName)).toEqual([]);
  });

  test('EXTRA_ENV_KEYS and the allowlist are disjoint', () => {
    // This is what makes base-vs-extra precedence moot: an extra key can never
    // also arrive from the base. If someone allowlists NODE_ENV or HOST later,
    // precedence starts to matter and this test tells them to go look at it --
    // getting it backwards would let the daemon's own HOST override the
    // call site's explicit HOST=127.0.0.1 loopback bind.
    const overlap = EXTRA_ENV_KEYS.filter(k => SUBPROCESS_ENV_ALLOWLIST.includes(k));
    expect(overlap).toEqual([]);
  });

  test('the backstop does not treat trust-anchor paths as secrets', () => {
    // Adding /cert/i here would strip these and break TLS behind a proxy.
    expect(isSecretEnvName('NODE_EXTRA_CA_CERTS')).toBe(false);
    expect(isSecretEnvName('SSL_CERT_FILE')).toBe(false);
  });
});

describe('sanitizedEnv', () => {
  // These assert on sanitizedEnv() itself, not on filterEnv(). Every call site
  // uses sanitizedEnv(), so if only the pure form is constrained, replacing
  // this function's body with `return process.env` passes the whole suite --
  // measured, it did.

  test('drops a non-allowlisted name taken from the REAL process env', () => {
    // Deliberately neither credential-shaped nor allowlisted, so the ONLY
    // thing that can remove it is the allowlist. A secret-shaped canary would
    // be caught by the backstop and leave the allowlist untested, and a name
    // that happens to be set on the developer's machine would make the verdict
    // depend on their shell.
    process.env.JARVIS_TEST_CANARY_PLAIN = SENTINEL;
    try {
      const out = sanitizedEnv();
      expect(out.JARVIS_TEST_CANARY_PLAIN).toBeUndefined();
      expect(JSON.stringify(out)).not.toContain(SENTINEL);
    } finally {
      delete process.env.JARVIS_TEST_CANARY_PLAIN;
    }
  });

  test('output is a subset of the declared policy', () => {
    const permitted = (name: string) =>
      SUBPROCESS_ENV_ALLOWLIST.includes(name) || /^LC_/.test(name) || (EXTRA_ENV_KEYS as readonly string[]).includes(name);

    expect(Object.keys(sanitizedEnv()).filter(k => !permitted(k))).toEqual([]);
  });

  test('applies extras to the real process env', () => {
    // Kills the mutation that silently ignores `extra`: GIT_TERMINAL_PROMPT
    // going missing lets git block on a credential prompt, and HOST going
    // missing lets a dev server bind 0.0.0.0.
    expect(sanitizedEnv({ GIT_TERMINAL_PROMPT: '0' }).GIT_TERMINAL_PROMPT).toBe('0');
    expect(sanitizedEnv({ HOST: '127.0.0.1' }).HOST).toBe('127.0.0.1');
  });

  test('carries PATH through, so a spawned child can still find its binaries', () => {
    expect(process.env.PATH).toBeTruthy();
    expect(sanitizedEnv().PATH).toBe(process.env.PATH!);
  });

  test('always returns an object, never undefined', () => {
    // Bun.spawn INHERITS the full env when `env` is omitted, so any path that
    // yields undefined silently restores the entire leak.
    expect(sanitizedEnv()).toBeInstanceOf(Object);
    expect(Object.keys(sanitizedEnv()).length).toBeGreaterThan(0);
  });
});

describe('win32 name casing', () => {
  // The Windows branch cannot otherwise run on Linux CI: both lookup sets are
  // built at module load, so flipping process.platform after import would
  // exercise only half of it. Hence the injectable platform.

  test('matches Windows names case-insensitively under win32', () => {
    expect(isAllowedEnvName('ProgramFiles', 'win32')).toBe(true);
    expect(isAllowedEnvName('ProgramFiles(x86)', 'win32')).toBe(true);
    expect(isAllowedEnvName('SystemRoot', 'win32')).toBe(true);
    expect(isAllowedEnvName('Path', 'win32')).toBe(true);
  });

  test('is case-sensitive on POSIX', () => {
    expect(isAllowedEnvName('PATH', 'linux')).toBe(true);
    expect(isAllowedEnvName('ProgramFiles', 'linux')).toBe(false);
  });

  test('preserves the base spelling on output', () => {
    // The repo reads process.env.ProgramFiles and ['ProgramFiles(x86)'] with
    // exactly this casing, so normalising the output would be a latent break.
    const out = filterEnv(
      { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)' },
      undefined,
      'win32',
    );
    expect(out.ProgramFiles).toBe('C:\\Program Files');
    expect(out['ProgramFiles(x86)']).toBe('C:\\Program Files (x86)');
  });

  test('still refuses a credential under win32 casing rules', () => {
    expect(filterEnv({ AnthropicApiKey: SENTINEL }, undefined, 'win32')).toEqual({});
  });
});
