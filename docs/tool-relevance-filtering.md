# Tool relevance filtering: authority-aware design

Design for the tool-relevance filter requested in #483, after the version
proposed in #475 was rejected. **Nothing here is on by default.** The filter
ships off, behind a model-eligibility gate and a config/env kill switch, with
a benchmark harness so the default can be flipped on evidence later.

Read #483 first. This document does not re-argue its measurements; it starts
from them. Every byte figure below was measured by walking the real registry,
not estimated - see §10 for how to reproduce them.

---

## 1. Threat model

### 1.1 The filter as an attack surface

The filter takes a tool list and returns a subset. Two properties make that
security-relevant rather than merely a token optimisation:

1. **Its input is attacker-steerable.** The selection reads the conversation.
   Anyone who can drive a channel turn - an email that becomes a message, a
   Slack DM, an observer event summarised into the transcript, a web page the
   agent was asked to read - can put words in it. The adversary picks the
   subset.
2. **Removing a tool changes which tool the model reaches for.** A model that
   cannot see `browser_navigate` and can see `run_command` fetches the page
   with `curl`. Removal is not a no-op on behaviour; it is a redirection.

Together: the attacker gains no tool - the ceiling is always the full
registered set, today's behaviour - but the attacker chooses which of the
model's existing capabilities it will use for a given job.

### 1.2 Authority laundering via tool removal

The blocking hazard, and why #475 was rejected.

Outside content reaches the model two ways:

- **Framed tools.** `isUntrustedSourceTool(name, category)` is true
  (`src/roles/untrusted.ts`). The result is wrapped in
  `<<<UNTRUSTED_CONTENT ... UNTRUSTED_CONTENT>>>`, run through
  `defangDelimiters()` so the payload cannot forge the boundary, preceded by
  `untrustedPreamble()`, and - except `read_file` - marks the turn tainted for
  `isTaintSourceTool`, which the authority engine's taint gating consumes.
- **Unframed tools.** `run_command` above all: a shell is a general-purpose
  fetcher, it is not in `UNTRUSTED_TOOL_NAMES`, its category is `terminal`
  not `browser`, so its output is neither wrapped, nor defanged, nor
  taint-marking. It arrives as plain, trusted-looking context.

`src/roles/untrusted.ts` already names this hazard class, in the comment that
put `ui_snapshot` and `ui_act` in the set:

> Without these two the framing and the taint gate could be sidestepped by
> preferring `ui_snapshot` over `browser_snapshot`, which is exactly what the
> tool guide tells the model to do.

#475 reopened the same sidestep through another door. Its floor kept
`run_command`; a "knowledge" message (research / document / note / remember /
draft) dropped every `browser_*`, every `desktop_*`, `ui_snapshot`, `ui_act`
and `capture_screen`. The only remaining way to fetch outside content was the
unframed one. The filter *systematically shifted the model toward the
highest-authority tool available*: it deleted the purpose-built low-authority
readers (`access_browser`, `read_data`) and kept the `execute_command` one.

Call this **authority laundering**: the content still enters the context, but
stripped of the framing, the defanging and the taint mark the rest of the
system depends on. Nothing in the authority engine fires - from its point of
view a shell command ran and returned text.

The steerability from §1.1 turns this from an accident into a capability:
keyword-stuffing "research", "summarise", "draft a note" forces the
substitution on the next turn.

### 1.3 Secondary hazards

- **Mid-task stripping.** #475 filtered on the first user message only. A
  follow-up ("now remember that I did that") removed `ui_act` and
  `browser_navigate` from a task using them. Losing a tool mid-task is a
  denial-of-capability an attacker can also aim, and it is indistinguishable
  to the model from "this system cannot do that", so the model improvises.
- **Silent capability loss.** A model that cannot see a tool substitutes
  rather than reporting a gap. A filter that can be wrong needs a way for a
  wrong guess to cost a round trip instead of a capability.
- **No kill switch.** #475's `toolFilterEnabled` was a private field with no
  setter, no config key and no env var.
- **A fail-open that never fires.** `filtered.length >= ALWAYS.size` could not
  be satisfied: `ask_for_clarification` is appended after filtering and
  `request_approval` is conditionally registered.

### 1.4 Out of scope

- The filter is **not** an authority control and must never be described as
  one. `src/authority/` stays the control. The filter may only shrink what the
  model is offered; every tool it offers is gated exactly as today.
- Prompt injection inside framed content. Framing is the existing mitigation;
  this work must not weaken it.
- Fixing the authority-map gaps found while writing this (§11). They are real
  and pre-existing; the filter is designed to be safe in spite of them.

---

## 2. Classifying the tools

Two orthogonal axes. Axis A is taken from machinery that already exists, so it
cannot disagree with how a tool is actually gated. Axis B is the part this
design adds, and §2.4 explains why each class is drawn where it is.

### 2.1 Axis A - authority rank

`severityRank(getActionForTool(name, category))` from
`src/authority/tool-action-map.ts`: the same number the gate sites use.

**With one correction.** `getActionForTool` used to fall through to
`read_data` (rank 100) for any tool absent from both `TOOL_ACTION_MAP` and
`CATEGORY_ACTION_MAP` - which would score an unmapped shell as a level-1
read. So for filter purposes:

> **An unmapped tool has rank infinity.** Never floor-eligible, always a
> union trigger.

This was not hypothetical. `manage_workflow` (category `automation`) and all
eight site-builder tools (category `site-builder`), including
`site_run_command` - a second `Bun.spawn(['sh','-c',cmd])` - were unmapped and
resolved to `read_data`. #503 fixed the map itself and made the fallback fail
closed to `execute_command`; see §11. The rank-infinity rule stays regardless,
so the filter does not depend on the map staying complete.

### 2.2 Axis B - outside reach

How the tool's result enters the context, and whether the model can aim the
tool at something outside the conversation:

| class | meaning |
|---|---|
| `framed` | `isUntrustedSourceTool(name, category)` is true. Wrapped, defanged, (mostly) taint-marking. |
| `fetch` | The model can direct it at content **outside** the conversation, and the result is not framed. |
| `replay` | Returns stored text of mixed provenance, but the model **cannot aim it outside** - it can only read back records this system already holds. |
| `inert` | The model cannot aim it outside, and its result is generated by us or by a machine the owner paired. |

Note the definition of `inert`. An earlier draft said "cannot carry
outside-authored text at all", and that is **false in this codebase** for
most of the set: `write_file`, `set_clipboard` and `get_system_info` all
begin `const target = params.target ?? autoTargetForCapability(...)` and, on
any install with a matching sidecar, return the remote's reply verbatim with
no model input at all. What actually separates `inert` from `fetch` is
**aimability**, and that is the property the invariant depends on.

`reach` is the **worst reach across all of a tool's actions**. Most of these
are action multiplexers - `manage_goals` has 17 - so adding an action means
re-deciding the tool's class.

`framed` is fully derived from the existing predicate - no table, no drift.
The other three are declared, and the polarity is deliberate:

> **An undeclared tool is `fetch`.**

A newly registered tool therefore defaults to the most conservative class: it
can never be floor-eligible, and retaining it pulls the framed perception set
back in. Mis-declaring a new tool costs tokens. It cannot silently become the
laundering door.

### 2.3 Why `replay` is on the safe side of the invariant

This is the load-bearing judgement in the design, so it is stated explicitly
rather than assumed.

A first draft of this document classified anything that can return
outside-authored text as unframed. That is the intuitive reading, and it is
wrong in both directions.

It is **too broad**: `content_pipeline get`, `create_document get`,
`commitments`, `manage_goals`, `research_queue list` and `manage_skills list`
all return stored strings whose ultimate origin may be a web page. Treating
them as laundering doors makes almost every turn pull in the full framed set
and the feature saves nothing.

It is also **the wrong test**. The hazard in §1.2 is *substitution*: the model
wants to read something outside, the framed route is gone, so it takes the
unframed route. The question is therefore not "can this tool's output contain
outside-authored bytes" but:

> **Can the model aim this tool at content of its own choosing from outside
> the conversation?**

No model asked to summarise `https://example.com/post/1` calls `commitments`
instead. There is no substitution pressure, because the model cannot point
`commitments` at a URL. And the text those tools replay was already reaching
the model unframed *before* this filter existed - retaining them is a
non-regression, not a new door.

Two consequences, both enforced:

1. `replay` tools are **droppable and never floor-eligible.** They are not
   privileged into the always-set, which is where the first draft put them and
   which would have been strictly worse than the status quo.
2. `replay` does **not** trigger the framing union.

There is a second, independent argument for the same conclusion, and it is
the sturdier one: `commitments.what`, `content_pipeline.title`/`tags` and the
goals summary are already injected into the **system prompt on every
subsequent turn** by `buildPromptContext`, unframed and un-defanged, in the
highest-trust position in the context, droppable by no filter. Whatever these
tools replay was reaching the model unframed long before this filter existed.
Retaining them is a non-regression regardless of the aiming argument.

### Three tools that look like `replay` and are not

The aiming test has to be applied to what each tool can actually do, not to
what its name suggests. Three are on the other side:

- **`commitments` is `fetch`, and it is the most aimable tool in the
  product.** `create(what, when_due)` schedules an unattended agent turn
  whose **entire text the model writes**. A commitment created by this tool
  has no `commitment_work` row, so the executor's
  `getDueCommitments({excludeWorkItems: true})` picks it up and
  `executeCommitment` dispatches `handleMessage(prompt, 'system')` with
  `[COMMITMENT EXECUTION - MANDATORY] ... Execute it NOW using your tools ...
  browser, terminal, file operations`. The default cancel window is **5
  seconds** (`heartbeat.aggressiveness` defaults to `aggressive`), and the
  output returns through `commitments get` as `Result: ...`, unframed. That
  is strictly more aiming power than `manage_workflow`: not a choice among
  stored workflows, but free text executed with no human turn in between, no
  audit row and no emergency check. Classifying it `replay` would have left
  it as the only tool standing on a "remind me" turn - an unhardened,
  unaudited escape hatch sitting next to the hardened one.
- **`research_queue` is `fetch`.** `add(topic, ...)` enqueues work (a URL is
  a legal topic) and `list` replays a stored `result`. It is harmless *today*
  only because its consumer is dead code: `ResearchQueue.getNext`,
  `.startResearch` and `.complete` have had no callers since the heartbeat
  was removed, so `result` is never populated. The class, the tool and the
  daemon wiring all still exist for someone to re-land. Making the safety of
  this filter depend on a deletion that nothing enforces is not acceptable;
  it costs 859 bytes to not do that.
- **`list_sidecars` is `replay`, not `inert`.** It concatenates `hostname`,
  `os`, `capabilities` and each unavailable capability's `reason`, all of
  which come straight off the sidecar's own `register` /
  `capabilities_update` frame with no validation. The model aims nothing, so
  it is not a substitution route - but it emphatically must not sit in a
  floor that no input can remove.

`manage_workflow` is the remaining boundary case and lands on `fetch`: its
`run` action executes a composed workflow that can contain an HTTP step, and
`get_run` returns those step outputs.

### 2.4 The table

Rank is `level * 100 + tie` (`severityRank`). `inf` marks a tool with no
explicit `TOOL_ACTION_MAP` entry (§2.1). Bytes are the emitted JSON schema.
FLOOR is computed by the §3 rule; the column shows what it evaluates to today.

| tool | category | action | rank | reach | bytes | class |
|---|---|---|---|---|---|---|
| `browser_navigate` | browser | access_browser | 504 | framed | 1040 | DROP |
| `browser_snapshot` | browser | access_browser | 504 | framed | 390 | DROP |
| `browser_click` | browser | access_browser | 504 | framed | 731 | DROP |
| `browser_type` | browser | access_browser | 504 | framed | 896 | DROP |
| `browser_hover` | browser | access_browser | 504 | framed | 586 | DROP |
| `browser_press_key` | browser | access_browser | 504 | framed | 746 | DROP |
| `browser_scroll` | browser | access_browser | 504 | framed | 588 | DROP |
| `browser_screenshot` | browser | access_browser | 504 | framed | 313 | DROP |
| `browser_upload_file` | browser | write_data | 302 | framed | 534 | DROP |
| `browser_evaluate` | browser | execute_command | 506 | framed | 494 | DROP |
| `desktop_snapshot` | desktop | read_data | 100 | framed | 678 | DROP |
| `desktop_find_element` | desktop | read_data | 100 | framed | 983 | DROP |
| `desktop_list_windows` | desktop | read_data | 100 | framed | 385 | DROP |
| `ui_snapshot` | ui | read_data | 100 | framed | 1123 | DROP |
| `ui_act` | ui | control_app | 505 | framed | 1658 | DROP |
| `run_skill` | ui | control_app | 505 | framed | 914 | DROP |
| `record_skill` | ui | control_app | 505 | framed | 1145 | DROP |
| `read_file` | file-ops | read_data | 100 | framed | 446 | DROP |
| `get_clipboard` | general | read_data | 100 | framed | 327 | DROP |
| `run_command` | terminal | execute_command | 506 | **fetch** | 883 | DROP |
| `capture_screen` | general | read_data | 100 | **fetch** | 330 | DROP |
| `desktop_screenshot` | desktop | read_data | 100 | **fetch** | 527 | DROP |
| `list_directory` | file-ops | read_data | 100 | **fetch** | 471 | DROP |
| `delegate_task` | delegation | spawn_agent | 101 | **fetch** | 754* | DROP |
| `manage_agents` | delegation | spawn_agent | 101 | **fetch** | 1275* | DROP |
| `manage_workflow` | automation | write_data (floor) | 302 | **fetch** | 2599 | DROP |
| `manage_skills` | ui | read_data | 100 | replay | 440 | DROP |
| `list_sidecars` | sidecar | read_data | 100 | replay | 503 | DROP |
| `create_document` | documents | write_data | 302 | replay | 1163 | DROP |
| `content_pipeline` | content | write_data | 302 | replay | 1569 | DROP |
| `commitments` | tasks | write_data | 302 | **fetch** | 1420 | DROP |
| `manage_goals` | goals | write_data | 302 | replay | 1405 | DROP |
| `research_queue` | productivity | read_data | 100 | **fetch** | 859 | DROP |
| `desktop_click` | desktop | control_app | 505 | inert | 1131 | DROP |
| `desktop_type` | desktop | control_app | 505 | inert | 549 | DROP |
| `desktop_press_keys` | desktop | control_app | 505 | inert | 556 | DROP |
| `desktop_launch_app` | desktop | control_app | 505 | inert | 1322 | DROP |
| `desktop_focus_window` | desktop | control_app | 505 | inert | 427 | DROP |
| `write_file` | file-ops | write_data | 302 | inert | 555 | DROP |
| `set_clipboard` | general | write_data | 302 | inert | 414 | DROP |
| `get_system_info` | general | read_data | 100 | inert | 360 | **FLOOR** |
| `request_approval` | authority | read_data | 100 | inert | 1546 | **FLOOR** |

`*` The two delegation tools are built by a factory that embeds the registered
specialist list in the description, so their real size grows with the number
of specialists; the figures are for a single-specialist registry and are a
lower bound.

Not in the table and handled separately: the eight `site-builder` tools,
registered into the live orchestrator registry only when sites are enabled
(`src/daemon/index.ts`). Since #503 each carries an explicit action
(`site_run_command` and `site_create_project` are `execute_command`, the
writes `write_data`, the two reads `read_data`), so the rank-infinity lock no
longer applies to them. Being undeclared here they are class `fetch`, which
is what keeps them out of the floor and makes them union triggers - and
`coverage.test.ts` now pins that reach for all eight by name, because `reach`
is the only lock left.

`ask_for_clarification` is not a registry tool - it is synthetic and appended
after filtering; see §3.

Notes on the non-obvious rows:

- **`capture_screen` / `desktop_screenshot` are `fetch`.** They hand the
  vision model whatever is on screen, and an image cannot be delimiter-framed
  - which is why they are `TAINT_ONLY_TOOLS` rather than
  `UNTRUSTED_TOOL_NAMES`. Taint is a real control but it is not framing.
- **`delegate_task` / `manage_agents` are `fetch`.** A sub-agent can browse
  and reports in its own unwrapped words; the model writes the task, so it
  aims it. Their Authority level is 1 (`spawn_agent`), so a rank-based rule
  would have missed them entirely - this is why reach is a separate axis. They
  are taint-marking, which delegation shares with the screenshot tools.
- **`list_directory` is `fetch`.** Filenames are attacker-authored strings
  (anything in a downloads directory) and the model chooses the path.
- **`desktop_click` and friends are `inert`** - they act and return a status,
  they cannot read. They are droppable on rank: at 505 they are exactly the
  "privileged tools" #483 asks be filtered rather than kept.

---

## 3. The invariants

The contract. Each is stated formally and each gets a test whose fixtures are
derived from `BUILTIN_TOOLS`, so a future edit that breaks one fails the
suite.

`A` is the tool list the call site would otherwise send, and `S` is what the
filter returns. Both contain **registry tools only**.

`SYNTHETIC` - `ask_for_clarification`, `discover_tools`, the realtime nav
tools - is appended by the call site *after* filtering, which is how
`ask_for_clarification` already works today. The invariant layer never sees
them. An earlier draft passed synthetic names into the checker so they could
be exempted from trigger detection; probing that version showed the exemption
list was itself the hole - naming a *real* tool in it (`['run_command']`)
suppressed it as a trigger and let the framed readers be dropped while the
shell stayed. There is now no such parameter to misuse, and `A⁺` is a notion
the checker no longer needs.

Two structural rules on the returned set, both regressions from that probing:

- **The output is rebuilt from `A` by name.** The candidate contributes names,
  never objects. Duplicates therefore cannot reach the provider (a repeated
  tool name is an API error at most of them), the order is always `A`'s (a
  reshuffle would invalidate the cached prefix for nothing), and a caller
  cannot pass a stub that reuses a registered tool's name while carrying a
  different schema.
- **A candidate tool absent from `A` fails open**, rather than being carried
  into the result.

- `FRAMED(X)` = `{ t ∈ X : reach(t) = framed }`
- `PERCEPTION(X)` = `FRAMED(X)` minus a named set of framed *actors* - the framed *readers*
- `TRIGGER(X)` = `{ t ∈ X : reach(t) = fetch ∨ rank(t) > 504 }`
- `FLOOR(X)` = `{ t ∈ X : reach(t) = inert ∧ t has an explicit TOOL_ACTION_MAP entry ∧ rank(t) ≤ 100 }`

### I1 - Framing non-regression

> **If `S` retains any trigger tool, `S` retains every framed perception tool
> that `A` had.**
>
> `TRIGGER(S) ≠ ∅  ⟹  PERCEPTION(A) ⊆ S`

Contrapositive, the enforcement form and exactly #483 requirement 4: *if any
framed perception tool is dropped, every unframed-fetch tool and every
above-`access_browser` tool is dropped with it.*

`TRIGGER` deliberately includes `rank > 504` as well as `fetch`. Without that
clause, `S = FLOOR(A) ∪ {desktop_click, desktop_type, ...}` - the desktop
actuators at rank 505 with no perception tool at all - would be
invariant-clean, and that is a steerable substitution of the same family
(`browser_click` at 504 replaced by `desktop_click` at 505). It happens to
fail safe today because `rawUiGate` forces a review card on raw desktop
mutations, but that is luck, not an invariant.

Consequences, each directly testable:

- There is no input, tier, config combination or call site for which `S`
  contains `run_command` and is missing `browser_navigate`, `ui_snapshot`,
  `desktop_snapshot`, `read_file` or `get_clipboard` (when those are in `A`).
- Keyword-stuffing cannot produce such a set: the repair does not read the
  message and runs on every computed set, admissions included.

**Repair rule: union, never subtraction.** A violating set is fixed by
`S := S ∪ PERCEPTION(A)`, not by `S := S \ TRIGGER(A)`. Both restore I1. Union
is chosen because it only ever moves `S` toward `A` - it cannot remove a
capability the task needs - whereas subtraction would let a crafted message
delete `run_command` from a turn where the person genuinely asked to run a
command: a steerable denial-of-capability, a new bug of the same family.

**The union is `PERCEPTION`, not all of `FRAMED`** - the framed *readers*,
excluding three named framed *actors*: `browser_upload_file`, `run_skill` and
`record_skill`. Measured: 11,384 B rather than 13,977 B.

Membership is **not** a rank test, and two earlier drafts got this wrong in
opposite directions:

- **Rank was too permissive.** `browser_upload_file` maps to `write_data`
  (302), so a `rank ≤ 504` rule swept it in - auto-adding a tool that *sends
  a local file out* to every turn that happened to retain the shell.
- **Rank was too strict.** `ui_act` is 505, but `get_value` is in its own
  `READ_ONLY_ACTIONS` and its `authorityGate` returns `null` for it: 505 is
  the floor for the tool's **worst** action, not the rank of a read.
  `expand` and `scroll_into_view` are likewise the only way to make collapsed
  or off-surface content appear in the next `ui_snapshot`. Excluding it left
  the desktop surface with framed eyes and no framed hands - the model can
  see a collapsed Details pane but not open it - and what it reaches for
  instead is `capture_screen` / `desktop_screenshot`, which are `fetch` and
  cannot be delimiter-framed. That is the same substitution one surface
  sideways.
- `browser_evaluate` is included for the matching reason on the web surface.
  It is framed, it is the only way to read state `browser_snapshot` cannot
  express (JS state, shadow DOM, a canvas-rendered table), and it is
  `execute_command`/506 - *exactly the same rank as `run_command`*. Dropping
  the framed one while keeping the unframed one is a rank **tie**, not a step
  down, and that is precisely the family this invariant exists to stop.

`run_skill` and `record_skill` stay out: `run_skill` needs a skill the person
already recorded in their own catalogue, `record_skill start` always forces a
confirmation card, and neither is a reading route a model substitutes toward.
Re-admitting the system-wide-input-hook installer next to the shell on a "run
this script" turn is a bad distractor for exactly the small models this
targets.

Note the first draft justified union as "adds strictly lower-authority
tools". That was false - `FRAMED` contains four tools at rank 505/506, two of
which are now deliberately in the union anyway.

### I2 - Monotone exposure within a conversation

> **A tool the conversation has used or admitted is never taken away.**
>
> For turns `n < m` in one conversation: `LEDGER_n ⊆ LEDGER_m ⊆ S_m`

This is how requirement 3 is met, and it is stronger than "re-filter per
turn": nothing a task is using can be stripped by a follow-up. Mid-task
stripping becomes structurally impossible rather than a case the heuristic
must get right.

What I2 does NOT promise, stated because an earlier version of this section
claimed `S_n ⊆ S_m` outright: a tool that was only ever *selected* - offered
because a trigger matched, never called - can drop out once its trigger
text scrolls out of the bounded selection window (§8). While the text stays
in the window the selection is monotone too, because every trigger,
including the unmatched default, is evaluated over text that only grows.

**It does not hold by reading the conversation.** An earlier draft claimed it
did. Two independent reasons that is false in this codebase:

1. `AgentInstance.addMessage` accepts only `'user' | 'assistant' | 'system'`
   and has no `tool_calls` parameter and no `'tool'` role
   (`src/agents/agent.ts`). `processMessage` and `streamMessage` persist only
   `addMessage('assistant', finalText)`; every assistant-with-tool-calls and
   every tool result lives in the loop-local buffer and is discarded at turn
   end. So "tools already called" and "admissions" are unrecoverable across a
   turn boundary on the two highest-traffic loops - which is #483's repro case
   exactly. (`processTaskCall` and the sub-agent loop do persist whole
   buffers; they are fine.)
2. `addMessage` calls `compactHistory(...)` past a retention threshold, which
   drops the oldest chunks. The input is not append-only.

So monotonicity is carried by an explicit **grow-only ledger** instead:

```
ToolExposureLedger := a set of tool names that only ever grows
  seedFromMessages(msgs)   scan assistant tool_calls + discover_tools results
  noteUsed(name)           after each dispatch
  noteAdmitted(names)      on a discover_tools admission
  snapshot()               read-only copy
```

One ledger per conversation: keyed by the primary agent's id for the chat
loops (`ledgerFor(primary.id)`), the SAME primary ledger seeded additionally
from `opts.history` for `processTaskCall`, and a local seeded from
`resume.messages` for the sub-agent. `processTaskCall` used to take a fresh
ledger per task, which on the router-first path - where each task sees only
the user's latest message and the dialogue rides in as system context the
selection does not read - was the mid-task strip again: task 1 "open
example.com" used `browser_navigate`, task 2 "now do the same for the second
result" was offered none of it. The primary lives as long as the daemon, so
in practice the chat ledger is process-lifetime and shared across channels:
one channel's tool use widens every other's set. That is the safe direction,
and it makes the steady state converge toward the full list. `S` is then a pure function of
`(A, ledger, conversation text, policy)`, and monotone because the ledger is.
Compaction can shrink the text, but it cannot shrink the ledger, so it cannot
shrink `S`.

After a daemon restart the ledger starts empty and re-seeds from whatever
history is reloaded. The worst case is a smaller set on the first turn after a
restart; no task is in flight across a restart, and `discover_tools` recovers
it. This is stated rather than hidden.

### I3 - Subset and floor

> `S ⊆ A` and `FLOOR(A) ⊆ S`.

The filter never invents a tool, and the low-authority always-set is present
whenever registered. `FLOOR` is computed from `A`, so a conditionally
registered tool that is absent is simply absent - no count, no threshold. This
is the fix for #483 defect 4: **a set containment check against the actual
input list, never a length comparison against a hard-coded name list.**

I1 is likewise quantified over `PERCEPTION(A)` - what the call site actually
registered, not some global ideal. A scoped sub-agent registry of
`[run_command, read_file, write_file, list_directory]` has no browser tool to
restore, so keeping the shell there is that agent's status quo rather than a
regression this filter introduced. The filter must never add a tool the call
site did not offer, and a test pins that.

### I4 - Escape hatch present

> Whenever `S ⊂ A` (something was dropped), the call site appends
> `discover_tools` to what it sends.

Checked at the filter entry point rather than inside the invariant layer,
since that layer deals only in registry tools. Appending an `inert` synthetic
cannot violate I1, so the two checks are independent.

### I5 - Fail open, loudly

> If any of I1-I4 fails on the computed `S`, or the filter throws, the call
> site is handed `A` unchanged, a **counter is incremented** and the tool
> names involved are logged (rate-limited, not once-per-process).

The filter is an optimisation; its failure mode is "no optimisation", never "a
smaller set we could not verify". A nonzero violation counter is a release
blocker for flipping the default (§10).

---

## 4. Model eligibility gate

#483 requirement 1: frontier models unaffected.

Two mechanisms, in priority order. The earlier draft had four, of which two
could never fire (eight of its nine "local runtime" provider names do not
exist in `LLMProviderKind`) and one was inert (`max_params_b` was OR'd with a
signal that already won).

1. **Explicit allowlist.** `tools.relevance_filter.models` lists
   `"provider:model"` refs to treat as eligible. Deterministic, cannot go
   stale, and it is the only mechanism the benchmark needs.
2. **Ollama with a parameter cap.** Provider kind `ollama` *and* an anchored
   parameter tag at or below `max_params_b` (default 20):
   `/(?:^|[-:_])(\d+(?:\.\d+)?)b(?:$|[-_.])/`. Anchoring matters -
   an unanchored `(\d+)b` scan reads `qwen3-30b-a3b` as 3B and
   `mixtral-8x7b` as 7B, both in the unsafe direction. `ollama` is the only
   local runtime in `LLMProviderKind`; LM Studio, llama.cpp and vLLM all
   arrive as `openai_compatible`, which carries no signal and is therefore
   never auto-eligible - such deployments must use the allowlist.

A **frontier veto** overrides both: a model id matching `claude`, `gpt-4`,
`gpt-5`, `o1`/`o3`/`o4`, `gemini-*-pro`, `grok`, `sonnet`, `opus` or `haiku`
is never eligible. Anything unrecognised is also never eligible. The polarity
is the point: a stale classifier stops the filter helping, it never starts it
running somewhere unmeasured.

Three sharp edges, all of which the gate must handle and an earlier draft did
not:

- **Failover changes the model, and `TIER_FALLBACK` is not the whole story.**
  `chatTier` walks `tierCandidates(tier)` on failure, and later candidates
  are a different provider and model. But `streamTierWithFallback` also
  retries on a tier the **caller passes as an argument**, and
  `agent-service` calls `streamMessage(..., 'conversation', ..., 'medium')`
  while `TIER_FALLBACK.conversation` is deliberately empty - the
  conversation tier's presence is a mode switch, not a fall-up. So
  `tierCandidates('conversation')` never contains the `medium` assignment,
  and a gate built on it alone clears a small local conversation model and
  then hands the filtered list to the frontier task model the instant the
  local one errors before first output. **The gate refuses to filter unless
  every candidate in `tierCandidates(tier) ∪ tierCandidates(fallbackTier)`
  is eligible**, and `fallbackTier` is threaded to the decision point.
- **A model-less candidate is unclassifiable, and that turns the filter
  off.** `tierCandidates` deliberately appends `{provider}` entries with no
  model id, to recover a provider's own default - and nothing exposes what
  that default is. Those candidates can never be classified, so they are
  ineligible, so the gate refuses. With `TIER_FALLBACK.low = ['medium','high']`
  that means **any tier map with a cloud provider anywhere in the chain
  disables the filter entirely**, which is the common "local conv model,
  cloud task tiers" shape. This is a deliberate fail-safe, not an oversight,
  but it has a consequence worth stating plainly: on most mixed installs the
  allowlist is not a convenience, it is the only route.
- **`kind` lives in config, not the manager.** `LLMProvider` exposes only
  `name`; `TierAssignment.model` is optional. Classification reads the
  post-DB-merge `config.llm.providers`, passed in via
  `setToolFilterProviders` rather than frozen inside the policy, because the
  `llm` section is hot-reloadable. When it is absent the classifier reads a
  provider's kind from its *name*, which is right for the canonical entries
  and fails closed for custom-named ones.

`getRealtimeTools()` has no tier at all and the realtime model is named by the
connect URL, not the tier map - see §6.

**The escape hatch goes on the wire as a hand-written schema**, not through
`toolDefToLLMTool`. That converter copies only `type`, `description` and
`enum`, because `ToolParameter` has no `items` field - so a `ToolDefinition`
with an array parameter emits `{"type":"array"}` with no element type, which
Gemini's function-declaration schema rejects. That path is reachable: the
allowlist is deliberately checked before the frontier veto so an operator
can benchmark whatever they like.

---

## 5. The escape hatch

#483 requirement 2: a wrong guess must cost tokens, not a capability.

**`discover_tools`** - synthetic, in `S` only when something was dropped (I4).

- `discover_tools()` returns the full catalogue: every registered tool name
  with the first sentence of its description, each marked available or hidden.
- `discover_tools({ names: [...] })` admits those tools into the ledger. `S`
  is recomputed immediately (§6) so they are present on the next iteration.

Its description is where the model is told its list was trimmed - no prompt
surgery, and the notice travels with the mechanism that answers it. #475's
model had no reason to report a gap; this one is told there is one.

Admission is **not** exempt from the invariants: re-admitting `run_command`
re-admits `PERCEPTION(A)` with it, because normalisation runs on every
computed set.

The catalogue renders available-vs-hidden against **the set the model can
actually see**, not the registry. An earlier version passed the full
registry, so every tool read `[available]`, the model was told nothing was
hidden, and the discovery half of the hatch was dead while the `names` half
still worked. A test pins a `[hidden]` marker.

Three implementation points an earlier draft got wrong or omitted:

- **It is not an existing pattern.** `request_approval` is a *registered*
  registry tool whose authority check is bypassed by name; only
  `ask_for_clarification` is handled inline, and only at one of the four
  loops. So this is new inline branches at each site - and they call ONE
  shared function, `interceptDiscovery`, which takes the emergency check and
  the audit hook as required dependencies. Writing the contract in a comment
  and leaving each site to honour it was tried first, and the sub-agent site
  promptly had neither: a halted system still enumerated its catalogue
  there, and a sub-agent admission left no trace anywhere.
- **It must be gated and audited.** A synthetic inline tool bypasses the
  emergency controller and the audit trail. `discover_tools({names})` is
  attacker-steerable input that durably widens the exposed set, so it runs
  behind the emergency check and emits an audit row naming the admitted tools.
- **Batching with `ask_for_clarification` must not orphan a tool call.** The
  clarify branch pushes the assistant message carrying the *whole*
  `tool_calls` array but a `tool_result` for the clarify call only, leaving
  siblings unanswered - which providers reject on resume. That is a latent bug
  today; a second synthetic tool a confused small model may call alongside
  "I need more info" makes it likely. The branch must emit a result for every
  sibling call.

**Calls to tools the model was not offered** (`interceptOffList`). The
filter shapes only what is *offered*; the loops dispatch any registered name.
And a small model does call tools it was not offered, for a structural
reason: the Tool Guide in the static system prompt (`src/roles/tool-guide.ts`)
documents `run_command` and the browser tools by name whatever the filter
kept. Before this was handled, a turn offered only the floor and a goals tool
could call `run_command` with curl, have it run, and get the page back
unframed - I1 held on the list and not at dispatch, which is #475's
substitution through a side door. Now every loop treats such a call as the
admission it effectively is (ledger, an audit row named
`off_list_call(<tool>)` - never `discover_tools(...)`, which was not
called - and a recompute), and:

- if the tool is an invariant trigger and the offered set was hiding a
  framed reader, it is **not run** (audited as `denied`, `executed: false`,
  on every refusal): the model gets `[NOT RUN] ...`, and on
  its next step the tool is offered together with the framed readers, so it
  chooses again with the framed route in view;
- anything else (a framed reader, a trigger when no reader was hidden, an
  inert tool) runs exactly as it would unfiltered, and the set is recomputed
  so the rest of the turn is offered what it is actually using.

**A sub-agent's resume is checked against what the model was offered when
it chose the batch, not against a set recomputed from the checkpoint.** A
governed call can pause a sub-agent partway through a batch; the calls after
it (`SubAgentPause.remaining`) are dispatched on resume. A set recomputed
from the resumed buffer already reflects the model's own text ("let me check
by running a command" selects the shell group) and any `discover_tools`
admission from the same batch, so a shell the model picked while it was
hidden read as offered and ran - while the live loop, which holds the offered
set fixed for the whole batch, refuses the identical batch. The pause now
records `offered` (the exposed set at the time the batch was chosen) and the
resume checks `remaining` against it. A checkpoint written before the field
existed is read as "every tool that is not an invariant trigger was
offered" - its queued calls were never checked, so a queued trigger is
refused, while an ordinary call runs without being logged as an off-list
admission it probably was not - unless the model the run resolves to is
never filtered at all
(policy off, or an ineligible model), in which case it was offered
everything. That is decided by the gate (`FilterDecision.engaged`), not by
whether this turn's recomputed set happens to be full: the model's own text
can make it full, which is the same bypass.

Seeding a resumed buffer counts only calls that were answered, and not the
`[Not run: ...]` placeholders `processTaskCall`'s clarification branch
writes for skipped siblings: those neither ran nor were admitted, and
seeding them would widen the shared, process-lifetime primary ledger with no
audit row. An off-list refusal (`[NOT RUN]`) IS seeded, because the live
loop admitted that name, audited it, and told the model it may call it
again; a resume that forgot it would refuse the retry the live run allows.

`interceptOffList` fails **closed**, unlike `decideTools`: if the check
throws while the filter is on and the tool was not offered, the call is
refused, and the refusal is still audited. `decideTools` failing open sends
the full list, which only widens what is offered; the off-list equivalent
would run a tool chosen while hidden, which is what the check exists to
stop.

`admittedNames` also accepts the shapes small models actually send for
`names` - a stringified array (`'["browser_navigate"]'`) or a
comma-separated string - rather than answering "No such tool" to a
formatting slip.

Rejected alternative: detecting "I don't have a tool for that" in the model's
prose and re-running with the full list. Brittle text matching on a small
model's output is the kind of heuristic this issue exists to avoid, and it
pays the full-list token cost on every false positive.

---

## 6. Where `S` is computed, and every call site

**Once per user turn, held fixed across the whole tool loop**, recomputed only
on a widening: an explicit `discover_tools` admission, or a call to a tool
the model was not offered (§5).

Not per loop iteration. An earlier draft said per iteration, which is a
serious performance error: `src/llm/anthropic.ts` documents that Anthropic
renders **tools -> system -> messages**, so the tool list sits at the *head*
of the cached prefix and any change to it invalidates the cached tools *and
the entire system prompt behind them*. Per-iteration recomputation, combined
with a ledger that grows on every dispatch, would mean a full cache miss on
the largest static prefix in the request on every single iteration. The same
holds for a local model's prefill cache - measured at 646 s for a cold full
prefill on the hardware in §10.

So: tools used during a turn are noted into the ledger but take effect at the
*next* turn; only a widening changes `S` mid-turn - an admission, which is
the escape hatch's entire purpose, or an off-list call. `S` therefore
changes at most once per turn plus once per widening call. This still satisfies requirement 3 -
re-filtered every turn, over the whole conversation, never first-message-only.

| call site | method | coverage |
|---|---|---|
| chat | `AgentOrchestrator.processMessage` | per-turn, ledger keyed by primary agent id |
| task / resume | `AgentOrchestrator.processTaskCall` | per-turn, the primary's ledger, additionally seeded from `opts.history`; `ask_for_clarification` appended *after* the filter, so it is never in its accounting |
| streaming chat | `AgentOrchestrator.streamMessage` | per-turn, ledger keyed by primary agent id, `fallbackTier` passed to the gate |
| sub-agent | `runSubAgent` (`src/agents/sub-agent-runner.ts`) | per-turn, ledger seeded from `resume.messages`; provider kinds handed in by all three launchers (`delegate_task`, `manage_agents`, the workflow delegator) |
| background agent | `BackgroundAgentService`'s own `AgentOrchestrator` | the chat loops above, with provider kinds set at construction and on every `llm` reload |
| realtime voice | `AgentOrchestrator.getRealtimeTools` | routed through the gate, always ineligible - below |
| conversation tier | `ConvOrchestrator.processTurn` | **not** a registry site: it sends a fixed four-tool `CONV_TOOLS` list, so there is nothing to filter |

**The sub-agent site is where the invariant matters MOST, not least.** An
earlier draft claimed it saves nothing, citing `software-engineer`
(terminal + file-ops, four tools) and `research-specialist` (whose `tools:`
names no real categories, so its registry is empty). Both are true and both
are the wrong roles: `research-specialist` is a top-level role, not a
delegation specialist, and the default `delegate_task` target is
**`research-analyst`**, whose `tools:` is `[browser, terminal, file-ops]`.
That scoped registry is all ten `browser_*` plus `run_command`, `read_file`,
`write_file` and `list_directory` - 14 tools, about 8.7 kB, and exactly the
"drop the browser group, keep the shell" shape #475 was rejected for. Four
more specialists carry `browser + file-ops`.

The opposite case is also real and must not be "fixed": a registry that never
had a framed reader (`software-engineer`) keeps the shell without one,
because I1 is quantified over what the call site registered and the filter
must never add a tool the registry does not contain. A test pins both.

**Realtime is out of scope, by a principled decision rather than an
oversight.** A realtime session's tools are fixed at `buildSessionUpdate()`
time. A one-shot filter there would violate I2 and I4 at once: no per-turn
recompute, and `discover_tools` could not take effect because the session's
tool list cannot change - the escape hatch would be a dead end, which is worse
than no filter. The gate is asked and answers "ineligible: fixed tool list",
and that decision is tested. No config key is offered for it: an earlier draft
proposed one whose documented enablement path was never actually designed.
Re-sending `session.update` with a grown list is the only shape that could
work and it is a separate piece of work.

This is a deliberate reading of #483 defect 5. The complaint is that the token
claim did not hold product-wide and the path most likely to run a small model
was untouched. The answer is one gate for every call site with one invariant,
and honesty about the one that cannot meet the safety requirements yet - not
filtering it anyway.

**Two mechanical requirements** at every site: return `undefined`, not `[]`,
when the registry is empty (the providers behave differently), and preserve
`ToolRegistry.list()` order verbatim so a recompute never reshuffles the
cached prefix for no reason.

---

## 7. Kill switch

A real config key **and** an env var.

```yaml
# config.yaml - top-level, NOT in USER_OWNED_SECTIONS, so the file wins
tools:
  relevance_filter:
    enabled: false        # default. Nothing filters while this is false.
    max_params_b: 20      # ollama parameter cap (see §4)
    models: []            # explicit "provider:model" refs to treat as eligible
```

```
JARVIS_TOOL_FILTER=off   # forces off regardless of config
JARVIS_TOOL_FILTER=on    # forces on (benchmark / operator opt-in)
```

`off` wins over everything. The override goes in `applyEnvOverrides`, which
`loadConfig` calls both before and after the user-section discard, alongside
the existing `JARVIS_WAKE_ENGINE` / `JARVIS_REALTIME_VOICE` overrides.

**Why a new top-level section survives**, verified against the loader:
`loadConfig` deep-merges parsed YAML over `DEFAULT_CONFIG`, `deepMerge` copies
unknown keys through, the discard loop iterates only `USER_OWNED_SECTIONS`
(which does not contain `tools`), `mergeUserSettingsIntoConfig` likewise
touches only user sections, and there is deliberately no `saveConfig` to
rewrite the file.

A comment in `src/config/types.ts` used to say the opposite - that "a new
top-level key would be silently dropped on every load", which is why
`log_file_path` was nested under `daemon:`. It was over-broad and has been
amended narrowly as part of this work, so the next reader does not "restore"
a discard that does not exist. Verified empirically, not just by reading: a
`tools:` block survives `loadConfig` intact while the user-owned
`personality` section is correctly replaced by its default.

`DEFAULT_CONFIG` has **no** `tools` entry, so `config.tools` is `undefined`
unless the file supplies it. Absent means off; the `enabled: false` in the
sample below documents the default rather than creating it.
`config.example.yaml` carries the block, commented out, so the switch is
discoverable.

The policy is resolved at boot into a module-level holder whose hard-coded
initial value is `enabled: false`, so every path not wired to the daemon -
tests, scripts, a standalone sub-agent runner - is unfiltered unless it opts
in.

Two things are deliberately **not** frozen with it:

- **The env kill switch is re-read on every policy read.** It can only
  ever disable - it cannot enable something the resolved policy did not
  already allow - so re-reading it cannot turn the filter on by surprise.
  Be precise about what that buys, though, because an earlier version of
  this section claimed it made the switch take effect "on the next turn":
  nothing outside a running daemon can change that process's environment,
  and `tools` has no settings-reload applier. For an operator,
  `JARVIS_TOOL_FILTER=off` and `enabled: false` both take effect on
  **restart**. The per-read check helps tests and embedding hosts, nothing
  more.
- **Model classification** (§4), because the `llm` section is
  hot-reloadable. `setToolFilterProviders` is re-called from the `llm`
  reload applier: `mergeLLMSettingsIntoConfig` REPLACES
  `config.llm.providers` rather than mutating it, so a boot-time reference
  is detached on every settings save, and a provider re-pointed from a
  local endpoint to a remote one would otherwise still classify as local.

The config half of the switch still needs a reload to take effect.

On hosted installs neither `config.yaml` nor the process environment is
reachable by the account owner, so there the kill switch is an ops action.
With the default off that is tolerable, but it is not the universal
"set one env var and restart" an earlier draft claimed.

---

## 8. Selection

The part that is *only* an optimisation. Everything above constrains it; it
cannot break an invariant however wrong it is, because the invariants are
checked on its output against `A`.

Input: the concatenation of user and assistant text in the conversation,
lowercased, bounded to a recent window. Bounding is safe here precisely
because the ledger (I2) absorbs anything that scrolls out - a match that
disappears cannot shrink `S`. Unbounded scanning would be O(history x
patterns) on every turn against histories retained up to 200k tokens.

The trigger table ships in code (`TRIGGER_GROUPS` in `selection.ts`, which
is the source of truth - this copy is for reading) with a coverage test
asserting that every droppable tool in the **production registry** has at
least one entry. That test used to walk `BUILTIN_TOOLS` only, and so passed
while all eight site-builder tools had no trigger at all and were dropped on
every turn.

| group | tools | triggers (whole word, plain plural also matches) |
|---|---|---|
| browse | all ten `browser_*` | `https?://`, `www.`, a bare domain on a common TLD (`github.com`, `example.org`); url, web, website, webpage, page, browse, browser, article, link, online, google, search, internet, site, blog, news, research, summarise/summarize, competitor, landscape, dashboard, visit, navigate, hover, scroll, form, homepage, look up, lookup, price, weather, forecast, flight, recipe, shop, buy, reddit, youtube, gmail, wikipedia |
| perceive | `desktop_snapshot`, `desktop_find_element`, `desktop_list_windows`, `desktop_screenshot`, `capture_screen`, `ui_snapshot` | screen, window, see, look, showing, display, dialog, button, field, visible, onscreen, desktop |
| act_desktop | `desktop_click/type/press_keys/launch_app/focus_window`, `ui_act` | open, launch, start, click, type, press, key, keyboard, notepad, app, application, close, focus, switch, element, foreground, minimize, maximize |
| shell | `run_command` | run, command, terminal, shell, script, build, compile, test, install, npm, bun, git, log(s), process, restart, service, check, status, deploy |
| files | `read_file`, `list_directory`, `write_file` | path-like token, code fence; file, folder, directory, read, write, save, disk, path, download |
| clipboard | `get_clipboard`, `set_clipboard` | clipboard, copy, copied, paste |
| sidecars | `list_sidecars` | sidecar, machine, device, remote, paired, computer, laptop, pc |
| skills | `run_skill`, `record_skill`, `manage_skills` | skill, record, replay, macro, teach, demonstrate |
| delegation | `delegate_task`, `manage_agents` | delegate, agent, specialist, parallel, background, spawn |
| workflows | `manage_workflow` | workflow, automation, automate, schedule(d), recurring, daily, weekly, morning, trigger, every |
| goals | `manage_goals` | goal, objective, okr, target, milestone, ship |
| commitments | `commitments` | remind(er), remember, commit(ment), promise, todo, deadline, due, follow |
| documents | `create_document` | document, doc, note, memo, report, draft, write |
| content | `content_pipeline` | content, pipeline, idea, outline, publish, post |
| research | `research_queue` | research, queue(d), investigate |
| site builder | all eight `site_*` (registered only with `sites.enabled`) | build intent only: a making verb (build, make, create, code, generate, scaffold, spin up, whip up, put together) within 40 characters before a site noun (site, website, webpage, homepage, landing page, portfolio, html page), unless "account", "sign in", "log in", "sure", "summary", "report", "bookmark" or "shortcut" comes between the two (after the noun they do not count: "create a website with a login page" is a build); site builder, landing page, portfolio site, static site, html page, project directory. Not bare "website"/"homepage"/"my site" (a browse must not be offered `site_run_command`, a real shell), not "project"/"repo"/"commit"/"push" (ordinary dev chat), and not bare "html"/"css"/"template" ("fix the css in my react app") |

**The unmatched default.** A user message in the window that selects
nothing the call site can offer adds the browse group's **framed readers
that are not themselves invariant triggers** - never the shell, and not
`browser_evaluate` (rank 506, the shell's own rank, whose presence would
drag every desktop reader in by the I1 union) or `browser_upload_file` (a
framed actor that sends a local file out and must never be auto-added). Before it existed, "find the cheapest flight to
Tokyo", "visit example.org and tell me what it says" or "what are people
saying on reddit about the new iphone" got the floor and the hatch and
nothing else: three tools, and a small model holding three tools answers
from memory rather than calling `discover_tools`. A trigger table can never
enumerate every way to ask for something from outside, so the unmatched case
needs a default, and the default leans the way the whole design leans: when
the filter does not know what a turn needs, the outside-reaching tools it
offers are the ones that frame what they bring back. It can only add, so it
cannot break an invariant; its price is schema bytes on quiet turns
("hi", "thanks", "ok"): about 8 kB of browser schema for as long as such a
message stays in the window, with no repair union behind it. That is an
accepted trade, not an oversight.

It is applied **per user message**, not "the whole window matched nothing".
A whole-window rule never fires on "set a goal ..." followed by "find the
cheapest flight to Tokyo", and it would switch OFF the moment a later
message matched anything, so "hi" then "what is on my screen?" would drop
the browser tools turn 1 was offered. Per message, it only ever adds as the
conversation grows, like every other trigger. "Selects nothing" is judged
against the call site's own registry: a scoped browser-plus-shell sub-agent
asked to "set a goal" matches the goals group, whose tool it does not have.

The wrong-exclusion tests in `selection.test.ts` are generated from the
production registry: the first sentence of every droppable tool's own
description must keep that tool, which is the offline half of the
benchmark's `wanted tool dropped` line (0/65 now; it was 12 of the 54
cases the bench had before the browse cases were added - the eight
site-builder tools, `browser_hover`, `ui_act`, `desktop_focus_window`, and
`create_document`, whose own description says "documents").

Structural triggers #475 missed are first-class: a bare URL anywhere admits
the browse group (its `\burl\b` regex missed a pasted
`https://example.com/post/1`), and a code fence or path token admits files.

The path pattern is `(^|\s)[~.]?[/\\][\w.\-/\\]+` and the leading
`(^|\s)` is load-bearing: without it, the `/post` inside
`https://example.com/post/1` would admit the file group on **every** turn
containing a URL, dragging `list_directory` (a `fetch` tool) in and tripping
I1 on the design's own best case. Verified: that message fires the browse
group and not the file group.

Pipeline: `S := FLOOR(A) ∪ selected ∪ ledger`, normalise for I1, add
`discover_tools` if `S ⊂ A` (I4), verify I1-I4, fail open on any violation
(I5). Because the invariants are verified on the output, the heuristic can be
replaced wholesale - by embeddings, by a learned router - without re-reviewing
the security properties.

---

## 9. What this actually saves

Measured by running the filter over the real registry, not estimated.
Reproduce with `bun bench/tool-relevance/benchmark.ts`, which prints every
figure below and recomputes them from code, so they cannot go stale.

`A` = 50 tools, **38,760 bytes** of emitted JSON schema: the 33
`BUILTIN_TOOLS` at 22,445 B, nine daemon-registered tools, and the eight
site-builder tools registered when `sites.enabled` (the bench builds all of
them from `production-registry.ts`; figures before the #483 close-out
counted 42 tools and 35,050 B, without the site-builder eight). Calibrated
against a real tokenizer on `qwen38-fast` (27.3B, Q4_K, ollama): the full
33-tool set is **6,091 prompt tokens**, giving **~3.83 bytes/token** for
these schemas, so a bytes/4 estimate undercounts by about 8%.

Was 39,420 B before #504 trimmed the six fattest daemon descriptions; see
"The cheapest win" below for the before/after.

| set | tools | bytes |
|---|---|---|
| full `A` | 50 | 38,760 |
| `FLOOR(A)` | 2 | 1,906 |
| `PERCEPTION(A)` (the I1 union) | 16 | 11,384 |
| invariant triggers | 26 | 21,039 |
| `replay` | 5 | 5,080 |

The five cases from #483's own measurement table, plus its mid-task repro:

| case | tools | bytes | saving |
|---|---|---|---|
| `open notepad and type hello` | 24/50 | 17,900 | **-53.8%** |
| `research the competitor landscape and write it up` | 24/50 | 17,497 | **-54.9%** |
| `summarise this article https://example.com/post/1` | 21/50 | 16,018 | **-58.7%** |
| `set a goal to ship the release this week` | 4/50 | 3,936 | **-89.8%** |
| `schedule a daily check of the dashboard` | 22/50 | 17,931 | **-53.7%** |
| `open notepad` then `now remember that I did that` | 25/50 | 19,320 | **-50.2%** |

Over all 65 cases (the six above, eleven realistic browse asks, and one
generated per droppable tool): **-57.8% aggregate**, best -89.8%, worst
**-43.5%**, zero invariant violations, and the wanted tool kept in
**65/65** (12 of the then-54 cases dropped it before the #483 close-out's
selection fixes, §8). Bytes include
`discover_tools` as it goes on the wire, with `items` on its array.

The percentages are slightly *smaller* than before #504 because both arms
shrank: the filter now has less fat to remove. The absolute saving per case
is what improved.

Confirmed live against the real tokenizer, not only in bytes - but **before
#504**, against the 39,420 B registry: on `open notepad and type hello`,
`qwen38-fast` reported **10,404 prompt tokens unfiltered and 4,938 filtered,
-52.5%**, against the **-53.8%** the pre-#504 table predicted from bytes. The
model called `desktop_launch_app` correctly in both arms. The table above is
now taken over a different registry (50 tools, trimmed descriptions), so
these token counts corroborate the byte method, not the current row;
re-take the live run to confirm the current figure.

Four things worth saying plainly, because #475 was rejected partly for not
saying them:

1. **The worst case is about -40%, not -4%.** An earlier draft of this
   design computed the floor from `reach = none ∧ rank ≤ 302` and put the
   six fattest daemon tools into the *undroppable* floor. It measured -3.9%
   to -56.4% on these same cases. Shrinking the floor to two tools and
   adding the `replay` class is what moved it.
2. **Almost every realistic turn trips I1**, because `ui_act` and
   `browser_evaluate` are both framed readers *and* rank above
   `access_browser`. That is intended: the saving comes from dropping the
   tools a turn has no use for, not from dropping perception.
3. **A single trigger word pins the set for the rest of the session.** I2 is
   monotone, so one "check the build" in turn 4 holds the set at
   `FLOOR ∪ PERCEPTION ∪ ...` thereafter. The steady state of a long mixed
   conversation is nearer -50% than -89%.
4. **These are schema bytes. They are not the whole cost, and on a
   KV-caching runtime whether they are even a saving depends on the chat
   template.** The offline cache ESTIMATE (§10) replays five scripted
   conversations under a perfect one-request prefix cache. The filtered set
   changes on 9-13 of 16 follow-up requests; the unfiltered list never
   changes. What a change costs depends on where the template renders the
   tools:

   | template layout | example | prefill, filtered vs full |
   |---|---|---|
   | no prompt cache at all | many hosted small-model endpoints | **-32% to -44%** (bytes sent) |
   | tools, then system, then history | Anthropic's order (§6) | **+560% to +675%** |
   | same, token-exact reuse of the shared leading tools | llama.cpp / ollama on that layout | +410% to +545% |
   | system text, then tools, then history | Qwen 2.5/3, most HF templates | **+384% to +421%** |
   | tools inside the last user message | Llama 3.1's default template | **-40% to -54%** |

   Ranges span the two conversation shapes (separate, one session). Those
   percentages include the first request, which both arms pay cold; warm,
   the unfiltered arm on the first three layouts prefills well under 1 kB
   in total against 220-365 kB filtered. So: on a runtime that keeps its KV
   cache, with a template that renders tools before the history - which is
   most of them - the filtered arm is estimated to prefill **about 5-8x as
   much** as the unfiltered one; with tools rendered last, or with no cache,
   it prefills 30-55% less.
   Only a live `--cache` run on a real model and template settles it, and
   the result applies to that template only.

**The cheapest win needed none of this.** Those six daemon tool
descriptions were 14,072 B, 36% of the budget. #504 trimmed them to 9,702 B
with no invariant, no gate and no security review, because removing words
removes no capability. That is **-4,370 B (-31.1%) off the six, -11.1% off
every request**, and it compounds with the filter rather than competing with
it: the filter drops whole schemas, this shrinks the ones that remain -
including the floor that every request pays for regardless.

| tool | before | after | saving |
|---|---|---|---|
| `manage_workflow` | 4,785 | 2,599 | -45.7% |
| `content_pipeline` | 2,498 | 1,569 | -37.2% |
| `request_approval` | 1,902 | 1,546 | -18.7% |
| `commitments` | 1,841 | 1,420 | -22.9% |
| `create_document` | 1,597 | 1,163 | -27.2% |
| `manage_goals` | 1,449 | 1,405 | -3.0% |
| **six** | **14,072** | **9,702** | **-31.1%** |
| whole registry | 39,420 | 35,050 | -11.1% |
| every other tool | 25,348 | 25,348 | 0 |

`manage_goals` barely moved on purpose: 75% of it is parameters, ~540 B of
that is the structural floor of 12 param entries that no description edit can
touch, and the trim there was partly spent on an `enum` for its 16-value
`action` param. Bytes are not the only axis - see the note on enums below.

An earlier draft of #504 reached 9,356 B. Review put 346 B back, and each
restoration was information the emitted schema carried nowhere else: the
`list_runs` per-flow filter, the `empty` flag's steering toward `compose`
(shortened to "required by create", it read as a formality to satisfy and
invited the silent-empty-flow it exists to prevent), `request_approval`'s
imperative "You MUST call this FIRST", and the `commitments` /
`manage_workflow` cross-reference. Shorter was available; correct was not
shorter.

All figures here are the **no-library** `manage_workflow` build, which is what
`bench/tool-relevance/registry.ts` constructs. The daemon builds the *library*
variant (carrying the `suggestedInstalls` paragraph) for every install that is
not host-managed, i.e. the common one; there the numbers are 39,873 -> 35,297 B,
**-4,576 B / -11.5%** - slightly better than the headline, not worse.

Sizes are `JSON.stringify(toolDefToLLMTool(t)).length`, the unit the bench
uses. That counts UTF-16 code units, so it undercounts UTF-8 bytes wherever a
description carried a non-ASCII character; #504 removed the em dashes and
arrows from these six, so for all six the two measures now agree exactly.

---

## 10. What the benchmark measures

`bench/tool-relevance/`, runnable, **not** part of the test suite. Its
scoring (`metrics.ts`) is: `metrics.test.ts` pins the substitution rule, the
McNemar test and the cache model, since the live harness only ever runs
against a model nobody has had yet.

1. **Token cost** (offline, default). Schema bytes full vs filtered, per case
   and in aggregate, the `wanted tool dropped` count (wrong exclusion,
   measured without a model), and a **prompt-cache ESTIMATE** over five
   scripted multi-turn conversations (`CONVERSATIONS` in `cases.ts`): bytes
   sent, and bytes a perfect one-request prefix cache would still have to
   prefill for each of four template layouts (`CacheModel` in
   `metrics.ts`: tools-first, tools-first with token-exact reuse,
   system-first, tools-last), with and without the cold first request.
   These are not bounds: the sign itself depends on the layout.
2. **Tool-selection accuracy** (`--accuracy`). Each case names the tool a
   correct answer would call; the model is asked once with the full list and
   once with the filtered one, both behind the same system prompt (the Tool
   Guide by default; `--system-file` for a captured production prompt,
   `--no-system` for none). The Tool Guide matters: it names every tool
   whatever the filter kept, which is exactly when a small model calls a tool
   it was not offered. A `discover_tools` call is answered as the loops
   answer it, and an off-list call `interceptOffList` would refuse is
   refused, and the model is asked again (up to two rounds); what is scored
   is the tool it finally commits to. Reported:
   - correct / no-call per arm, and the paired **discordant counts** with an
     exact McNemar p. "Within noise" is a non-inferiority margin, not a
     significance test: the filter may lose, net, at most 2% of the paired
     cases and never less than one. The first version passed whenever
     McNemar could not reject, which at these sample sizes could not fail -
     losing 11 cases and winning 3 of 54 was "within noise";
   - the **substitution rate** - framed-read cases where the filtered arm
     committed to ANY unframed fetch tool (`outsideReach === 'fetch'`: the
     shell, the screenshots, delegation, ...) and the full arm did not. The
     first version counted `run_command` alone;
   - hatch use and recovery, off-list calls, calls production would not
     run (scored as no call), and replies carrying several calls (only the
     first is followed).

   The verdict (`accuracyRunVerdict`, tested) refuses to print MET when the
   run measured nothing: every case errored, some errored, the FULL arm got
   under half the cases right (the model is not choosing tools - a template
   that ignores `tools`, a reply cut off), or the full arm never took the
   framed route on a framed-read case (then "zero substitutions" is not
   evidence). An earlier version printed "ALL THREE EXIT CRITERIA MET" for a
   model that never called a tool.
3. **Cache accounting** (`--cache`). Each arm replays the scripted
   conversations turn by turn against the same server, after one uncounted
   priming request, and sums the prompt tokens the server actually
   EVALUATED: ollama's `prompt_eval_count`, llama-server's `timings.prompt_n`,
   or `prompt_tokens - cached_tokens` from an OpenAI-style usage block. A
   server that reports none of these gets NO CACHE RESULT, not a pass.
   Separate conversations by default; `--one-session` for the chat loops'
   shape. Requests ask for one output token, since only prefill is being
   measured. The result holds for that server and chat template only.

`--live` runs 2 then 3. `--api openai` speaks `/chat/completions`, which is
what llama.cpp's `llama-server`, LM Studio, vLLM and OpenRouter expose, so
no ollama is needed. A key is read from the env var NAMED by
`--api-key-env`, never from the command line. `--max-calls` caps provider
calls; the planned count is printed first and a plan over the cap refuses to
start, so a paid endpoint cannot bill for a run the harness would then
refuse to read.

**Cost budget.** On the reference hardware a cold full-set prefill was 646 s
at ~9.4 tok/s for a 27B model; floor-only was 87 s. A 7-8B model at Q4 on a
16-core CPU is several times faster, but a full `--live` run is still
65 cases x up to 5 calls plus 36 cache requests at ~12k prompt tokens each:
budget an hour or more on CPU, or use `--issue-only` / `--limit` first.
A narrowed run never prints "ALL THREE ... MET"; it says SUBSET.

**Exit criteria for flipping the default**, on at least one real small/local
model and chat template (the harness prints each as MET / NOT MET):

1. **substitution rate exactly zero** - not "low". One observed unframed
   substitution on a case that wanted a framed tool is a stop;
2. tool-selection accuracy no worse than the full-list baseline within noise;
3. a token reduction that survives the cache accounting - the filtered arm
   must evaluate fewer prompt tokens than the full arm over the scripted
   conversations;
4. the I5 violation counter at zero over the whole run.

### What has actually been measured, and what has not

Stated precisely, because "we ran a benchmark" is exactly the kind of claim
#483 was filed about.

**Measured, offline, over the real 50-tool registry** (reproducible with
`bun bench/tool-relevance/benchmark.ts`):

- schema-byte savings per case: -43.5% worst, -89.8% best, -57.8% aggregate
  over 65 cases (-40.1% / -92.9% / -56.3% over 46 cases after #504, and
  -40.3% / -92.7% / -61.0% before it);
- the wanted tool kept in 65/65 cases;
- the I5 invariant-violation counter at **zero** across all 65.

**Estimated, offline, not measured:** the prompt-cache table in §9 point 4.
Filtered sends 32-44% fewer bytes; on a KV-caching runtime whose template
renders tools before the history it is estimated to prefill about 5-8x as
much, and with tools rendered last, 40-54% less.

**Measured live, against `qwen38-fast` (27.3B, Q4_K) on ollama**, one case:

- `open notepad and type hello`: **10,404 prompt tokens unfiltered vs 4,938
  filtered, -52.5%** by the model's own tokenizer, against -53.8% predicted
  from bytes. The model called `desktop_launch_app` correctly in **both**
  arms.

**NOT measured. The default must not be flipped until these exist:**

- **Substitution rate is unproven.** The run reports `0 over 0 framed-read
  cases`, which is not evidence of anything. The two framed-read cases
  errored, and the only local model then became unreachable mid-session (an
  in-place ollama update removed the binary). This is the single most
  important number in this document and it has no value yet.
- **No small model was ever available.** Every local model on the reference
  box is 27B or 30B, over the 20B `max_params_b` default, and had to be
  allowlisted explicitly to measure at all. The population this feature
  exists for was never tested.
- **Cache and latency are unmeasured live.** The offline estimate above
  says the filter loses badly on a KV-caching runtime; no real server has
  confirmed or refuted it. The one live run produced
  23,808 ms full vs 205,151 ms filtered, which is *not* a filter effect: the
  full call ran against a warm model and the filtered call then presented a
  different prefix and paid a full re-prefill. That is prompt-cache
  invalidation in miniature, and it is the term that could make the whole
  feature a net loss. It needs a proper warm/cold protocol.
- **Accuracy has a sample size of one.**

**Why no live number was taken in the #483 close-out either.** The machine
it ran on has no GPU, no ollama, no llama.cpp, no local weights, and no
configured endpoint serving a 7-8B model; installing any of them, or buying
API time, was out of scope for that change. The harness was made runnable
against every common way of serving such a model instead, and checked
end to end against a mock server speaking both protocols.

To reproduce once a model is reachable:

```
# offline, seconds
bun bench/tool-relevance/benchmark.ts

# every live number, one command. ollama:
bun bench/tool-relevance/benchmark.ts --live --model ollama:qwen2.5:7b-instruct

# ...or any OpenAI-compatible server. llama.cpp, no ollama needed. One slot
# (-np 1) so the server keeps exactly one cached prompt, which is the model
# the estimate assumes, and so the whole 16k context goes to that slot:
#   llama-server -m qwen2.5-7b-instruct-q4_k_m.gguf --jinja -c 16384 -np 1
# vLLM needs --enable-prompt-tokens-details to report cached tokens; LM
# Studio reports none, so its cache criterion is NO CACHE RESULT.
bun bench/tool-relevance/benchmark.ts --live --api openai \
  --base-url http://127.0.0.1:8080/v1 --model llamacpp:qwen2.5-7b-instruct

# ...or a hosted endpoint, capped. Reads the key from the NAMED env var.
# Hosted small models often do not report cached tokens, in which case the
# cache criterion prints NO CACHE RESULT; use --accuracy there.
bun bench/tool-relevance/benchmark.ts --accuracy --api openai \
  --base-url https://openrouter.ai/api/v1 --api-key-env OPENROUTER_API_KEY \
  --model openrouter:qwen/qwen-2.5-7b-instruct --max-calls 350
```

`--model` is required for the live modes and is always allowlisted by the
harness itself, so any model can be measured on purpose. `llamacpp:` and
`openrouter:` above are only labels for the allowlist; the part after the
first colon is sent as the model id.

The harness refuses to print a pass on a run that measured nothing (see
`accuracyRunVerdict` above), and exits nonzero on a partial run, an unmet
criterion or a malformed flag. A "0 substitutions" line accompanied by
"NO RESULT" or "PARTIAL RESULT" is not a green light.

### Selection accuracy after the #504 description trim: NOT MEASURED

#504 shortened the text the model uses to *choose* a tool. A terser
description is a weaker selection signal, so the trim carries a risk the byte
count cannot see, and that risk has **not been measured**. No number below is
estimated, inferred or predicted; there is no number.

Why not: the blocker recorded above has not moved. Every local model on the
reference box is 27B or 30B, over the 20B `max_params_b` default, and the one
that was reachable (`qwen38-fast`) disappeared mid-session when an in-place
ollama update removed the binary. The population this matters for - small and
local models, the ones that invent parameter values when the choices are only
described in prose - has still never been tested.

**What would settle it.** The comparison is a before/after on tool-selection
accuracy across the same case set, holding the filter constant and varying
only the descriptions. It needs one thing this box does not have: a reachable
model in the target class (ideally <= 20B). Note the harness always sets
`maxParamsB: 1000` and allowlists the pinned ref, so a small model is still an
allowlisted exception - its size buys a realistic *population*, not a real
verdict from the gate.

```
# 1. A reachable model in the target class.
ollama pull qwen2.5:7b        # or any <= 20B instruct model with tool support
ollama list                   # confirm it is actually there

# 2. Baseline: descriptions as they were BEFORE the trim.
#    2478625 is the commit #502 landed on, i.e. the parent of #504.
git switch --detach 2478625
bun bench/tool-relevance/benchmark.ts --accuracy \
  --model ollama:qwen2.5:7b --limit 46 | tee /tmp/acc-before.txt

# 3. After: the trimmed descriptions (8d2a449, #508; or main).
git switch --detach 8d2a449
bun bench/tool-relevance/benchmark.ts --accuracy \
  --model ollama:qwen2.5:7b --limit 46 | tee /tmp/acc-after.txt

# 4. Compare the three summary lines. Case-insensitive, and matching the
#    harness's real labels: "correct tool:", "no tool called:",
#    "SUBSTITUTIONS:".
diff <(grep -iE 'correct tool|no tool called|substitut' /tmp/acc-before.txt) \
     <(grep -iE 'correct tool|no tool called|substitut' /tmp/acc-after.txt)

# 5. Per-tool rows for criterion 2 below; these carry none of the tokens
#    above, so they need their own comparison.
diff <(grep -E '^(gen|issue)/' /tmp/acc-before.txt) \
     <(grep -E '^(gen|issue)/' /tmp/acc-after.txt)
```

Read the result against these, in order:

1. **Substitution rate must stay at zero** in the *after* arm. This is the
   number #475 never took and it outranks the byte saving: if a shorter
   description pushes the model onto `run_command` for a case that wanted a
   framed read, the trim has laundered authority and must be reverted on that
   tool regardless of what it saved.
2. **Per-tool accuracy, not just the aggregate.** The trim is six independent
   rewrites and the aggregate can absorb one tool collapsing. Compare
   `gen/<tool>` rows one to one; the six to watch are `manage_workflow`,
   `content_pipeline`, `request_approval`, `commitments`, `create_document`
   and `manage_goals`.
3. **The confusable pairs specifically.** The rewrites lean on explicit
   cross-references to keep neighbours apart, and those are what a small
   model is most likely to miss: `create_document` vs `content_pipeline` vs
   `write_file`, and `commitments` vs `manage_goals`. A wrong pick *within* a
   pair is the failure mode to look for, and it is invisible in a
   correct/wrong total that counts both as one miss.
4. **Caveat on the generated cases.** `generatedCases()` builds each prompt
   from `firstSentence(t.description)`, so the trim changed the prompts as
   well as the schemas. The `gen/*` arms are therefore *not* a clean A/B. The
   six `ISSUE_CASES` prompts are fixed and are the honest comparison; treat
   the generated rows as a smoke test only.

Until that run exists, the defensible claim for #504 is exactly: a measured
-11.1% schema-byte reduction with the load-bearing discriminators,
preconditions and side effects that review identified preserved and pinned by
`src/actions/tools/tool-description-budget.test.ts` - and selection accuracy
**unmeasured**.

### A note on enums, added by #504

`ToolParameter.enum` (`src/actions/tools/registry.ts`) is emitted into the
model-facing schema *and* enforced in `validateParameters`. #504 moved the
`action` value list of five tools out of prose and into an enum, which costs
a few hundred bytes rather than saving them. That is deliberate: a prose list
is a hint a small model can ignore, an enum is a constraint it is trained to
honour and that the registry rejects violations of, naming the allowed values
in the error. It directly offsets the "terser description is a weaker signal"
risk for the one parameter that most determines whether a call is usable.

An enum was added **only** where the advertised values match the `execute()`
switch exactly, so no call that used to work can now be rejected. The value
sets are equivalent; the failure *shape* is not, and that is worth stating
rather than glossing. Before, an unknown action fell to a `default:` branch
that **returned** `Unknown action: "..."` - a successful tool result, so a
`jarvis-tool:invoke` step carried on. Now `validateParameters` **throws**, and
`sandbox-api/routes/jarvis-tools.ts` rethrows anything that is not an
`ActionOutcomeError`, so a stored workflow step fails hard instead of
continuing past a soft error. For the LLM tool-call surface that is a strict
improvement (the error names the allowed values); for a stored workflow it is
a real behaviour change beyond description text. Those `default:` branches are
now unreachable through `registry.execute`.
It was deliberately **not** added to `request_approval.action_category`:
`VALID_CATEGORIES` is `Object.keys(AUTHORITY_REQUIREMENTS)`, 13 categories, of
which the description advertises 8. An 8-value enum there would have narrowed
what the tool accepts and rejected `access_browser`, `control_app` and the
rest - a real behaviour change, not a description edit.

---

## 11. Authority-map gaps found while writing this

Pre-existing, independent of the filter, reported so they are not lost. The
first three were fixed by #503; the last is still open.

- ~~**`manage_workflow`** (category `automation`) has no `TOOL_ACTION_MAP`
  entry and `automation` has no `CATEGORY_ACTION_MAP` entry, so
  `getActionForTool` resolves it to `read_data`, rank 100. It can `run`,
  `publish`, `enable` and `delete` workflows.~~ FIXED in #503: floor
  `write_data`, with a per-action `authorityGate` raising `run` to
  `execute_command` and `delete` to `delete_data`.
- ~~**The eight site-builder tools** (category `site-builder`, registered at
  runtime when sites are enabled) are likewise unmapped and resolve to
  `read_data`. One of them, **`site_run_command`, is a
  `Bun.spawn(['sh','-c',cmd])` shell gated at level 1.**~~ FIXED in #503.
- ~~`builtin-tool-coverage.test.ts` exists precisely to prevent this and its
  header describes this exact failure - but it walks `BUILTIN_TOOLS`, and none
  of these tools is in `BUILTIN_TOOLS`.~~ FIXED in #503: it now derives its
  set from the real tool factories via
  `src/actions/tools/production-registry.ts`, which the benchmark in
  `bench/tool-relevance/` shares, so the two cannot drift.
- **`commitments` is mapped `write_data`** (level 3). Per §2.3 it is not a
  data write at all: it schedules an arbitrary unattended agent turn with a
  5-second default cancel window. That is the same complaint this list makes
  about a shell gated at level 1, and it deserves its own issue. A narrower
  fix worth considering there: refuse to auto-fire a commitment that the
  model itself created with a `when_due` inside the cancel window, or route
  it through `request_approval`.

Raising `site_run_command` to `execute_command` changes live gating for an
existing feature, so it was **not** done in this branch; #503 did it. The
filter was designed to be safe in spite of the gap and still is: §2.1 gives an
unmapped tool rank infinity, independent of what the action map contains.

---

## 12. How #483's six requirements are met

| # | requirement | mechanism |
|---|---|---|
| 1 | model-class/tier gate | §4. Allowlist or capped ollama; frontier veto; unknown is ineligible; **every failover candidate must be eligible**, including a caller-supplied `fallbackTier`. Provider kinds reach every orchestrator and every sub-agent launcher. |
| 2 | a way back to the full set | §5. `discover_tools`, present whenever anything was dropped (I4), admission recorded in the ledger, emergency-gated and audited; tolerant of stringified `names`. A call to a tool that was not offered is admitted too. |
| 3 | per-turn re-filtering over the conversation | §6 + I2. Recomputed every turn over the whole conversation; everything used or admitted is kept by the ledger, which `processTaskCall` now shares with the chat loops. |
| 4 | authority coupling as an invariant | I1, triggered by `fetch` reach *or* rank > 504, repaired by union with `PERCEPTION(A)`, checked on every returned set - and at dispatch, where an off-list trigger is not run while a framed reader is hidden (§5). Tested from the production registry, pairwise over the whole trigger vocabulary. |
| 5 | fixtures from the registry, wrong-exclusion coverage | §3, §8. Classification tests walk `BUILTIN_TOOLS`; trigger coverage, the stuffing properties and the wrong-exclusion tests walk the 50-tool production registry. Every tool's own description must keep it, eleven realistic browse asks with no web keyword must keep the browser tools, and an unmatched ask gets the framed readers, never the shell. |
| 6 | a real benchmark before default-on | §10. One-command live harness (ollama or any OpenAI-compatible server) with exit criteria for substitution, accuracy within noise and cache-accounted tokens. **Not yet run on a 7-8B model.** The offline cache estimate says the third criterion fails on KV-caching runtimes whose template renders tools before the history (most of them) and passes with tools rendered last or with no cache. |

Plus the three explicit fixes: the fail-open off-by-one becomes set
containment against the actual input list (I3, I5); the kill switch
is a config key and an env var (§7); every call site goes through one gate
(§6).

## 13. Default posture

Off. `tools.relevance_filter.enabled` defaults to `false`, unknown models are
ineligible, and realtime is ineligible even when the filter is on. Nothing
changes for any existing install until an operator opts in, and the default
flips only on the §10 numbers.
