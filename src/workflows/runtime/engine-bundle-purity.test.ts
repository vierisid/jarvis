/**
 * Daemon sources compiled INTO the engine bundle may import runtime values
 * only from other registered, guarded sources (#634).
 *
 * WHY THIS IS A TEST AND NOT A COMMENT. `runner/engine-runtime/build.ts` holds
 * `PATCHED_VENDOR_SOURCES`, the explicit cache-invalidation registry for
 * sources whose content must flow into the bundle hash. It lists
 * `runtime/piece-effects.ts` and `runtime/piece-effect-guard.ts`, and both
 * files carry a docblock saying to keep them pure. A VALUE import added to
 * either one would drag its whole transitive graph into the bundle as
 * unregistered input -- so a later edit to that dependency would leave cached
 * engines running the old code while the daemon ran the new, with every test
 * green.
 *
 * #634 is the concrete case. The obvious fix for it was to call
 * `boundedReceiptText` from inside `piece-effects.ts`'s `bound()`, which would
 * have made `roles/untrusted.ts` -- a 1000-line module that changes often, and
 * the one whose output feeds `requestDigest` -- exactly that unregistered
 * input. The fix instead lives in `piece-effect-receipt.ts` on the daemon side,
 * and that choice is only sound for as long as this property holds. The
 * existing drift test (`piece-executor-gate.drift.test.ts`) checks that both
 * files are REGISTERED; nothing checked that they stayed importable without
 * dragging the daemon in behind them.
 *
 * Same shape as `roles/untrusted-import-guard.test.ts` and
 * `spawn-env-guard.test.ts`: a property argued in prose becomes an invariant
 * the suite enforces.
 *
 * SCOPE: every permitted sibling is checked by this same guard. A new value
 * dependency must be registered in `PATCHED_VENDOR_SOURCES` and included
 * below, so its own imports cannot pull in unregistered daemon dependencies.
 * `piece-executor-gate.drift.test.ts` independently checks that registration.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

/** Relative to this directory. Each source is also covered by the bundle hash. */
const BUNDLED_DAEMON_SOURCES = ['piece-effects.ts', 'piece-effect-guard.ts', 'decision-document.ts', 'hubspot-contact.ts'];

/**
 * A value import of ANOTHER registered source is fine: the guard uses the
 * adapter table, approved documents and HubSpot input validation. The bundle
 * hash already covers these sources. Derive the allowed imports from the
 * files we check so allowing a sibling also guards its dependencies.
 */
const REGISTERED_SPECIFIERS = new Set(BUNDLED_DAEMON_SOURCES.map(file => `./${file.replace(/\.ts$/u, '')}`));

const reachesOutsideTheRegistry = (specifier: string): boolean =>
  !REGISTERED_SPECIFIERS.has(specifier.replace(/^['"]|['"]$/gu, '').replace(/\.ts$/u, ''));

function valueImportsOf(file: string): string[] {
  const path = join(import.meta.dir, file);
  const source = ts.createSourceFile(file, readFileSync(path, 'utf8'), ts.ScriptTarget.ESNext, true);
  const offenders: string[] = [];
  for (const statement of source.statements) {
    // `import ... from '...'`
    if (ts.isImportDeclaration(statement)) {
      const specifier = statement.moduleSpecifier.getText(source);
      const report = () => { if (reachesOutsideTheRegistry(specifier)) offenders.push(specifier); };
      const clause = statement.importClause;
      // No clause at all is a SIDE-EFFECT import (`import './x'`), which is a
      // value import with no binding -- the worst kind here, so it counts.
      if (!clause) { report(); continue; }
      // `import type { ... }` / `import type X` is erased at compile time.
      if (clause.isTypeOnly) continue;
      // A default or namespace binding is always a value import.
      if (clause.name) { report(); continue; }
      const bindings = clause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) { report(); continue; }
      // `import { type A, B }` -- inline type modifiers. Only a non-type
      // specifier makes it a value import.
      if (bindings && ts.isNamedImports(bindings) && bindings.elements.some(element => !element.isTypeOnly)) report();
      continue;
    }
    // `import x = require('...')`, and `export ... from '...'` re-exports,
    // which pull the target in at runtime just as an import does.
    if (ts.isImportEqualsDeclaration(statement)) offenders.push(statement.getText(source));
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && !statement.isTypeOnly
      && reachesOutsideTheRegistry(statement.moduleSpecifier.getText(source))) {
      offenders.push(statement.moduleSpecifier.getText(source));
    }
  }
  return offenders;
}

describe('#634: the engine bundle\'s daemon sources stay within the registered runtime', () => {
  for (const file of BUNDLED_DAEMON_SOURCES) {
    test(`${file} has no unregistered value imports`, () => {
      expect(valueImportsOf(file)).toEqual([]);
    });
  }

  /**
   * The guard has to be able to SEE a violation, or it is decoration. Each
   * shape below is the one a well-meaning edit would actually reach for.
   */
  test('the guard reports every shape of value import', () => {
    const fixtures: Record<string, string> = {
      'default.ts': `import boundedReceiptText from '../../roles/untrusted';\n`,
      'named.ts': `import { boundedReceiptText } from '../../roles/untrusted';\n`,
      'mixed.ts': `import { type Foo, boundedReceiptText } from '../../roles/untrusted';\n`,
      'namespace.ts': `import * as untrusted from '../../roles/untrusted';\n`,
      'sideEffect.ts': `import '../../roles/untrusted';\n`,
      'reexport.ts': `export { boundedReceiptText } from '../../roles/untrusted';\n`,
    };
    for (const [name, text] of Object.entries(fixtures)) {
      writeFileSync(join(import.meta.dir, name), text);
      try {
        expect(valueImportsOf(name)).toEqual(["'../../roles/untrusted'"]);
      } finally {
        rmSync(join(import.meta.dir, name));
      }
    }
    // A value import of the SIBLING registered source is allowed, because the
    // registry already carries that file's content into the bundle hash. This
    // is the shape `piece-effect-guard.ts` actually uses.
    for (const specifier of REGISTERED_SPECIFIERS) {
      writeFileSync(join(import.meta.dir, 'sibling.ts'), `import * as sibling from '${specifier}';\nvoid sibling;\n`);
      try {
        expect(valueImportsOf('sibling.ts')).toEqual([]);
      } finally {
        rmSync(join(import.meta.dir, 'sibling.ts'));
      }
    }
    // And the two forms that are genuinely erased are NOT reported, so the
    // guard does not block the imports these files are allowed to have.
    for (const text of [
      `import type { ActionCategory } from '../../roles/authority';\n`,
      `import { type ActionCategory } from '../../roles/authority';\n`,
    ]) {
      const source = ts.createSourceFile('ok.ts', text, ts.ScriptTarget.ESNext, true);
      const statement = source.statements[0]!;
      expect(ts.isImportDeclaration(statement)).toBe(true);
      const clause = (statement as ts.ImportDeclaration).importClause!;
      const erased = clause.isTypeOnly
        || (clause.namedBindings !== undefined && ts.isNamedImports(clause.namedBindings)
          && clause.namedBindings.elements.every(e => e.isTypeOnly));
      expect(erased).toBe(true);
    }
  });

  /**
   * The file this test exists to protect must not be reachable from either
   * bundled source, however indirectly.
   */
  test('piece-effect-receipt.ts is not named by either bundled source', () => {
    for (const file of BUNDLED_DAEMON_SOURCES) {
      const text = readFileSync(join(import.meta.dir, file), 'utf8');
      // Mentioned in prose is fine and intended; imported is not.
      expect(text).not.toMatch(/^\s*import[^\n]*piece-effect-receipt/mu);
    }
  });
});
