/**
 * Build a tool set that matches what a real daemon registers.
 *
 * `BUILTIN_TOOLS` is 33 tools; a running daemon registers nine more from
 * factories, plus eight site-builder tools when sites are enabled. Measuring
 * only the builtins understates the schema budget badly, and it hides the
 * tools that matter most to the economics -- `manage_workflow` alone is the
 * single largest schema in the product.
 *
 * The list itself now lives in `src/actions/tools/production-registry.ts`, so
 * this benchmark and `src/authority/builtin-tool-coverage.test.ts` measure
 * and guard the same set. Two copies drifting apart is how #503 happened.
 */

export { buildProductionRegistry, type ProductionRegistry } from '../../src/actions/tools/production-registry.ts';
