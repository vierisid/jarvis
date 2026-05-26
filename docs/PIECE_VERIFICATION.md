# Piece verification guide

How to verify a piece is wired correctly end-to-end -- from source on disk all the way to a workflow run inside the engine subprocess. Applies to Jarvis-authored pieces (under `src/workflows/activepieces/packages/pieces/jarvis/`) and to community pieces installed at runtime via the pieces library.

If a piece works through every stage below, it is fully integrated. If it stops working at stage N, the section "What fails at each stage" at the bottom tells you where to look.

## TL;DR -- happy path

1. Write piece source under `packages/pieces/jarvis/<name>/src/`.
2. Restart the daemon. No manual build command needed.
3. Watch the daemon log for `catalog built with N piece(s)` and no extraction failures for your piece.
4. Open the workflows editor. Add the piece via the library picker. Configure it. Run.
5. Confirm the step output in the runs panel matches the action's `outputSample`.

That's it for the well-trodden path. The sections below cover what to check when something is off.

## Stage 1 -- source shape

A piece is one `createPiece` call plus one `createAction` (or `createTrigger`) per surfaced operation. The minimum viable shape:

```ts
// packages/pieces/jarvis/my-piece/src/index.ts
import { createPiece, PieceAuth } from "@activepieces/pieces-framework";
import { greetAction } from "./lib/actions/greet";

export const myPiece = createPiece({
  displayName: "Jarvis: My Piece",
  description: "One-line, user-facing description.",
  auth: PieceAuth.None(),
  minimumSupportedRelease: "0.0.0",
  logoUrl: "",
  authors: ["jarvis"],
  actions: [greetAction],
  triggers: [],
});
```

```ts
// packages/pieces/jarvis/my-piece/src/lib/actions/greet.ts
import { createAction, Property } from "@activepieces/pieces-framework";

export const greetAction = createAction({
  name: "greet",
  displayName: "Greet",
  description: "Return a greeting for the given name.",
  outputSample: { message: "Hello, Alice!" },
  props: {
    name: Property.ShortText({
      displayName: "Name",
      description: "The name to greet.",
      required: true,
    }),
  },
  async run(context) {
    const name = context.propsValue["name"];
    if (typeof name !== "string") throw new Error("greet: name must be a string");
    return { message: `Hello, ${name}!` };
  },
});
```

Verify each of:

- [ ] `package.json` is present at the piece root with `name: "@jarvispieces/piece-jarvis-<short>"`, a `version`, and `"main": "./dist/src/index.js"`.
- [ ] Every action declares `outputSample` matching the exact shape its `run()` returns. Without this, the variable picker is blind and downstream steps cannot reference the action's outputs.
- [ ] Every trigger declares `sampleData` (upstream-native -- the same role as `outputSample` but for triggers).
- [ ] `auth` is set explicitly. Use `PieceAuth.None()` if the piece doesn't need credentials. Setting it to `undefined` looks the same in the editor as `None` but disables the connection picker.
- [ ] `run()` throws on bad input (don't silently return `null`). Engine logs the thrown error verbatim in the step's failure trace.

## Stage 2 -- build

The daemon's bootstrap runs `buildAllJarvisPieces()` on every start with content-hash caching. New piece directories are auto-discovered. You do not need to run `bun run build:workflows` manually unless you want to verify the build offline before restarting.

To verify the build path explicitly:

```bash
bun run build:workflows
# expected output:
#   built @jarvispieces/piece-jarvis-<short>@0.0.1
#     bundle: /home/<you>/.jarvis/cache/pieces/<hash>/<short>/dist/src/index.js
```

After build, the piece's `dist/` lives under `~/.jarvis/cache/pieces/<piece-hash>/<short>/`. The hash mixes the engine bundle hash, so framework changes invalidate every piece automatically.

Verify:

- [ ] `~/.jarvis/cache/pieces/<hash>/<short>/dist/src/index.js` exists.
- [ ] Running `bun run build:workflows` a second time prints `cached` rather than `built` for your piece.

## Stage 3 -- daemon bootstrap

Restart the daemon. Watch the log for the engine bootstrap line:

```
[Daemon] bundle + pieces + sandbox api ready in <N>ms
[Daemon] catalog built with <N> piece(s)
```

If you see `catalog built with K piece(s), <M> extraction failure(s)`, one or more pieces failed to extract metadata. Failures persist in `~/.jarvis/cache/piece-metadata.json` as part of the cache write (since the partial-cache fix), and the daemon prints the failing package name and error.

Verify:

- [ ] The piece's package name appears in `~/.jarvis/cache/piece-metadata.json` under `entries[].name`.
- [ ] If the piece declares auth, its catalog entry has `auth: { type: "SECRET_TEXT" | "OAUTH2" | "BASIC_AUTH" | "CUSTOM_AUTH", ... }`, not `auth: null`.
- [ ] Every action listed under `entries[].actions` has a non-empty `outputSample`.

Run the audit script to summarise picker coverage across all pieces:

```bash
bun run scripts/audit-piece-outputs.ts
# Markdown table of every piece + action with declared / missing outputSample.
# Use --json for machine-readable output.
```

If the daemon was already running with stale cache before your changes, the cache key may not have changed enough to invalidate. Bump `CATALOG_SCHEMA_VERSION` in `src/workflows/runtime/piece-catalog.ts`, or just delete `~/.jarvis/cache/piece-metadata.json` and restart.

## Stage 4 -- catalog API

The daemon exposes the projected catalog over HTTP. Hit it directly to confirm the piece's shape is what the UI sees:

```bash
curl -s http://localhost:3142/api/workflows/pieces \
  | jq '.[] | select(.name == "@jarvispieces/piece-jarvis-<short>")'
```

Verify:

- [ ] `displayName`, `description`, `logoUrl` look right.
- [ ] `auth` is present (or absent + `null` when piece declared `PieceAuth.None()`).
- [ ] Each action has `name`, `displayName`, `props`, and `outputSample`.
- [ ] Required props are flagged `"required": true` in their `props` entry.

## Stage 5 -- engine extraction (deep dive)

If the catalog API returns the piece but its shape looks wrong, the issue is in metadata extraction. The engine runs `EXTRACT_PIECE_METADATA` against the piece's bundle in the sandbox. To reproduce:

```bash
# Tail the daemon log while the catalog rebuilds:
DEBUG=1 bun start

# Or run the engine-extract test against a real piece (e.g. gmail when installed):
JARVIS_GATED_REAL_PIECE_TESTS=1 bun test src/workflows/runner/engine-runtime/extract-piece-metadata.test.ts
```

The two most common extraction failures:

- `PieceNotFoundError: Piece not found for package: @jarvispieces/piece-jarvis-<short>-<version>`. The engine couldn't find your piece in its dev-pieces list. This is now auto-discovered via `discoverJarvisDevPieces()` in `engine-runtime.ts` -- if you see this, confirm `packages/pieces/jarvis/<short>/package.json` exists and has a valid `name`.
- `Cannot read property 'parse' of undefined` (or similar). The bundle didn't include something the framework expects. Re-run `bun run build:workflows --force` and check the esbuild output.

## Stage 6 -- visual editor

Open the daemon UI, create a workflow, and add your piece:

- [ ] Open the piece library (left side of the editor canvas). Your piece appears in the list with its `displayName` and description. Use the search bar to filter by name if the list is long.
- [ ] Click the piece tile. A new node is added to the canvas and pre-selected.
- [ ] The settings popover opens with the action picker. Each action's `displayName` appears in the dropdown.
- [ ] Pick an action. The props form renders one widget per declared property, in declaration order.
- [ ] Required props show a red asterisk and refuse to save when empty.
- [ ] If the piece has auth, the connection picker appears at the top of the settings popover. The first available connection auto-fills.
- [ ] Click a downstream step. The variable picker on its inputs shows your piece's `outputSample` fields as draggable chips. Drag-insert a field and confirm the template renders as a chip in the input.

## Stage 7 -- run

Click **Run** in the editor's runs panel. Watch the live progress overlay:

- [ ] The piece's node lights up `RUNNING`, then `SUCCEEDED` (or `FAILED`).
- [ ] Click the node. The bottom drawer shows the step input on the left and the step output on the right.
- [ ] The output JSON matches the shape declared in `outputSample`. If `outputSample` says `{ message: string }` but the actual output is `{ result: { message: string } }`, the variable picker on downstream steps will dereference the wrong field. Fix `outputSample` to match what `run()` returns.

For pieces with auth, use the **test this step** affordance (the run icon on the node's right-click menu) so you can iterate on credentials without running the whole flow.

## Stage 8 -- tests

Three test layers, run from cheapest to most expensive:

1. **Unit test the action in isolation.** Construct a fake `context` with `propsValue`, `auth`, and `store`, call `await action.run(ctx)`, assert on the output.

   ```ts
   import { greetAction } from "../src/lib/actions/greet";

   test("greets", async () => {
     const ctx = { propsValue: { name: "Alice" } } as any;
     await expect(greetAction.run(ctx)).resolves.toEqual({ message: "Hello, Alice!" });
   });
   ```

2. **Catalog drift detection.** `src/workflows/runtime/test-fixtures-drift.test.ts` rebuilds the catalog from your dev tree and compares against the committed test fixture. If your piece's catalog shape changed intentionally, regenerate the fixture; if not, the test surfaces the drift.

3. **Engine-extract smoke (gated).** For pieces with auth, the engine-extract test exercises `EXTRACT_PIECE_METADATA` against a real installed piece. Gate it with `JARVIS_GATED_REAL_PIECE_TESTS=1` so CI doesn't require Gmail credentials.

## What fails at each stage

| Symptom | Stage | Where to look |
|---|---|---|
| Piece doesn't appear in `bun run build:workflows` output | 2 | `package.json` missing or malformed under `packages/pieces/jarvis/<short>/` |
| `PieceNotFoundError` in daemon log | 3 | `discoverJarvisDevPieces()` in `engine-runtime.ts` -- check the piece dir has a `package.json` with a `name` field |
| Catalog says `auth: null` but piece declared auth | 4 | `metadataToCatalogEntry` projection in `piece-catalog.ts`; bump `CATALOG_SCHEMA_VERSION` |
| Catalog has the piece but actions have no `outputSample` | 4 | The action source -- `outputSample` is required on every `createAction` |
| Piece appears in library but action props are empty | 5 | The piece bundle didn't include the action files. Re-run with `--force` |
| Connection picker missing in editor | 6 | Catalog `auth` is null (see row above) |
| Variable picker on downstream step doesn't show piece outputs | 6/7 | `outputSample` shape mismatch with what `run()` actually returns |
| Step runs but downstream `{{step.field}}` is undefined | 7 | Same -- align `outputSample` with `run()` return value |
| `Unexpected EOF JSON parse` from the compose tool when describing a flow that uses this piece | external | LLM output truncated. Check `max_tokens` (Ollama maps it to `num_predict`) |

## When introducing a brand-new piece

Just drop a new directory under `packages/pieces/jarvis/<name>/`. Restart the daemon. Everything else is automatic:

- `buildAllJarvisPieces()` walks the directory and builds it (content-hash cached).
- `discoverJarvisDevPieces()` walks the same directory and adds it to the engine's dev-pieces list.
- The catalog re-extracts because the piece-hash mix changed.
- The library API surfaces it on next refresh.

If you ever find yourself editing a hardcoded piece list to register a new piece, something has regressed -- the registration should be implicit from the filesystem.

## When upgrading a community piece (pieces library)

Community pieces ship pre-built from npm and live under `~/.jarvis/pieces/node_modules/@activepieces/`. Verification flow:

1. Open the pieces library, click **Install** (or **Update** if already installed).
2. Wait for the install footprint indicator to show the package landed.
3. Catalog refreshes hot -- no daemon restart needed.
4. Walk Stages 4 / 6 / 7 above. Stages 1-3 don't apply (you didn't write the source).

If the catalog refresh doesn't see the new piece, the bundle cache may be holding a stale entry. The install path invalidates the bundle cache automatically; if it didn't, delete `~/.jarvis/cache/piece-metadata.json` and restart.
