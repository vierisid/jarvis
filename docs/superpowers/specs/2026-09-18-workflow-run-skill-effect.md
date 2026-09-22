# Running a skill from a workflow: the run_skill effect adapter

A flow step `jarvis-tool invoke { toolName: "run_skill", params: { name, params } }`
replays a recorded or authored skill through the workflow effect boundary.
Code: `src/workflows/runtime/effect-capabilities.ts` (`GATED_TOOLS`,
`gatedCapability`), `src/workflows/runtime/effect-boundary.ts` (folded
categories, card intent), `src/actions/tools/skills.ts` (`authorityGate`
subject, typed outcomes).

## Why an adapter and not a bounded entry

A skill is a click sequence, which is exactly what the boundary refuses for
`desktop_click` and friends: a category label cannot describe an arbitrary
click. A skill is different in one way that matters: its steps are stored,
reviewed content with a per-step classification (`src/skills/effects.ts`),
the same one the chat gate uses. The adapter does not add a second
classifier; it runs the tool's own `authorityGate` at review time with the
frozen arguments and builds the effect from what it returns.

## Invariants this protects

- The effect is gated on what the skill does, never on the tool name. Every
  category the stored steps reach is checked and the decisions fold the way
  the chat gate folds them: a denial wins, then an approval, labelled with
  the category that asked for it. The effect record keeps the worst case.
- The approval card names the effect with the resolved parameter values
  ("click Send (sends email)"), not "run a skill". Secret parameters show as
  `[secret]`.
- The effect target carries the skill's name, version and surface, and the
  sidecar the run is pinned to. A skill re-recorded after review, or a run
  that would land on another computer, blocks dispatch with the boundary's
  existing "target changed after review" and machine-binding checks.
- Dispatch happens once. A replay returns the durable result; a failed
  dispatch is never retried automatically.
- Failure is typed (#478). A skill that cannot run (unknown, disabled,
  integrity check failed, bad parameters, no capable sidecar) is `blocked`
  with `effect: not_started`. A skill that stops part way is `error` with
  `effect: may_have_occurred`, because its earlier steps did run and the
  failed step was dispatched once. The chat path renders the same message.
- An unknown skill is refused before any effect record exists, and the
  refusal is audited under the tool's static category.
- Recording and deleting skills stay chat-side (`record_skill`,
  `manage_skills` remain opaque to flows).

## What this does not guarantee

- The workflow engine checks Authority at the configured default level. A
  skill whose worst case sits above that level is denied, not offered as a
  card; the chat path's above-level substitution is not applied to flows,
  consistent with the governed pieces.
- The card's category is the one that asked for approval. A config that
  governs `send_message` sees a Slack-sending skill; a config that governs
  nothing lets a `control_app`-only skill run without a card, as it would any
  bounded tool at that level.
- The skill's own limits apply: replay needs the app or page on screen, the
  effect classifier is heuristic, and a declared `effect` on a step is how an
  author closes a gap the classifier misses.
- The result is not framed as outside content on this path. `run_skill` quotes
  live field text, so its step output is data an attacker may have written,
  and a later step can interpolate it into an `ask` prompt. That is true of
  every perception tool the route already allows (`read_file`,
  `get_clipboard`, `desktop_snapshot`, `desktop_find_element`,
  `desktop_list_windows`, `browser_snapshot`, `capture_screen`): the workflow
  route frames no tool result, unlike the chat paths, which wrap all of them
  through `src/roles/untrusted.ts`. `run_skill` joins that set rather than
  opening a new one, and framing the route is its own change.
