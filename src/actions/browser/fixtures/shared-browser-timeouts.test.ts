/**
 * A suite that drives a real test Chromium must give every test and hook an
 * explicit timeout (#1241).
 *
 * Bun's default of 5s is below launchTestChromium's own 45s startup bound and
 * below the 30s page load BrowserController.navigate waits for, so on a loaded
 * runner the default fails a healthy test. Worse, when a test or hook times
 * out, `bun test` SIGTERMs every subprocess still running ("killed 1 dangling
 * process"). The fixture's watchdog now ignores that TERM, but a browser that
 * something else started (watchBrowser) does not have to, so the floor below
 * applies to every file that launches or watches one.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const SRC = join(import.meta.dir, '..', '..', '..');
const CALLS = new Set(['test', 'it', 'beforeAll', 'afterAll', 'beforeEach', 'afterEach']);
/** Below this an explicit timeout is no better than the default. */
const FLOOR_MS = 10_000;

/**
 * Files that start a browser and are exempt, with why. Each must still exist,
 * so a rename cannot leave a stale exemption behind.
 */
const EXEMPT: Record<string, string> = {
  'actions/browser/fixtures/headless-chromium.ts': 'the fixture itself',
  'actions/browser/fixtures/shared-browser-timeouts.test.ts': 'this check, which names the fixture but starts no browser',
  // Its real-browser tests launch per test and carry 60s timeouts; the rest
  // of the file is unit tests of the launch arguments, with no browser.
  'actions/browser/chrome-sandbox.test.ts': 'per-test launches; mostly browserless unit tests',
};

// Index of the callback and of the timeout: hooks take (fn, timeout), tests (name, fn, timeout).
const callbackIndex = (name: string) => (name === 'test' || name === 'it' ? 1 : 0);

/** The names this file imports from bun:test, under their local names. */
function bunTestNames(sf: ts.SourceFile): Map<string, string> {
  const names = new Map<string, string>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || st.moduleSpecifier.text !== 'bun:test') continue;
    const bindings = st.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const el of bindings.elements) {
      const imported = (el.propertyName ?? el.name).text;
      if (CALLS.has(imported)) names.set(el.name.text, imported);
    }
  }
  return names;
}

/** `test`, `test.skipIf(x)`, `test.each(t)`, `it.only` ... -> the root identifier. */
function rootIdentifier(expr: ts.Expression): string | null {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return rootIdentifier(expr.expression);
  if (ts.isCallExpression(expr)) return rootIdentifier(expr.expression);
  return null;
}

function numericValue(expr: ts.Expression): number | null {
  if (ts.isNumericLiteral(expr)) return Number(expr.text.replaceAll('_', ''));
  if (ts.isObjectLiteralExpression(expr)) {
    for (const p of expr.properties) {
      if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'timeout') return numericValue(p.initializer);
    }
  }
  return null;
}

/** Calls to a bun:test test or hook in `file` without a literal timeout of at least FLOOR_MS. */
export function missingTimeouts(file: string, source: string): string[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const imported = bunTestNames(sf);
  const out: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const root = rootIdentifier(node.expression);
      const name = root ? imported.get(root) : undefined;
      // A modifier call like test.skipIf(cond) is the callee of the real
      // call; only the outer call carries the callback and the timeout.
      const isModifier = ts.isCallExpression(node.parent) && node.parent.expression === node;
      if (name && !isModifier && node.arguments.length > callbackIndex(name)) {
        const timeout = node.arguments[callbackIndex(name) + 1];
        const ms = timeout ? numericValue(timeout) : null;
        if (ms === null || ms < FLOOR_MS) {
          const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
          out.push(`${file}:${line + 1} ${name}`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** Whether the file starts or adopts a real browser. Text, so no call shape escapes it. */
export function drivesBrowser(source: string): boolean {
  return source.includes('launchTestChromium') || source.includes('watchBrowser');
}

describe('suites that drive a real test Chromium (#1241)', () => {
  const files = [...new Bun.Glob('**/*.ts').scanSync({ cwd: SRC, absolute: true })]
    .filter((f) => !f.includes('/node_modules/'))
    .map((f) => relative(SRC, f))
    .filter((f) => !(f in EXEMPT) && drivesBrowser(readFileSync(join(SRC, f), 'utf8')));

  test('the scan finds them, and every exemption still exists', () => {
    // A rename that hid every suite from the scan would pass the check below
    // vacuously; these are known to drive one.
    for (const known of [
      'actions/browser/page-writable-element-refs.test.ts',
      'actions/browser/browser-primitives.test.ts',
      'actions/browser/browser-local-files.test.ts',
      'actions/browser/fixtures/headless-chromium.test.ts',
      'actions/tools/browser-template-delivery.test.ts',
    ]) expect(files).toContain(known);
    for (const f of Object.keys(EXEMPT)) expect(existsSync(join(SRC, f))).toBe(true);
  });

  test(`every test and hook in them has an explicit timeout of at least ${FLOOR_MS}ms`, () => {
    const missing = files.flatMap((f) => missingTimeouts(f, readFileSync(join(SRC, f), 'utf8')));
    expect(missing).toEqual([]);
  });

  test('the checker sees each call shape', () => {
    const src = `
      import { afterAll, afterEach, beforeAll, beforeEach, describe, it, test as t } from 'bun:test';
      beforeAll(async () => {});
      afterAll(cleanup, 15_000);
      t('a', async () => {});
      t.skipIf(true)('b', async () => {});
      describe('d', () => { it('c', () => {}, 30_000); t('e', async () => {}, 5_000); });
      t('f', body);
      t('g', withPage(async () => {}), undefined);
      t.each([1])('h', async () => {});
      beforeEach(function () {}, { timeout: 20_000 });
      afterEach(setup);
      t('i', async () => {}, { timeout: 1_000 });
      /x/.test('y');
      [1].forEach(() => 1);
      for (const test of xs) test.run(() => 1);
    `;
    expect(missingTimeouts('x.ts', src)).toEqual([
      'x.ts:3 beforeAll',
      'x.ts:5 test',
      'x.ts:6 test',
      'x.ts:7 test',
      'x.ts:8 test',
      'x.ts:9 test',
      'x.ts:10 test',
      'x.ts:12 afterEach',
      'x.ts:13 test',
    ]);
    expect(drivesBrowser(`import * as fx from './fixtures/headless-chromium.ts'; await fx.launchTestChromium({});`)).toBe(true);
    expect(drivesBrowser(`const w = watchBrowser(pid, dir);`)).toBe(true);
    expect(drivesBrowser(`new BrowserController(fake.port);`)).toBe(false);
  });
});
