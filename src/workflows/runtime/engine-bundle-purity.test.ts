/**
 * Daemon sources compiled INTO the engine bundle may only import values
 * from other registered, checked sources, or from `node:` builtins, which the
 * bundle leaves to the runtime (#634).
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
 * SCOPE, stated because it is narrower than "the bundle is pure": this checks
 * the governed-piece sources and permits imports only within that checked
 * set, plus real `node:` builtins (not bundle inputs). A new dependency must be registered in `PATCHED_VENDOR_SOURCES` AND
 * included here, so its imports receive the same checks.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { builtinModules } from 'node:module';
import ts from 'typescript';
import { PATCHED_VENDOR_SOURCES } from '../runner/engine-runtime/build';

/** Relative to this directory. All must also be cache-invalidation inputs.
 * managed-github, managed-trello, managed-mailchimp, managed-slack, managed-dropbox, managed-asana, managed-intercom, managed-calendly, managed-airtable, managed-typeform, managed-notion and managed-linear, managed-todoist, managed-monday and managed-figma are the
 * engine's fetch-only send adapters, and hubspot-contact is the HubSpot
 * contact input validation the adapter table uses; checking them here
 * prevents a future dependency from silently escaping the bundle hash. */
const BUNDLED_DAEMON_SOURCES = ['piece-effects.ts', 'piece-effect-guard.ts', 'decision-document.ts', 'hubspot-contact.ts', 'managed-github.ts', 'managed-trello.ts', 'managed-mailchimp.ts', 'managed-slack.ts', 'managed-dropbox.ts', 'managed-asana.ts', 'managed-intercom.ts', 'managed-calendly.ts', 'managed-airtable.ts', 'managed-typeform.ts', 'managed-notion.ts', 'managed-linear.ts', 'managed-todoist.ts', 'managed-monday.ts', 'managed-monday-inputs.ts', 'managed-wrike.ts', 'managed-wrike-inputs.ts', 'managed-pipedrive.ts', 'managed-pipedrive-inputs.ts', 'managed-figma.ts', 'managed-zoom.ts', 'managed-zoom-inputs.ts', 'managed-help-scout.ts', 'managed-help-scout-inputs.ts', 'managed-gitlab.ts', 'managed-gitlab-inputs.ts', 'managed-webflow.ts', 'managed-webflow-inputs.ts', 'http-egress.ts', 'engine-console-redaction.ts'];

/**
 * A value import of ANOTHER registered source is fine, and is the one shape
 * that exists today: `piece-effect-guard.ts` imports `isGovernedPiece` and
 * `sanitizePieceInput` from `piece-effects.ts`. The registry already covers
 * that file's content, so the bundle hash follows it. What this guard is for is
 * a value import that reaches OUTSIDE the registry.
 */
const REGISTERED_SPECIFIERS = new Set(BUNDLED_DAEMON_SOURCES.map(file => './' + file.replace(/\.ts$/u, '')));

/**
 * A `node:` builtin is not a bundle input at all: the bundle targets node and
 * leaves every builtin to the runtime, so it cannot carry stale daemon code
 * into a cached engine. `http-egress.ts` (the egress guard and the #1153
 * read-host scope) imports only builtins, and is registered here and in
 * `PATCHED_VENDOR_SOURCES` because `piece-effects.ts` and
 * `piece-effect-guard.ts` import values from it.
 */
const isNodeBuiltin = (specifier: string): boolean =>
  /^node:[a-z_/]+$/u.test(specifier) && builtinModules.includes(specifier.slice('node:'.length));

const reachesOutsideTheRegistry = (specifier: string): boolean => {
  const bare = specifier.replace(/^['"]|['"]$/gu, '');
  return !isNodeBuiltin(bare) && !REGISTERED_SPECIFIERS.has(bare.replace(/\.ts$/u, ''));
};

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

describe('#634: the engine bundle\'s daemon sources stay within the checked registry', () => {
  test('every permitted runtime dependency is included in the bundle hash', () => {
    const registeredSources: readonly string[] = PATCHED_VENDOR_SOURCES;
    for (const file of BUNDLED_DAEMON_SOURCES) {
      expect(registeredSources).toContain('../../runtime/' + file);
    }
  });

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
    // A builtin is allowed only spelled as `node:`, the form the bundle leaves
    // to the runtime; a bare name could be a package of the same name.
    writeFileSync(join(import.meta.dir, 'builtin.ts'), `import { isIP } from 'node:net';\nimport { lookup } from 'dns';\nimport { x } from 'node:fss';\nvoid isIP; void lookup; void x;\n`);
    try {
      expect(valueImportsOf('builtin.ts')).toEqual(["'dns'", "'node:fss'"]);
    } finally {
      rmSync(join(import.meta.dir, 'builtin.ts'));
    }
    // A value import of the SIBLING registered source is allowed, because the
    // registry already carries that file's content into the bundle hash. This
    // is the shape `piece-effect-guard.ts` actually uses.
    writeFileSync(join(import.meta.dir, 'sibling.ts'), `import { isGovernedPiece } from './piece-effects';\nvoid isGovernedPiece;\n`);
    try {
      expect(valueImportsOf('sibling.ts')).toEqual([]);
    } finally {
      rmSync(join(import.meta.dir, 'sibling.ts'));
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
