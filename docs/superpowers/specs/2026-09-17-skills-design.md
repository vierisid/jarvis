# Skills: replayable procedures with authority, integrity and replay guarantees

A skill is a stored sequence of steps that address UI elements by durable
SemanticRef and carry postconditions. `run_skill` replays it over the
structural runtime; `record_skill` compiles one from a demonstration;
`manage_skills` lists and deletes. Code: `src/skills/`, `src/vault/skills.ts`,
`src/actions/tools/skills.ts`, `sidecar/recorder*.go`.

## Invariants this protects

**Authority**

- A run is gated on the worst case across the skill's stored steps, never on
  the tool name. Every acting step is at least `control_app`; a step is raised
  by its declared `effect` or by the classifier (`src/skills/effects.ts`):
  Send in a mail app is `send_email`, Enter in a messaging composer is
  `send_message`, Pay/Checkout is `make_payment`, Delete/Discard is
  `delete_data`. A step whose action the runtime does not know is gated as
  `delete_data` and the run is refused before anything is dispatched.
- The approval card names what will actually happen, with resolved parameter
  values ("click Send (sends email)"), never "run a skill". Parameters marked
  secret, or named like one, are shown as `[secret]`.
- A worst case above the agent's level becomes an approval card, not a
  denial, provided the agent clears `control_app` on its own. Only a pure
  level shortfall qualifies: an override, a context rule or a profile cap
  that denies still denies. A voice session never gets this substitution.
- `record_skill start` always needs the person's confirmation on a card,
  whatever the agent's level, the overrides or the learned approvals say. A
  voice session cannot start it; a sub-agent is denied it; the card cannot be
  approved by voice.
- Every gate site (orchestrator text path, realtime path, sub-agent runner)
  resolves the call through `resolveToolGate`. The workflow effect boundary
  refuses `record_skill` and `manage_skills` as opaque; `run_skill` reaches it
  through the gated adapter that runs this same per-step resolution
  (`docs/superpowers/specs/2026-09-18-workflow-run-skill-effect.md`).
- On the chat paths, `run_skill` and `record_skill` results are framed as
  outside content and taint the turn. A flow's step output is not framed: the
  workflow route frames no tool result, `run_skill` included.

**Integrity**

- Every `skills` row carries an HMAC-SHA256 over its reviewed content (name,
  app, description, match, params, steps, provenance, version, enabled),
  keyed by a per-install secret in the keychain. A row whose MAC does not
  verify, or that has none, is listed as not runnable and never replayed.
- `record_skill stop` never overwrites an existing name. Replacing a reviewed
  skill takes a gated delete (`delete_data`) and a new recording.

**Recording**

- Hooks are installed only after the person approves the card. They come out
  at a hard cap (default 10 minutes, sidecar-enforced) whether or not the
  brain ever sends `recorder_stop`, on `recorder_stop`, and when the sidecar
  loses its brain connection. A failed hook install is an RPC error, never
  `{"recording": true}`.
- While hooks are installed the pebble shows the working state with a
  "Recording a skill" line, and a native notification marks the start and
  the end.
- Keystrokes are never transmitted. The committed field value is read from
  the UIA Value pattern at flush time; a password field yields no value.
  Brain-side redaction (secure flag, field-name hints, card, `sk-` and long
  hex patterns) runs before anything is buffered. The recorder listener is
  the only consumer of `ui_interaction`; the generic sidecar-event listener
  skips it, so the raw value reaches no dashboard socket and no coalescer
  slot. A step always carries `{{param}}`, never a literal. The text typed
  during the demonstration is kept as that param's default, so the skill runs
  as demonstrated and the approval card can name what will be typed; a value
  the redaction rules flagged has no default, is marked secret and must be
  supplied at run time. What the redaction rules miss is therefore stored.

**Replay**

- The recorder computes the same SemanticRef the snapshot walk would emit
  for the same element (same name limits, ancestry path from the top-level
  window, raw-view sibling ordinal), so the resolver's sig rung re-finds it.
- Self-heal never re-dispatches. A failed postcondition climbs re-observe,
  settle, report; the action is dispatched exactly once and an unconfirmed
  step fails the run with that said plainly.
- Every postcondition is evaluated against the surface captured before the
  step. `title_changed` and `window_appeared` fail on an unchanged surface;
  `surface_changed` (the compiler's default for a terminal click) holds only
  when the element is gone, the title changed or new content appeared.
- Each step carries its surface; a browser step replays on the browser
  provider, and the seeds run on it. Recording cannot produce one yet: the
  Windows recorder stamps every interaction `surface: "desktop"`
  (`interactionPayload` in `sidecar/recorder_windows.go`), so a browser skill
  has to be authored, not demonstrated.

## What this does not guarantee

- The effect classifier is heuristic. An author or the recorder can under-
  describe a button ("Continue" that charges a card). The floor is
  `control_app`; declaring `effect` on a step is how an author closes that gap.
- Redaction is heuristic too (secure flag, field-name hints, card, `sk-` and
  long hex patterns). Typed text it does not flag lands in the vault as a
  parameter default. A secret typed into a field the rules do not recognise is
  stored until the skill is deleted.
- Recording is Windows only. macOS and Linux refuse `recorder_start`.
- Recording has been exercised on a Windows machine: that is how the event
  envelope, the click attribution and the Jarvis-panel defects were found,
  each read off a live `sidecar.log`, and a recording there produced the
  expected steps. Replaying a recorded skill end to end has not been
  validated on a real machine. The COM paths carry no automated coverage
  either: `uiaClickedElement`, the hosting-window lookup and `isOwnWindow`'s
  Windows half only compile in CI, so a change to them is verified by hand.
  The decisions they make are pulled out into `recorder.go` -- `clickAttribution`,
  `ownWindowVerdict`, `pressSiteStillApplies`, `packPoint`, `pointInRect` --
  where they are tested on every platform; what remains untested there is the
  syscalls and the COM calls themselves.
- The recorder records only desktop surfaces, so a demonstrated skill never
  contains a browser step (see Replay).
- A click is attributed to the window that received it, recorded in the mouse
  hook when the button went down (`clickSite` in `sidecar/recorder_windows.go`,
  decided by `clickAttribution` in `sidecar/recorder.go`, which is unit-tested
  on every platform). Resolution still happens ~60ms later, so the recorder
  now **drops** a click it cannot place instead of guessing, and a dropped
  click is a step the demonstration silently lacks. Every drop the decision
  makes is logged with its reason (a click lost to a full event queue in the
  hook is not: that one predates this and is still silent). Four cases drop
  by design:
  - the window that received the click no longer exists by the time UIA is
    asked. A menu item and a dialog button destroy their own window when
    invoked, so those clicks are usually lost. This replaces a worse
    behaviour rather than a working one: before, the late hit test landed on
    whatever had taken that window's place and recorded a confident step
    against it. Recovering these needs the element read before the settle,
    which is its own change.
  - another window held the mouse capture (dismissing an open menu by
    clicking away is the common case), so the window under the pointer
    received nothing.
  - the window's handle has since been reused by another process, which is
    a destroyed window by another name.
  - nothing could be established about where the click went.
- What a click can still be misattributed to: an overlay that genuinely takes
  the click is recorded as itself, and a window that re-lays-out its own
  contents within the settle can hand back a different control of the *same*
  window. A drag is recorded as a click where it was released. Attribution
  across windows -- the app-switch case -- is what the click-time capture
  fixes.
- A skill's `match` context (URL, process) orders the prompt index by
  message text today; the active window is not yet threaded into it.
