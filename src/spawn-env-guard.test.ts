/**
 * No subprocess may be spawned anywhere under src/ with the daemon's
 * environment unless it is on the exemption list below, with a reason.
 *
 * History: #509 found nine site-builder spawns handing `process.env` to code
 * in a model-written project tree, although `sanitizedEnv()` already existed.
 * #510 fixed them and added an AST guard, scoped to src/sites. #512 found five
 * more outside that scope -- the CODE-step sandbox, three `bun install` runs of
 * third-party packages and the dashboard auto-build -- so the guard now covers
 * all of src/, and what is exempt is a reviewed list rather than "anything
 * outside the directory someone thought to scan".
 *
 * Out of scope, deliberately: test files (they run only under `bun test`, and
 * build the envs they spawn with on purpose), and everything outside src/ --
 * bin/jarvis.ts and scripts/ are developer and CLI entry points run from the
 * user's own shell, not code the daemon runs.
 *
 * The guard walks the TypeScript AST rather than scanning text. #510 tried a
 * hand-rolled lexer first; it had no regex-literal state, so the `"` inside
 * `/\/home\/[^\s"']*\/g` at proxy.ts:128 opened a phantom string and blanked
 * the rest of that file, silently. Parsing removes that class of bug, and the
 * tests below pin that it stays removed: every scanned file must parse with
 * zero diagnostics, and a violation planted at the END of a real file in every
 * scanned area must be reported. Recognising a spawn once parsed is a separate
 * question -- see scanSource() for what is and is not followed, and the
 * evasion cases at the bottom for the shapes pinned.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';

const SRC = import.meta.dir;

// ---------------------------------------------------------------------------
// Exemptions
// ---------------------------------------------------------------------------

/*
 * Keyed by FILE, then by the FUNCTION the spawn sits in, with the EXACT number
 * of unsanitized spawns there. Per function so that a new inheriting spawn in
 * a new function of an exempt file still fails; exact rather than "at most" so
 * that removing one without shrinking the entry cannot leave headroom for the
 * next to slip in unreviewed. What stays blind: swapping one spawn for another
 * inside the same already-exempt function.
 *
 * Adding an entry is a security decision. The bar: the child runs no code that
 * is model-authored, user-authored or third-party beyond what the daemon
 * already trusts in-process, OR it demonstrably needs variables the allowlist
 * in src/util/subprocess-env.ts deliberately drops (DISPLAY, DBUS,
 * XDG_RUNTIME_DIR, the Windows desktop session...) -- and the reason says which.
 */

/** The user's own CLI process and the tools it drives. */
const USER_CLI =
  'Runs in the `jarvis` CLI, in the user\'s own shell environment, not the ' +
  'daemon\'s. Children are system tooling (systemctl/launchctl/loginctl, tar, ' +
  'git, package managers, `bun update`) or the daemon itself, which needs its ' +
  'full env to start; `systemctl --user` also needs XDG_RUNTIME_DIR / ' +
  'DBUS_SESSION_BUS_ADDRESS, which the allowlist drops.';

/** Fixed system tools that talk to the desktop session. */
const DESKTOP_SESSION =
  'Fixed system binaries (no model-authored command line) that must reach ' +
  'the desktop session: DISPLAY, WAYLAND_DISPLAY, XAUTHORITY, ' +
  'DBUS_SESSION_BUS_ADDRESS, XDG_RUNTIME_DIR, and on Windows the full ' +
  'session block. The allowlist drops these on purpose.';

/**
 * NOT a finding that these are safe. They run a model-chosen command or
 * executable by design, gated by the authority engine, and today hand it the
 * full daemon env, secrets included. Whether to strip the daemon-owned
 * secrets there is a product decision -- a shell tool is expected to see the
 * user's own env (nvm, venv, ssh-agent, AWS profile, DISPLAY), so the site
 * allowlist is the wrong tool, and a subtractive strip of daemon-owned names
 * changes what the tool can do -- so it is not taken here. Tracked in #514.
 */
const MODEL_EXEC_PENDING =
  'PENDING DECISION (#514): model-directed exec on the user\'s ' +
  'machine by design; see MODEL_EXEC_PENDING in spawn-env-guard.test.ts.';

type Exemption = { reason: string; calls: Record<string, number> };

const EXEMPT: Record<string, Exemption> = {
  'cli/autostart.ts': {
    reason: USER_CLI + ' scheduleSystemdRestart and spawnDetachedShell (the launchd restart) are also reached from the daemon (api-routes), and run fixed systemctl/launchctl commands that restart the unit.',
    calls: {
      spawnDetachedShell: 1,
      defaultSpawnSync: 1,
      probeSystemdUserService: 3,
      installSystemd: 3,
      startSystemdService: 1,
      scheduleSystemdRestart: 1,
      uninstallSystemd: 3,
      startLaunchdService: 2,
      uninstallLaunchd: 1,
    },
  },
  'cli/backup.ts': { reason: USER_CLI, calls: { runTar: 1 } },
  'cli/deps.ts': {
    reason: USER_CLI,
    calls: { commandExists: 1, detectPackageManager: 4, runPackageInstall: 4, installBrowser: 1, setupGoogleOAuth: 3 },
  },
  'cli/doctor.ts': { reason: USER_CLI, calls: { runDoctor: 1 } },
  'cli/lifecycle.ts': { reason: USER_CLI, calls: { captureOutput: 1 } },
  'cli/uninstall.ts': { reason: USER_CLI + ' Launches the detached uninstaller, which must outlive this process.', calls: { schedulePackageRemoval: 1 } },
  'cli/update.ts': {
    reason: USER_CLI,
    calls: { defaultSpawn: 1, restartDaemonDetached: 1, updateBunGlobal: 1, updateScript: 6 },
  },
  'cli/version.ts': { reason: USER_CLI + ' Also reached from telemetry: a read-only `git -C <package root>` query.', calls: { runGit: 1 } },
  'scripts/google-setup.ts': { reason: 'Interactive setup script; opens a URL with the desktop opener. ' + DESKTOP_SESSION, calls: { main: 1 } },

  'actions/tools/builtin.ts': {
    reason: 'Clipboard and screenshot tools (pbcopy/xclip/xsel/clip/powershell/scrot/import/screencapture); the only interpolation is the same generated temp path, in the screenshot commands. ' + DESKTOP_SESSION,
    calls: { localClipboardRead: 5, localClipboardWrite: 5, localCaptureScreen: 4 },
  },
  'comms/desktop-notify.ts': {
    reason:
      'notify-send / powershell toasts; needs the session env (DBUS_SESSION_BUS_ADDRESS, the Windows ' +
      'session block). NOT a fixed command line: the title and body can be workflow- or model-authored, ' +
      'passed as argv to notify-send but interpolated into the PowerShell script. That quoting is a ' +
      'separate injection question from env hygiene, tracked in #515.',
    calls: { detectMethod: 2, sendViaNotifySend: 1, sendViaPowerShell: 1 },
  },
  'actions/app-control/native-exec.ts': {
    reason: 'powershell/osascript running repo scripts, model data on stdin only. `runNative` is the injected exec seam, a name match rather than a real spawn. ' + DESKTOP_SESSION,
    calls: { defaultExec: 1, runNative: 1 },
  },
  'actions/app-control/sidecar-launcher.ts': {
    reason: 'Launches this repo\'s own desktop-bridge binary (' + DESKTOP_SESSION + ') and, under WSL only, `cmd.exe /C echo %USERPROFILE%`, which needs the WSL interop variables (WSL_INTEROP, WSLENV) the allowlist drops.',
    calls: { findSidecarExecutable: 1, launchSidecar: 1 },
  },
  'actions/browser/chrome-launcher.ts': {
    reason:
      'Launches Chrome for CDP. ' + DESKTOP_SESSION + ' Page JS is renderer-sandboxed and cannot read the ' +
      'browser process env, but the model drives this browser over CDP and could navigate it to ' +
      'file:///proc/self/environ, so this is close to MODEL_EXEC_PENDING and goes with that decision.',
    calls: { launchChrome: 1 },
  },
  'actions/app-control/linux.ts': {
    reason: 'xdotool/wmctrl/xprop/import via Bun `$`: ' + DESKTOP_SESSION + ' launchApp (model-chosen executable and args): ' + MODEL_EXEC_PENDING,
    calls: {
      'LinuxAppController.launchApp': 1,
      'LinuxAppController.captureScreen': 3,
      'LinuxAppController.captureWindow': 2,
      'LinuxAppController.checkTool': 1,
      'LinuxAppController.clickElement': 4,
      'LinuxAppController.findWindowByPid': 2,
      'LinuxAppController.focusWindow': 1,
      'LinuxAppController.getActiveWindow': 3,
      'LinuxAppController.listWindows': 5,
      'LinuxAppController.pressKeys': 1,
      'LinuxAppController.typeText': 1,
    },
  },
  'actions/terminal/executor.ts': {
    reason: 'The run_command tool: `$SHELL -c <model command>`. ' + MODEL_EXEC_PENDING,
    calls: { 'TerminalExecutor.execute': 1, 'TerminalExecutor.stream': 1 },
  },

  'workflows/runner/engine-runtime/spawn.ts': {
    reason:
      'The engine gets its OWN curated allowlist (ENGINE_ENV_PASSTHROUGH, pinned by a test ' +
      'below, plus the engine\'s wiring vars), not sanitizedEnv(): those wiring vars ' +
      '(SANDBOX_ID, AP_*, JARVIS_ENGINE_*) are not ExtraEnvKey members, and adding ' +
      'them to that closed union would open them to every site; and the site allowlist ' +
      'would forward HTTP(S)_PROXY and CA settings to the engine, which changes how ' +
      'pieces reach the network -- a functional decision, not env hygiene. The ' +
      'caller-supplied opts.env merged on top (used by tests only) is ' +
      'filtered to engine names by isEngineEnvName, pinned by a test below.',
    calls: { spawnEngine: 1 },
  },

  // Positive controls: each spawns with an inherited env ON PURPOSE to prove
  // its harness can see a leak.
  'sites/fixtures/spawn-env-probe.ts': { reason: 'Positive control for src/sites/spawn-env.test.ts.', calls: { '<module>': 1 } },
  'fixtures/spawn-env-sites-probe.ts': {
    reason: 'Positive controls (node:child_process via PATH, node:child_process via execPath + IPC as the CODE sandbox does, and Bun.spawnSync) for src/spawn-env-sites.test.ts.',
    calls: { '<module>/<anonymous>': 2, '<module>': 1 },
  },
};

// ---------------------------------------------------------------------------
// The scanner
// ---------------------------------------------------------------------------

/** node:child_process exports that start a process. */
const CHILD_PROCESS_SPAWNERS = new Set(['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']);
/** `bun` module exports that start a process. */
const BUN_MODULE_SPAWNERS = new Set(['spawn', 'spawnSync', '$']);
/** Members of the `Bun` global that start a process. */
const BUN_GLOBAL_SPAWNERS = new Set(['spawn', 'spawnSync', '$', 'openInEditor']);
const CHILD_PROCESS_MODULES = new Set(['child_process', 'node:child_process']);
/** `node:process` as a module: `execve` replaces this process, env as its third argument. */
const PROCESS_MODULES = new Set(['process', 'node:process']);
const PROCESS_SPAWNERS = new Set(['execve']);

/** Where `sanitizedEnv` must be imported from, resolved, without extension. */
const SANITIZER_PATH = join(SRC, 'util', 'subprocess-env');

const SOURCE_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const TEST_FILE = /\.test\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

function scriptKind(file: string): ts.ScriptKind {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (file.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (/\.(js|mjs|cjs)$/.test(file)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/**
 * Libraries that start processes with an inherited env and have no
 * sanitized form here. Importing one at all is an offender: use Bun.spawn or
 * node:child_process with `env: sanitizedEnv()`, or exempt it with a reason.
 */
const THIRD_PARTY_PROCESS_MODULES = new Set([
  'execa', 'cross-spawn', 'node-pty', 'tinyexec', 'nano-spawn', 'zx', 'shelljs', 'child-process-promise',
  // Not process libraries by name, but each starts one with the caller's env:
  // an opener, a VCS client, a notifier, an MCP server over stdio, a browser.
  'open', 'simple-git', 'node-notifier',
  '@modelcontextprotocol/sdk/client/stdio', '@modelcontextprotocol/sdk/client/stdio.js',
  'puppeteer', 'puppeteer-core', 'playwright', 'playwright-core',
]);

/** A listed package, any subpath of one, `@playwright/*`, or any MCP SDK stdio transport path. */
function isThirdPartyProcessModule(spec: string): boolean {
  if (THIRD_PARTY_PROCESS_MODULES.has(spec)) return true;
  for (const name of THIRD_PARTY_PROCESS_MODULES) if (spec.startsWith(`${name}/`)) return true;
  if (spec.startsWith('@playwright/')) return true;
  return spec.startsWith('@modelcontextprotocol/sdk/') && /\/stdio(\.[cm]?js)?$/.test(spec);
}

/** Strip what does not change a value: parens, `as`, `satisfies`, `!`, `<T>x`, `await`. */
function unwrap(e: ts.Expression): ts.Expression {
  for (;;) {
    if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e)
      || ts.isNonNullExpression(e) || ts.isTypeAssertionExpression(e) || ts.isAwaitExpression(e)) {
      e = e.expression;
    } else {
      return e;
    }
  }
}

/** The nearest ancestor that is not one of the wrappers `unwrap` strips. */
function effectiveParent(node: ts.Node): { parent: ts.Node; child: ts.Node } {
  let child = node;
  let parent = node.parent;
  while (ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent) || ts.isSatisfiesExpression(parent)
    || ts.isNonNullExpression(parent) || ts.isTypeAssertionExpression(parent) || ts.isAwaitExpression(parent)) {
    child = parent;
    parent = parent.parent;
  }
  return { parent, child };
}

/**
 * The module a call loads, when it is `require('x')`, `import('x')`, or any
 * other one-string-argument call naming a process module -- which covers
 * `createRequire(...)('child_process')` without having to track the alias.
 */
function moduleOfLoadCall(node: ts.Node): string | null {
  if (!ts.isCallExpression(node) || node.arguments.length !== 1) return null;
  const arg = node.arguments[0]!;
  if (!ts.isStringLiteralLike(arg)) return null;
  // require(), and Bun's import.meta.require()
  const isRequire = (ts.isIdentifier(node.expression) && node.expression.text === 'require')
    || (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'require'
      && ts.isMetaProperty(node.expression.expression));
  const isImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
  if (isRequire || isImport || CHILD_PROCESS_MODULES.has(arg.text)) return arg.text;
  return null;
}

function isInsideType(node: ts.Node): boolean {
  for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
    if (ts.isTypeNode(p)) return true;
    if (ts.isStatement(p) || ts.isSourceFile(p)) return false;
  }
  return false;
}

/** The literal text of a property name, or null for a computed one. */
function propertyNameText(name: ts.PropertyName | undefined): string | null {
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
  return null;
}

/**
 * One scope: each name it declares, mapped to whether that declaration binds a
 * process module (`true`: pass 1 recorded it, so inside this scope the name IS
 * the module) or anything else (`false`: it shadows the module binding).
 */
type Scope = Map<string, boolean>;

function boundNames(name: ts.BindingName, out: Scope, moduleBound: ReadonlySet<ts.Node>): void {
  if (ts.isIdentifier(name)) {
    out.set(name.text, moduleBound.has(name));
  } else {
    for (const el of name.elements) if (!ts.isOmittedExpression(el)) boundNames(el.name, out, moduleBound);
  }
}

/** `declare const Bun: any` describes the global; it does not replace it. */
const isAmbient = (s: ts.Statement) =>
  ts.canHaveModifiers(s) && !!ts.getModifiers(s)?.some(m => m.kind === ts.SyntaxKind.DeclareKeyword);

const isBlockScoped = (list: ts.VariableDeclarationList) => (list.flags & ts.NodeFlags.BlockScoped) !== 0;

/** let/const/class/function declared directly in a statement list: one block's scope. */
function blockNames(statements: readonly ts.Statement[], skip: ReadonlySet<ts.Node>): Scope {
  const out: Scope = new Map();
  for (const s of statements) {
    if (isAmbient(s)) continue;
    if (ts.isVariableStatement(s) && isBlockScoped(s.declarationList)) {
      for (const d of s.declarationList.declarations) boundNames(d.name, out, skip);
    }
    if ((ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s)) && s.name) out.set(s.name.text, false);
  }
  return out;
}

/** `var` declarations anywhere under `root` outside nested functions: they hoist to it. */
function varNames(root: ts.Node, skip: ReadonlySet<ts.Node>): Scope {
  const out: Scope = new Map();
  const walkVars = (n: ts.Node): void => {
    if (ts.isVariableStatement(n) && isAmbient(n)) return;
    if (ts.isVariableDeclarationList(n) && !isBlockScoped(n)) for (const d of n.declarations) boundNames(d.name, out, skip);
    if (ts.isFunctionLike(n)) return;
    ts.forEachChild(n, walkVars);
  };
  ts.forEachChild(root, walkVars);
  return out;
}

/** The names a node introduces for its own subtree, or null if it opens no scope. */
function scopeOf(node: ts.Node, skip: ReadonlySet<ts.Node>): Scope | null {
  if (ts.isSourceFile(node)) return new Map([...varNames(node, skip), ...blockNames(node.statements, skip)]);
  if (ts.isFunctionLike(node)) {
    const out: Scope = new Map();
    if (ts.isFunctionExpression(node) && node.name) out.set(node.name.text, false);
    for (const p of node.parameters) boundNames(p.name, out, skip);
    const body = (node as ts.FunctionLikeDeclaration).body;
    if (body) for (const [n, m] of varNames(body, skip)) out.set(n, m);
    return out;
  }
  if (ts.isBlock(node) || ts.isModuleBlock(node)) return blockNames(node.statements, skip);
  if (ts.isCaseBlock(node)) return blockNames(node.clauses.flatMap(c => [...c.statements]), skip);
  if ((ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node))
    && node.initializer && ts.isVariableDeclarationList(node.initializer) && isBlockScoped(node.initializer)) {
    const out: Scope = new Map();
    for (const d of node.initializer.declarations) boundNames(d.name, out, skip);
    return out;
  }
  if (ts.isCatchClause(node) && node.variableDeclaration) {
    const out: Scope = new Map();
    boundNames(node.variableDeclaration.name, out, skip);
    return out;
  }
  return null;
}

/** The variable or property an object literal is assigned to, for naming its methods. */
function ownerOf(obj: ts.ObjectLiteralExpression): string | null {
  const { parent } = effectiveParent(obj);
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  if (ts.isPropertyAssignment(parent)) return propertyNameText(parent.name);
  return null;
}

/**
 * The function a node sits in, as named in EXEMPT: `fn`, `Class.method`,
 * `Class.constructor`, `obj.method`, `get x` / `set x`, and for an anonymous
 * function its enclosing name plus `/<anonymous>`, so callbacks in different
 * functions do not share a key.
 */
function enclosingName(node: ts.Node, sf: ts.SourceFile): string {
  for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
    if (!ts.isFunctionLike(p)) continue;
    let name: string | null = null;
    if (ts.isConstructorDeclaration(p)) name = 'constructor';
    else name = propertyNameText((p as { name?: ts.PropertyName }).name);
    if (!name) {
      const { parent } = effectiveParent(p);
      if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) name = parent.name.text;
      else if (ts.isPropertyAssignment(parent)) name = propertyNameText(parent.name) ?? parent.name.getText(sf);
      else if (ts.isPropertyDeclaration(parent)) name = propertyNameText(parent.name);
    }
    if (!name) return `${enclosingName(p, sf)}/<anonymous>`;
    if (ts.isGetAccessor(p)) name = `get ${name}`;
    if (ts.isSetAccessor(p)) name = `set ${name}`;
    const holder = ts.isPropertyAssignment(p.parent) || ts.isPropertyDeclaration(p.parent) ? p.parent.parent : p.parent;
    if (ts.isClassLike(holder)) return `${holder.name?.text ?? '<class>'}.${name}`;
    if (ts.isObjectLiteralExpression(holder)) return `${ownerOf(holder) ?? '<object>'}.${name}`;
    return name;
  }
  return '<module>';
}

type Offender = { line: number; fn: string; why: string };
type ScanResult = { offenders: Offender[]; diagnostics: number };

/**
 * Every spawn in `source` that does not pass `env: sanitizedEnv(...)`.
 *
 * What is recognised as a spawn:
 *   1. by NAME: a call to spawn/spawnSync/exec/execSync/execFile/execFileSync/
 *      fork, bare or as `x.name(...)` -- except `x.exec(...)`, which is
 *      RegExp#exec far more often than not, unless x is (after casts and
 *      parens) the module itself or an inline require()/import() of it;
 *   2. by BINDING: whatever local name an import, `import x = require()`,
 *      `require()` or `import()` of node:child_process or bun binds a spawner
 *      (or the module, including via `default`) to, including a destructured
 *      `.then(({ spawn }) => ...)` parameter -- with block-level scoping, so a
 *      local of the same name elsewhere neither hides nor fakes one;
 *   3. the `Bun` global, also behind casts and via globalThis/global/self
 *      (`Bun.spawn`, `Bun['spawn']`, `Bun[k]`, `Bun.openInEditor`);
 *   4. a Bun Shell tagged template (`$`, `Bun.$`, or `$` under any import name);
 *   5. an import of a third-party process library (THIRD_PARTY_PROCESS_MODULES);
 *   6. `process.execve`, whose env is its third argument.
 * And anything that would let a spawner leave the scanner's sight is itself an
 * offender: a bound spawner, the module object or the `Bun` global used as a
 * plain value (`const run = Bun.spawn`, `const B = Bun`, `wrap(cp)`,
 * `{ spawn }`), and a re-export of any of them.
 *
 * This is a tripwire for plausible code, not a proof: a spawner smuggled
 * through data (stored in a map by one module, called by another) is out of
 * reach of a per-file syntactic check. False positives cost an exemption; a
 * false negative is the bug, so the rules err wide.
 *
 * Not covered, on purpose: worker_threads and `new Worker`. A worker is a
 * thread in this process, not a subprocess, so there is no env boundary for it
 * to cross.
 */
function scanSource(source: string, label: string): ScanResult {
  const sf = ts.createSourceFile(label, source, ts.ScriptTarget.Latest, true, scriptKind(label));
  // Internal but long-stable; asserted to exist so a TypeScript upgrade that
  // moved it fails loudly instead of reading as "no diagnostics".
  const parseDiagnostics = (sf as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics;
  if (!Array.isArray(parseDiagnostics)) throw new Error('typescript no longer exposes parseDiagnostics');

  const offenders: Offender[] = [];
  const report = (node: ts.Node, why: string) => offenders.push({
    line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
    fn: enclosingName(node, sf),
    why,
  });

  // Pass 1: bindings. File-wide names; shadowing is handled in pass 2.
  const spawnerAliases = new Set<string>();
  const moduleAliases = new Map<string, Set<string>>();
  /** The identifiers that declare those bindings; they do not shadow. */
  const moduleBoundDecls = new Set<ts.Node>();
  let sanitizerImported = false;

  const spawnersOf = (spec: string): Set<string> | null =>
    CHILD_PROCESS_MODULES.has(spec) ? CHILD_PROCESS_SPAWNERS
      : spec === 'bun' ? BUN_MODULE_SPAWNERS
        : PROCESS_MODULES.has(spec) ? PROCESS_SPAWNERS
          : null;

  const bindModule = (id: ts.Identifier, spawners: Set<string>) => {
    moduleAliases.set(id.text, spawners);
    moduleBoundDecls.add(id);
  };

  const bindPattern = (name: ts.BindingName, spawners: Set<string>) => {
    if (ts.isIdentifier(name)) {
      bindModule(name, spawners);
    } else if (ts.isObjectBindingPattern(name)) {
      for (const el of name.elements) {
        const imported = propertyNameText(el.propertyName ?? (ts.isIdentifier(el.name) ? el.name : undefined));
        if (!imported || !ts.isIdentifier(el.name)) continue;
        if (imported === 'default') {
          bindModule(el.name, spawners);
        } else if (spawners.has(imported)) {
          spawnerAliases.add(el.name.text);
          moduleBoundDecls.add(el.name);
        }
      }
    }
  };

  const collect = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const spec = node.moduleSpecifier.text;
      const clause = node.importClause;
      const nb = clause?.namedBindings;
      if (spec.startsWith('.') && resolve(dirname(join(SRC, label)), spec).replace(/\.ts$/, '') === SANITIZER_PATH
        && clause && !clause.isTypeOnly && nb && ts.isNamedImports(nb)
        && nb.elements.some(e => e.name.text === 'sanitizedEnv' && !e.propertyName && !e.isTypeOnly)) {
        sanitizerImported = true;
      }
      const spawners = spawnersOf(spec);
      if (spawners && clause && !clause.isTypeOnly) {
        if (clause.name) bindModule(clause.name, spawners);
        if (nb && ts.isNamespaceImport(nb)) bindModule(nb.name, spawners);
        if (nb && ts.isNamedImports(nb)) {
          for (const el of nb.elements) {
            if (el.isTypeOnly) continue;
            const imported = (el.propertyName ?? el.name).text;
            if (imported === 'default') bindModule(el.name, spawners);
            else if (spawners.has(imported)) spawnerAliases.add(el.name.text);
          }
        }
      }
    }
    // import cp = require('child_process')
    if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference)
      && ts.isStringLiteral(node.moduleReference.expression)) {
      const spawners = spawnersOf(node.moduleReference.expression.text);
      if (spawners) bindModule(node.name, spawners);
    }
    // const cp = require('child_process') / const { spawn: run } = (await import('bun'))
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const init = unwrap(node.initializer);
      const spec = moduleOfLoadCall(init);
      const spawners = spec ? spawnersOf(spec) : null;
      if (spawners) bindPattern(node.name, spawners);
      // const { execve } = process / = globalThis.process -- the global, destructured
      const isProcessGlobal = (ts.isIdentifier(init) && init.text === 'process')
        || (ts.isPropertyAccessExpression(init) && init.name.text === 'process'
          && ts.isIdentifier(init.expression) && ['globalThis', 'global', 'self'].includes(init.expression.text));
      if (isProcessGlobal && ts.isObjectBindingPattern(node.name)) bindPattern(node.name, PROCESS_SPAWNERS);
    }
    // import('node:child_process').then(({ spawn }) => ...) / .then(cp => ...)
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'then') {
      const spec = moduleOfLoadCall(unwrap(node.expression.expression));
      const spawners = spec ? spawnersOf(spec) : null;
      const cb = node.arguments[0];
      if (spawners && cb && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) && cb.parameters[0]) {
        bindPattern(cb.parameters[0].name, spawners);
      }
    }
    ts.forEachChild(node, collect);
  };
  collect(sf);

  // Pass 2: uses, with a stack of the names each enclosing scope declares.
  // Innermost declaration wins: a local shadows the module binding, and a
  // module re-binding in an inner scope un-shadows an outer local.
  const shadowed: Scope[] = [];
  const isShadowed = (name: string): boolean => {
    for (let i = shadowed.length - 1; i >= 0; i--) {
      const bindsModule = shadowed[i]!.get(name);
      if (bindsModule !== undefined) return !bindsModule;
    }
    return false;
  };

  /** `x.name` / `x['name']`; a computed key is '<computed>', which any rule treats as a match. */
  const memberOf = (node: ts.Expression): { object: ts.Expression; name: string } | null => {
    if (ts.isPropertyAccessExpression(node)) return { object: unwrap(node.expression), name: node.name.text };
    if (ts.isElementAccessExpression(node)) {
      const key = node.argumentExpression;
      return { object: unwrap(node.expression), name: ts.isStringLiteralLike(key) ? key.text : '<computed>' };
    }
    return null;
  };
  const GLOBAL_OBJECTS = new Set(['globalThis', 'global', 'self', 'window']);
  const isBunGlobal = (e: ts.Expression): boolean => {
    e = unwrap(e);
    if (ts.isIdentifier(e)) return e.text === 'Bun' && !isShadowed('Bun');
    const m = memberOf(e);
    return !!m && m.name === 'Bun' && ts.isIdentifier(m.object) && GLOBAL_OBJECTS.has(m.object.text) && !isShadowed(m.object.text);
  };
  /** The spawners of the module `e` denotes: a module alias, or an inline load call. */
  const moduleOf = (e: ts.Expression): Set<string> | undefined => {
    e = unwrap(e);
    if (ts.isIdentifier(e)) return isShadowed(e.text) ? undefined : moduleAliases.get(e.text);
    // `cp.default.exec(...)`, `(await import('node:child_process')).default`
    const dm = memberOf(e);
    if (dm && dm.name === 'default') return moduleOf(dm.object);
    const spec = moduleOfLoadCall(e);
    return spec ? spawnersOf(spec) ?? undefined : undefined;
  };
  const matches = (set: Set<string>, name: string) => name === '<computed>' || set.has(name);

  /** Provably a spawner, from bindings or the Bun global. */
  const isBoundSpawner = (e: ts.Expression): boolean => {
    e = unwrap(e);
    if (ts.isIdentifier(e)) return spawnerAliases.has(e.text) && !isShadowed(e.text);
    const m = memberOf(e);
    if (!m) return false;
    if (isBunGlobal(m.object)) return matches(BUN_GLOBAL_SPAWNERS, m.name);
    const spawners = moduleOf(m.object);
    return !!spawners && matches(spawners, m.name);
  };

  /** Bindings, plus the name heuristic -- for calls only: recall over precision. */
  const isSpawnCallee = (e: ts.Expression): boolean => {
    if (isBoundSpawner(e)) return true;
    e = unwrap(e);
    if (ts.isIdentifier(e)) return CHILD_PROCESS_SPAWNERS.has(e.text);
    const m = memberOf(e);
    return !!m && m.name !== 'exec' && CHILD_PROCESS_SPAWNERS.has(m.name);
  };

  /** `process.execve`, `globalThis.process.execve`, behind casts too. */
  const isProcessExecve = (e: ts.Expression): boolean => {
    const m = memberOf(unwrap(e));
    if (!m || m.name !== 'execve') return false;
    const obj = unwrap(m.object);
    if (ts.isIdentifier(obj)) return obj.text === 'process' && !isShadowed('process');
    const pm = memberOf(obj);
    return !!pm && pm.name === 'process' && ts.isIdentifier(pm.object) && GLOBAL_OBJECTS.has(pm.object.text);
  };

  // Any bound spawner used as a tag is a shell: `$` under whatever name it was
  // imported as. A bare `$` counts even unbound, since Bun Shell is the only
  // `$` tag this repo uses.
  const isShellTag = (tag: ts.Expression): boolean =>
    (ts.isIdentifier(unwrap(tag)) && (unwrap(tag) as ts.Identifier).text === '$') || isBoundSpawner(tag);

  const checkEnv = (call: ts.CallExpression, callee: string) => {
    const options = call.arguments.find(a => ts.isObjectLiteralExpression(unwrap(a)));
    if (!options) {
      report(call, `${callee}: no inline options object, so its env cannot be verified`);
      return;
    }
    const props = (unwrap(options) as ts.ObjectLiteralExpression).properties;
    // By the key's VALUE, not its spelling: `'env'` and `env` are `env` too.
    const isEnv = (p: ts.ObjectLiteralElementLike) => !!p.name && propertyNameText(p.name) === 'env';
    const isComputed = (p: ts.ObjectLiteralElementLike) => !!p.name && ts.isComputedPropertyName(p.name);
    const envIdx = props.findIndex(isEnv);
    if (envIdx === -1) {
      report(call, `${callee} passes no env, so it inherits the daemon's`);
      return;
    }
    // Last write wins in an object literal: a later spread, a computed key or
    // a second `env` could replace the sanitized one.
    if (props.slice(envIdx + 1).some(p => ts.isSpreadAssignment(p) || isEnv(p) || isComputed(p))) {
      report(call, `${callee}: something after env: can override it`);
      return;
    }
    const prop = props[envIdx]!;
    const init = ts.isPropertyAssignment(prop) ? prop.initializer : undefined;
    // Exactly a call to the sanitizedEnv imported from util/subprocess-env. A
    // substring check would accept `{ ...sanitizedEnv(), ...process.env }`,
    // the likeliest regression and a total leak; a same-named local or a
    // look-alike module could return anything.
    const ok = !!init && ts.isCallExpression(init) && ts.isIdentifier(init.expression)
      && init.expression.text === 'sanitizedEnv' && sanitizerImported && !isShadowed('sanitizedEnv');
    if (!ok) {
      const got = (init ?? prop).getText(sf).replace(/\s+/g, ' ').slice(0, 60);
      report(call, `${callee} env must be exactly sanitizedEnv(...) imported from util/subprocess-env, got: ${got}`);
    }
  };

  /** A reference that is a declaration's own name, or a property key: not a use. */
  const isDeclarationName = (node: ts.Node): boolean => {
    const parent = node.parent as ts.Node & { name?: ts.Node; propertyName?: ts.Node };
    if (ts.isShorthandPropertyAssignment(parent)) return false; // `{ spawn }` IS a use
    if (ts.isPropertyAccessExpression(parent)) return parent.name === node;
    return parent.name === node || parent.propertyName === node;
  };

  /**
   * A spawner, a process module or the Bun global in a position where it is
   * used as a VALUE -- anything but a callee, a tag, the object of a member
   * access (whose member is judged on its own), `typeof`, or a type.
   */
  const escapes = (node: ts.Node): boolean => {
    if (ts.findAncestor(node, n => ts.isImportDeclaration(n) || ts.isImportEqualsDeclaration(n))) return false;
    if (isDeclarationName(node) || isInsideType(node)) return false;
    const { parent, child } = effectiveParent(node);
    if (ts.isCallExpression(parent) && parent.expression === child) return false;
    if (ts.isTaggedTemplateExpression(parent) && parent.tag === child) return false;
    if (ts.isTypeOfExpression(parent)) return false;
    // A member of the module or of Bun is judged on its own. A member of a
    // SPAWNER is not: `spawn.call(...)`, `Bun.spawn.bind(...)`,
    // `Bun.$.nothrow()` (the same shell), `new $.Shell()` all reach it.
    if ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === child) {
      return isBoundSpawner(node as ts.Expression) || isProcessExecve(node as ts.Expression);
    }
    return true;
  };

  const visit = (node: ts.Node): void => {
    if (ts.isTaggedTemplateExpression(node) && isShellTag(node.tag)) {
      report(node, `${node.tag.getText(sf)} shell inherits the env; use Bun.spawn with env: sanitizedEnv()`);
    } else if (ts.isCallExpression(node) && isProcessExecve(node.expression)) {
      // process.execve(file, args, env) REPLACES this process; with no env
      // argument the new image gets the daemon's.
      const env = node.arguments[2];
      const ok = !!env && ts.isCallExpression(env) && ts.isIdentifier(env.expression)
        && env.expression.text === 'sanitizedEnv' && sanitizerImported && !isShadowed('sanitizedEnv');
      if (!ok) report(node, 'process.execve env (third argument) must be exactly sanitizedEnv(...)');
    } else if (ts.isCallExpression(node) && isSpawnCallee(node.expression)) {
      checkEnv(node, node.expression.getText(sf));
    } else if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)
      && isThirdPartyProcessModule(node.moduleSpecifier.text)) {
      report(node, `imports ${node.moduleSpecifier.text}, which spawns with an inherited env`);
    } else if (ts.isCallExpression(node) && isThirdPartyProcessModule(moduleOfLoadCall(node) ?? '')) {
      report(node, `loads ${moduleOfLoadCall(node)}, which spawns with an inherited env`);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)
      && spawnersOf(node.moduleSpecifier.text)) {
      // `export * from 'bun'`, `export { exec as run } from 'node:child_process'`
      const spawners = spawnersOf(node.moduleSpecifier.text)!;
      const clause = node.exportClause;
      const leaks = !clause || ts.isNamespaceExport(clause)
        || clause.elements.some(el => { const n = (el.propertyName ?? el.name).text; return n === 'default' || spawners.has(n); });
      if (leaks) report(node, `re-exports a spawner from ${node.moduleSpecifier.text}; its callers cannot be checked`);
    } else if (ts.isExportSpecifier(node) && !node.parent.parent.moduleSpecifier) {
      // `export { spawn as run }` of a local binding
      const local = (node.propertyName ?? node.name).text;
      if ((spawnerAliases.has(local) || moduleAliases.has(local)) && !isShadowed(local)) {
        report(node, `re-exports ${local}; its callers cannot be checked`);
      }
    } else if ((ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
      && (isBoundSpawner(node) || isBunGlobal(node) || isProcessExecve(node) || (ts.isIdentifier(node) && moduleOf(node)))
      && escapes(node)) {
      report(node, `${node.getText(sf)} escapes as a value; the call it reaches cannot be checked`);
    } else if (ts.isCallExpression(node) && spawnersOf(moduleOfLoadCall(node) ?? '')) {
      // An inline require()/import() of the module is fine bound to a name or
      // used for a member; handed anywhere else, it escapes like an alias.
      const { parent, child } = effectiveParent(node);
      const bound = ts.isVariableDeclaration(parent) && parent.initializer === child;
      const member = (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === child;
      if (!bound && !member) report(node, `${node.getText(sf)} escapes as a value; the call it reaches cannot be checked`);
    }

    const scope = scopeOf(node, moduleBoundDecls);
    if (scope) shadowed.push(scope);
    ts.forEachChild(node, visit);
    if (scope) shadowed.pop();
  };
  visit(sf);

  return { offenders, diagnostics: parseDiagnostics.length };
}

/**
 * Directories never scanned: installed packages and build output. The jarvis
 * pieces' `dist/` bundles (gitignored, ~5.7 MB when built) exist only on
 * machines that have built them, so scanning them made the result depend on
 * local build state, and an exemption for them could not be written. A test
 * below fails if a TRACKED file ever lands under one of these.
 */
const SKIPPED_DIRS = new Set(['node_modules', 'dist']);

/** Every non-test source file under `root`, via a manual walk. */
function walk(root: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIPPED_DIRS.has(entry.name)) continue;
    const full = join(root, entry.name);
    if (entry.isDirectory()) found.push(...walk(full));
    else if (entry.isFile() && SOURCE_EXT.test(entry.name) && !TEST_FILE.test(entry.name)) found.push(full);
  }
  return found;
}

const rel = (file: string) => relative(SRC, file).split(sep).join('/');
const format = (file: string, o: Offender) => `${file}:${o.line} [${o.fn}] ${o.why}`;

// Scanned once, shared by the tests below.
const FILES = walk(SRC).sort();
const SCANS = new Map(FILES.map(f => [rel(f), scanSource(readFileSync(f, 'utf8'), rel(f))]));

function countByFunction(offenders: Offender[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const o of offenders) out[o.fn] = (out[o.fn] ?? 0) + 1;
  return out;
}

// ---------------------------------------------------------------------------
// The guard
// ---------------------------------------------------------------------------

describe('no spawn under src/ inherits the daemon environment', () => {
  test('every spawn passes env: sanitizedEnv(...), or is exempt by file, function and exact count', () => {
    const problems: string[] = [];
    for (const [file, { offenders }] of SCANS) {
      const exempt = EXEMPT[file];
      if (!exempt) {
        problems.push(...offenders.map(o => format(file, o)));
        continue;
      }
      const found = countByFunction(offenders);
      const fns = new Set([...Object.keys(found), ...Object.keys(exempt.calls)]);
      for (const fn of fns) {
        const want = exempt.calls[fn] ?? 0;
        const got = found[fn] ?? 0;
        if (want === got) continue;
        problems.push(
          `${file} [${fn}]: exempt for ${want} unsanitized spawn(s), found ${got}. ` +
          'A new spawn must use sanitizedEnv(); a removed one must shrink the entry.',
          ...offenders.filter(o => o.fn === fn).map(o => `  ${format(file, o)}`),
        );
      }
    }
    // If this fails: pass `env: sanitizedEnv()` (see src/util/subprocess-env.ts;
    // per-site additions go in its argument). Only if the child genuinely needs
    // the full environment, add or extend an EXEMPT entry above, with the reason.
    expect(problems).toEqual([]);
  });

  test('every exemption names a scanned file and justifies itself', () => {
    for (const [file, { calls, reason }] of Object.entries(EXEMPT)) {
      expect({ file, scanned: SCANS.has(file) }).toEqual({ file, scanned: true });
      expect(Object.keys(calls).length).toBeGreaterThan(0);
      for (const n of Object.values(calls)) expect(n).toBeGreaterThan(0);
      expect(reason.length).toBeGreaterThan(20);
    }
  });
});

// These pin that the guard PARSES and REACHES every file it scans -- the
// failure #510's lexer had. They say nothing about binding or scope tracking;
// the evasion cases further down are what pin those.
describe('the guard parses and reaches every file it scans', () => {
  // Checks the walk's implementation against a second one with the same rules;
  // the rules themselves (root, extensions, test exclusion) are the header's.
  test('the walk finds exactly what an independent glob finds', () => {
    const globbed = [...new Bun.Glob('**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}').scanSync({ cwd: SRC, dot: true, onlyFiles: true })]
      .map(p => p.split(sep).join('/'))
      .filter(p => !TEST_FILE.test(p) && !p.split('/').slice(0, -1).some(d => SKIPPED_DIRS.has(d)))
      .sort();
    expect([...SCANS.keys()]).toEqual(globbed);
  });

  // Needs a git checkout; a source tarball or a copied tree has no index to ask.
  const inGitCheckout = Bun.spawnSync(['git', 'rev-parse', '--is-inside-work-tree'], {
    cwd: SRC, stdout: 'pipe', stderr: 'pipe',
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
  }).stdout.toString().trim() === 'true';

  test.skipIf(!inGitCheckout)('no tracked source file lives under a skipped directory', () => {
    // The skip is for generated output only. If source is ever committed under
    // a `dist/` or `node_modules/`, it has to be scanned, not silently skipped.
    // A constructed env: under a pre-commit hook git exports GIT_DIR, which
    // would widen `ls-files` to the whole repo and change what this checks.
    const ls = Bun.spawnSync(['git', 'ls-files', '-z', '--', '.'], {
      cwd: SRC, stdout: 'pipe', stderr: 'pipe',
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
    });
    expect(ls.exitCode).toBe(0);
    const tracked = ls.stdout.toString().split('\0').filter(Boolean);
    expect(tracked.length).toBeGreaterThan(1000);
    const hidden = tracked.filter(p => SOURCE_EXT.test(p) && p.split('/').slice(0, -1).some(d => SKIPPED_DIRS.has(d)));
    expect(hidden).toEqual([]);
  });

  test('every scanned file parses with zero diagnostics', () => {
    // A parse error is where a scanner goes blind: the tree after it is a guess.
    const broken = [...SCANS].filter(([, s]) => s.diagnostics > 0).map(([f, s]) => `${f}: ${s.diagnostics}`);
    expect(broken).toEqual([]);
  });

  test('a violation planted at the end of a real file is caught in every scanned area', () => {
    // Areas: each top-level entry under src/, and each vendored activepieces
    // package separately (each pieces/* sub-package too), since that tree is
    // most of what is scanned.
    const areaOf = (file: string) => {
      const parts = file.split('/');
      if (parts[0] === 'workflows' && parts[1] === 'activepieces' && parts[2] === 'packages') {
        return parts.slice(0, parts[3] === 'pieces' ? 5 : 4).join('/');
      }
      return parts.length > 1 ? parts[0]! : '(src root)';
    };
    const largest = new Map<string, { file: string; size: number }>();
    for (const file of FILES) {
      const r = rel(file);
      if (r.endsWith('.d.ts')) continue; // a statement is not legal in an ambient file
      const size = readFileSync(file).length;
      const area = areaOf(r);
      const cur = largest.get(area);
      if (!cur || size > cur.size) largest.set(area, { file: r, size });
    }
    expect(largest.size).toBeGreaterThan(20);

    const missed: string[] = [];
    for (const [area, { file }] of largest) {
      const source = readFileSync(join(SRC, file), 'utf8');
      const before = SCANS.get(file)!.offenders.length;
      const planted = scanSource(`${source}\n;Bun.spawn(['planted'], { cwd: '/' });\n`, file).offenders;
      if (planted.length !== before + 1 || !planted.at(-1)!.why.includes('passes no env')) missed.push(`${area} (${file})`);
    }
    expect(missed).toEqual([]);
  }, 30_000); // re-parses the largest file per area: ~1.5s on one throttled core
});

// ---------------------------------------------------------------------------
// The engine's own allowlist, which the exemption above relies on
// ---------------------------------------------------------------------------

test('the engine env passthrough stays curated', async () => {
  const { ENGINE_ENV_PASSTHROUGH } = await import('./workflows/runner/engine-runtime/spawn.ts');
  const { isAllowedEnvName, isSecretEnvName } = await import('./util/subprocess-env.ts');
  const { ENGINE_ORPHAN_POLL_ENV, ENGINE_SHUTDOWN_GRACE_ENV } = await import('./workflows/runner/engine-runtime/engine-lifecycle.ts');
  // Pinned: widening it is a reviewed edit to this line, not a drive-by.
  expect([...ENGINE_ENV_PASSTHROUGH]).toEqual([
    'PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ', 'BUN_RUNTIME_TRANSPILER_CACHE_PATH',
    ENGINE_SHUTDOWN_GRACE_ENV, ENGINE_ORPHAN_POLL_ENV,
  ]);
  for (const name of ENGINE_ENV_PASSTHROUGH) {
    expect({ name, secretShaped: isSecretEnvName(name) }).toEqual({ name, secretShaped: false });
  }
  // Everything but the two lifecycle knobs is also on the site allowlist.
  const engineOnly = ENGINE_ENV_PASSTHROUGH.filter(n => !isAllowedEnvName(n));
  expect(engineOnly).toEqual([ENGINE_SHUTDOWN_GRACE_ENV, ENGINE_ORPHAN_POLL_ENV]);
});

test('a caller-supplied engine env override cannot reintroduce the daemon env', async () => {
  // opts.env (a test seam since #512 removed EngineRuntime's unused
  // spawnEnvOverride) is merged over the curated
  // list. Handing it the daemon's whole environment must still yield only
  // engine names.
  const { engineEnv } = await import('./workflows/runner/engine-runtime/spawn.ts');
  const { ENGINE_SHUTDOWN_GRACE_ENV } = await import('./workflows/runner/engine-runtime/engine-lifecycle.ts');
  const warn = console.warn;
  const warnings: string[] = [];
  console.warn = (m: string) => { warnings.push(m); };
  let env: Record<string, string>;
  try {
    env = engineEnv({
      bundlePath: '/x/main.js', sandboxId: 'sb', sandboxWsPort: 1, baseCodeDir: '/tmp',
      env: {
        ANTHROPIC_API_KEY: 'sentinel-do-not-log',
        JARVIS_WORKFLOW_ENCRYPTION_KEY: 'sentinel-do-not-log',
        HTTPS_PROXY: 'http://proxy',
        [ENGINE_SHUTDOWN_GRACE_ENV]: '300',
        AP_DEV_PIECES: 'x',
      },
    });
  } finally {
    console.warn = warn;
  }
  expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  expect(env.JARVIS_WORKFLOW_ENCRYPTION_KEY).toBeUndefined();
  expect(env.HTTPS_PROXY).toBeUndefined();
  expect(env[ENGINE_SHUTDOWN_GRACE_ENV]).toBe('300');
  expect(env.AP_DEV_PIECES).toBe('x');
  expect(env.SANDBOX_ID).toBe('sb');
  // The drop is announced by NAME; the value never reaches the log.
  expect(warnings.join('\n')).toContain('ANTHROPIC_API_KEY');
  expect(warnings.join('\n')).not.toContain('sentinel-do-not-log');
});

// ---------------------------------------------------------------------------
// The shapes the scanner must catch, pinned
// ---------------------------------------------------------------------------

describe('the guard catches evasions', () => {
  // Synthetic sources are labelled as files at src/ root, so this is the
  // import a real file there would write.
  const SAN = `import { sanitizedEnv } from './util/subprocess-env.ts';\n`;
  const cases: Array<[string, string]> = [
    ['a plain unsanitized spawn', `Bun.spawn(['echo'], { cwd: d, stdout: 'pipe' });`],
    ['an unbalanced paren inside a string', `Bun.spawn(['sh', '-c', 'echo hi ('], { cwd: d });`],
    ['a regex literal containing a quote (proxy.ts:128 shape)', `const RE = /\\/home\\/[^\\s"']*/g;\nBun.spawn(['echo'], { cwd: d });`],
    ['Bun.spawnSync', `Bun.spawnSync(['echo'], { cwd: d });`],
    ["Bun['spawn']", `Bun['spawn'](['echo'], { cwd: d });`],
    ['globalThis.Bun.spawn', `globalThis.Bun.spawn(['echo'], { cwd: d });`],
    ['Bun.openInEditor', `Bun.openInEditor(file, { line: 1 });`],
    ['node child_process execSync', `execSync('echo hi', { cwd: d });`],
    ['fork', `fork('./worker.js', [], { cwd: d });`],
    ['cluster.fork', `cluster.fork({ WORKER: '1' });`],
    ['an aliased named import', `import { spawn as run } from 'node:child_process';\nrun('echo', [], { cwd: d });`],
    ['a namespace import, even via .exec', `import * as cp from 'child_process';\ncp.exec('echo', { cwd: d });`],
    ['a default import', `import cp from 'node:child_process';\ncp.execFile('echo', [], { cwd: d });`],
    ['require()', `const cp = require('child_process');\ncp.exec('echo', { cwd: d });`],
    ['createRequire()', `const cp = createRequire(import.meta.url)('node:child_process');\ncp.exec('echo', { cwd: d });`],
    ['destructured dynamic import', `const { spawn: go } = await import('node:child_process');\ngo('echo', [], { cwd: d });`],
    ['import().then destructuring (the old reconciler shape)', `import('node:child_process').then(({ spawn }) => { spawn('bun', ['install'], { cwd }); });`],
    ['import().then with a namespace parameter', `import('node:child_process').then((cp) => cp.exec('echo', { cwd }));`],
    ["an aliased import from 'bun'", `import { spawnSync as s } from 'bun';\ns(['echo'], { stdout: 'pipe' });`],
    ['Bun.spawn object form without env', `spawn({ cmd: ['sh', '-c', c], cwd: d });`],
    ['options not written inline', `Bun.spawn(['echo'], opts);`],
    ['a spread that re-adds the daemon env', `${SAN}Bun.spawn(['echo'], { env: { ...sanitizedEnv(), ...process.env } });`],
    ['a spread AFTER a sanitized env', `${SAN}Bun.spawn(['echo'], { env: sanitizedEnv(), ...opts });`],
    ['a second env after a sanitized one', `${SAN}Bun.spawn(['echo'], { env: sanitizedEnv(), env: process.env });`],
    ['a computed key after a sanitized env', `${SAN}Bun.spawn(['echo'], { env: sanitizedEnv(), [k]: process.env });`],
    ['env shorthand', `Bun.spawn(['echo'], { env });`],
    ['sanitizedEnv from a look-alike module', `import { sanitizedEnv } from './other/util/subprocess-env.ts';\nBun.spawn(['echo'], { env: sanitizedEnv() });`],
    ['sanitizedEnv never imported', `Bun.spawn(['echo'], { env: sanitizedEnv() });`],
    ['sanitizedEnv shadowed by a local', `${SAN}function f(sanitizedEnv) { Bun.spawn(['echo'], { env: sanitizedEnv() }); }`],
    ['a sanitizedEnv call parked on the wrong property', `${SAN}Bun.spawn(['echo'], { cwd: d, note: sanitizedEnv() });`],
    ['a second spawn adjacent to a sanitized one', `${SAN}Bun.spawn(['a'], { env: sanitizedEnv() });spawn(['b'], { cwd: d });`],
    ['a template literal with interpolation', `Bun.spawn([\`\${bin} run\`], { cwd: d });`],
    ['Bun.$ shell', 'Bun.$`make dev`.cwd(d);'],
    ["$ imported from 'bun'", "import { $ } from 'bun';\nawait $`xdotool key a`;"],
    ["$ imported from 'bun' under another name", "import { $ as sh } from 'bun';\nawait sh`xdotool key a`;"],
    ['Bun.spawn escaping as a value', `const run = Bun.spawn;\nrun(['echo'], { env: {} });`],
    ['an imported spawner passed as a value', `import { spawn } from 'node:child_process';\nwrap({ spawn });`],
    ['an imported spawner passed as an argument', `import { spawn as s } from 'node:child_process';\nwrap(s);`],
    // #512 review, round 2: shapes the first version of this scanner missed.
    ['inline require().exec', `require('node:child_process').exec('curl x');`],
    ['inline (await import()).exec', `(await import('node:child_process')).exec('curl x');`],
    ['import x = require()', `import cp = require('child_process');\ncp.exec('curl x');`],
    ['a destructured default of a dynamic import', `const { default: cp } = await import('node:child_process');\ncp.exec('x');`],
    ['a default destructured in import().then', `import('node:child_process').then(({ default: cp }) => cp.exec('x'));`],
    ['the module re-aliased', `import * as cp from 'node:child_process';\nconst m = cp;\nm.exec('x');`],
    ['the module passed as a value', `import * as cp from 'node:child_process';\nwrap(cp);`],
    ['a spawner destructured from the module alias', `import * as cp from 'node:child_process';\nconst { exec: go } = cp;\ngo('x');`],
    ['spawn destructured from Bun', `const { spawn: go } = Bun;\ngo(['curl']);`],
    ['$ destructured from Bun', 'const { $: sh } = Bun;\nawait sh`curl`;'],
    ['Bun re-aliased', 'const B = Bun;\nawait B.$`curl`;'],
    ['Bun behind a cast', '(Bun as any).$`curl`;'],
    ['globalThis.Bun behind a cast', '(globalThis as any).Bun.$`curl`;'],
    ['global.Bun', '(global as any).Bun.$`curl`;'],
    ['Bun.openInEditor behind a cast', `(Bun as any).openInEditor(f);`],
    ['a computed member of Bun', `(Bun as any)[k](['x']);`],
    ['a re-export from the module', `export { exec as run } from 'node:child_process';`],
    ['a star re-export of the module', `export * from 'node:child_process';`],
    ['a re-export of a local binding', `import { exec } from 'node:child_process';\nexport { exec as run };`],
    ['a quoted env key after a sanitized one', `${SAN}Bun.spawn(['x'], { env: sanitizedEnv(), 'env': process.env });`],
    ['a unicode-escaped env key after a sanitized one', `${SAN}Bun.spawn(['x'], { env: sanitizedEnv(), \\u0065nv: process.env });`],
    ['an env getter after a sanitized one', `${SAN}Bun.spawn(['x'], { env: sanitizedEnv(), get 'env'() { return process.env; } });`],
    ['a spawner alias unshadowed after an unrelated block-local', `import { exec as run } from 'node:child_process';\nfunction f(c) { if (c) { const run = 1; } run('curl'); }`],
    ['a spawner alias unshadowed after a catch binding', `import { exec as run } from 'node:child_process';\nfunction f() { try {} catch (run) {} run('curl'); }`],
    ['Bun unshadowed after an unrelated block-local', 'function f(t) { if (t) { const Bun = {}; } return Bun.$`curl`; }'],
    ['sanitizedEnv shadowed in a module-level block', `${SAN}{ const sanitizedEnv = () => process.env; Bun.spawn(['x'], { env: sanitizedEnv() }); }`],
    ['sanitizedEnv shadowed by a for-of binding', `${SAN}for (const sanitizedEnv of fns) Bun.spawn(['x'], { env: sanitizedEnv() });`],
    ['sanitizedEnv shadowed in a class static block', `${SAN}class A { static { const sanitizedEnv = () => process.env; Bun.spawn(['x'], { env: sanitizedEnv() }); } }`],
    ['sanitizedEnv imported type-only', `import type { sanitizedEnv } from './util/subprocess-env.ts';\nBun.spawn(['x'], { env: sanitizedEnv() });`],
    ['a third-party process library', `import { execa } from 'execa';\nawait execa('curl', ['x']);`],
    ['a third-party process library via require', `const spawn = require('cross-spawn');`],
    ['an inline require of the module passed as a value', `wrap(require('node:child_process'));`],
    // #512 review, round 3.
    ['spawn.call', `import { spawn } from 'node:child_process';\nspawn.call(null, 'curl', []);`],
    ['execFile.apply', `import { execFile } from 'node:child_process';\nexecFile.apply(null, ['curl']);`],
    ['spawn.bind', `import { spawn } from 'node:child_process';\nconst run = spawn.bind(null);`],
    ['Bun.spawn.call', `Bun.spawn.call(null, ['curl']);`],
    ['Bun.$.nothrow() stored and used as a tag', 'const sh = Bun.$.nothrow();\nawait sh`curl`;'],
    ['new $.Shell() from an aliased bun import', "import { $ as bunShell } from 'bun';\nconst sh = new bunShell.Shell();"],
    ['an aliased bun $ configured globally', "import { $ as bunShell } from 'bun';\nbunShell.cwd('/x');"],
    ['.default of an inline dynamic import', `(await import('node:child_process')).default.exec('x');`],
    ['.default of a module alias', `import * as cp from 'node:child_process';\ncp.default.exec('x');`],
    ['.default in import().then', `import('node:child_process').then(m => m.default.exec('x'));`],
    ['an inner module re-binding under an outer local of the same name', `const cp = x;\nasync function f() { const cp = await import('node:child_process'); cp.exec('x'); }`],
    ['an inner spawner re-binding under an outer local of the same name', `const run = 1;\nasync function f() { const { exec: run } = await import('node:child_process'); run('x'); }`],
    ['Bun after an ambient declaration of it', 'declare const Bun: any;\nBun.$`curl`;'],
    // Coordinator review nits.
    ['process.execve without an env', `process.execve('/bin/sh', ['sh', '-c', c]);`],
    ['process.execve with process.env', `process.execve('/bin/sh', ['sh'], process.env);`],
    ['process.execve escaping as a value', `const ex = process.execve;`],
    ['import.meta.require of bun, destructured', `const { spawn: go } = import.meta.require('bun');\ngo(['curl']);`],
    ['import.meta.require of child_process, then .exec', `import.meta.require('node:child_process').exec('curl');`],
    ['open', `import open from 'open';\nawait open(url);`],
    ['simple-git', `import { simpleGit } from 'simple-git';\nawait simpleGit(dir).pull();`],
    ['node-notifier', `const notifier = require('node-notifier');`],
    ['the MCP SDK stdio client transport', `import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';`],
    ['puppeteer', `import puppeteer from 'puppeteer';`],
    ['playwright', `import { chromium } from 'playwright';`],
    ['@playwright/test', `import { test } from '@playwright/test';`],
    ['a deep MCP SDK stdio path', `import { StdioClientTransport } from '@modelcontextprotocol/sdk/dist/esm/client/stdio.js';`],
    ['execve imported from node:process', `import { execve } from 'node:process';\nexecve('/bin/sh', ['sh']);`],
    ['execve destructured from process', `const { execve } = process;\nexecve('/bin/sh', ['sh']);`],
    ['require(node:process).execve', `require('node:process').execve('/bin/sh', ['sh']);`],
    ['process.execve.bind', `const ex = process.execve.bind(process);`],
    ['process.execve.call', `process.execve.call(process, '/bin/sh', ['sh']);`],
    ['execve destructured from globalThis.process', `const { execve: ex } = globalThis.process;\nex('/bin/sh', ['sh']);`],
  ];

  for (const [name, code] of cases) {
    test(name, () => {
      expect(scanSource(code, 'synthetic.ts').offenders).not.toEqual([]);
    });
  }

  test('a spawn in a .tsx file after JSX containing a quote', () => {
    const code = `const el = <div className="x">{'"'}</div>;\nBun.spawn(['echo'], {});`;
    const scan = scanSource(code, 'synthetic.tsx');
    expect(scan.diagnostics).toBe(0);
    expect(scan.offenders).not.toEqual([]);
  });

  const allowed: Array<[string, string, string?]> = [
    ['a correctly sanitized spawn', `${SAN}Bun.spawn(['echo'], { cwd: d, env: sanitizedEnv() });`],
    ['a sanitized spawn with extras', `${SAN}Bun.spawn(['echo'], { env: sanitizedEnv({ PORT: '1' }) });`],
    ['a sanitized node spawn', `${SAN}import { spawn } from 'node:child_process';\nspawn('bun', ['install'], { cwd, stdio: 'inherit', env: sanitizedEnv() });`],
    [
      'a sanitized spawn from inside the vendored engine',
      `import { sanitizedEnv } from '../../../../../../../../../util/subprocess-env'\nspawn(process.execPath, ['--eval', s], { stdio: 'pipe', env: sanitizedEnv() })`,
      'workflows/activepieces/packages/server/engine/src/lib/core/code/synthetic.ts',
    ],
    ['a spawn mentioned only in a line comment', `// Bun.spawn(['echo'], { cwd: d })`],
    ['a spawn mentioned only in a block comment', `/* Bun.spawn(['echo'], {}) */`],
    ['regex .exec(), which is not a spawn', `const m = RE.exec(input);`],
    ['a string that merely mentions a spawn', `const doc = "call Bun.spawn( with env";`],
    ['a type-only reference to a spawner', `import { spawnSync } from 'bun';\nlet r: ReturnType<typeof spawnSync>;`],
    ['a type-only import', `import type { Subprocess } from 'bun';\nlet p: Subprocess;`],
    ['a parameter that shadows an imported spawner, passed on', `import { spawn } from 'node:child_process';\nfunction f(spawn: Fn) { return g(spawn); }`],
    ['a property named like a spawner', `import { spawn } from 'node:child_process';\ninterface Deps { spawn?: Fn }\nconst d = { spawn: fake };`],
    ['a quoted env key holding sanitizedEnv', `${SAN}Bun.spawn(['echo'], { 'env': sanitizedEnv() });`],
    ['a block-local that shadows an imported spawner, used in its block', `import { spawn } from 'node:child_process';\nfunction f() { { const spawn = fake; g(spawn); } }`],
    ['typeof Bun', `const inBun = typeof Bun !== 'undefined';`],
    ['an ordinary Bun API', `const f = Bun.file(p);\nconst h = Bun.hash(s);`],
    ['a sanitized spawn behind a cast', `${SAN}(Bun as any).spawn(['echo'], { env: sanitizedEnv() });`],
    ['a sanitized process.execve', `${SAN}process.execve('/bin/sh', ['sh'], sanitizedEnv());`],
    ['process.env and other process members', `const p = process.env.PATH;\nprocess.exit(0);`],
  ];

  for (const [name, code, label] of allowed) {
    test(`no false positive: ${name}`, () => {
      expect(scanSource(code, label ?? 'synthetic.ts').offenders).toEqual([]);
    });
  }
});
