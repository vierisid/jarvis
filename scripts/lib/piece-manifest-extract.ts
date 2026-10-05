/**
 * Child process for `piece-manifest.ts`: load one piece bundle and print its
 * actions as one JSON line on stdout. Runs with a scrubbed environment; see
 * that file for why.
 *
 * Usage: bun scripts/lib/piece-manifest-extract.ts <path to the bundle's main>
 */
const entry = process.argv[2];
if (!entry) {
  console.error("usage: piece-manifest-extract.ts <bundle entry>");
  process.exit(2);
}

type ActionLike = {
  name?: unknown;
  classification?: unknown;
  props?: Record<string, unknown>;
  displayName?: unknown;
  description?: unknown;
};

const mod = require(entry) as Record<string, unknown>;
// A piece module exports the piece next to helpers (auth, clients). The piece
// is the export that carries an action map.
const pieces = Object.values(mod).filter(
  (x): x is { _actions?: Record<string, ActionLike>; actions?: () => Record<string, ActionLike> } =>
    typeof x === "object" && x !== null && ("_actions" in x || typeof (x as { actions?: unknown }).actions === "function"),
);
if (pieces.length !== 1) {
  console.error(`expected exactly one piece export, found ${pieces.length}`);
  process.exit(1);
}
const piece = pieces[0]!;
const actions = typeof piece.actions === "function" ? piece.actions() : piece._actions ?? {};

const text = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : undefined);
const out = Object.values(actions).map((a) => ({
  name: String(a.name),
  classification: typeof a.classification === "string" ? a.classification : null,
  props: Object.keys(a.props ?? {}).sort(),
  displayName: text(a.displayName, 120),
  description: text(a.description, 400),
}));
out.sort((a, b) => a.name.localeCompare(b.name));
console.log(JSON.stringify(out));
