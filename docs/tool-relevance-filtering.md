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

**With one correction.** `getActionForTool` falls through to `read_data`
(rank 100) for any tool absent from both `TOOL_ACTION_MAP` and
`CATEGORY_ACTION_MAP`. That default is safe for gating decisions made
elsewhere but disastrous here - it would score an unmapped shell as a level-1
read. So for filter purposes:

> **An unmapped tool has rank infinity.** Never floor-eligible, always a
> union trigger.

This is not hypothetical. `manage_workflow` (category `automation`) and all
eight site-builder tools (category `site-builder`), including
`site_run_command` - a second `Bun.spawn(['sh','-c',cmd])` - are unmapped and
currently resolve to `read_data`. See §11.

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
| `manage_workflow` | automation | *(unmapped)* | inf | **fetch** | 4785 | DROP |
| `manage_skills` | ui | read_data | 100 | replay | 440 | DROP |
| `list_sidecars` | sidecar | read_data | 100 | replay | 503 | DROP |
| `create_document` | documents | write_data | 302 | replay | 1597 | DROP |
| `content_pipeline` | content | write_data | 302 | replay | 2498 | DROP |
| `commitments` | tasks | write_data | 302 | **fetch** | 1841 | DROP |
| `manage_goals` | goals | write_data | 302 | replay | 1449 | DROP |
| `research_queue` | productivity | read_data | 100 | **fetch** | 859 | DROP |
| `desktop_click` | desktop | control_app | 505 | inert | 1131 | DROP |
| `desktop_type` | desktop | control_app | 505 | inert | 549 | DROP |
| `desktop_press_keys` | desktop | control_app | 505 | inert | 556 | DROP |
| `desktop_launch_app` | desktop | control_app | 505 | inert | 1322 | DROP |
| `desktop_focus_window` | desktop | control_app | 505 | inert | 427 | DROP |
| `write_file` | file-ops | write_data | 302 | inert | 555 | DROP |
| `set_clipboard` | general | write_data | 302 | inert | 414 | DROP |
| `get_system_info` | general | read_data | 100 | inert | 360 | **FLOOR** |
| `request_approval` | authority | read_data | 100 | inert | 1902 | **FLOOR** |

`*` The two delegation tools are built by a factory that embeds the registered
specialist list in the description, so their real size grows with the number
of specialists; the figures are for a single-specialist registry and are a
lower bound.

Not in the table and handled separately: the eight `site-builder` tools,
registered into the live orchestrator registry only when sites are enabled
(`src/daemon/index.ts`). All are unmapped, so all are rank `inf` and, being
undeclared, class `fetch`. `site_run_command` is a shell. They are never
floor-eligible and always union triggers, which is the correct treatment
without needing a per-tool declaration.

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

> **The exposed set never shrinks as a conversation progresses.**
>
> For turns `n < m` in one conversation: `S_n ⊆ S_m`

This is how requirement 3 is met, and it is stronger than "re-filter per
turn": a follow-up can only ever *add*. Mid-task stripping becomes
structurally impossible rather than a case the heuristic must get right.

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

One ledger per conversation: a field on `AgentInstance` for the chat loops, a
local seeded from `opts.history` for `processTaskCall`, a local seeded from
`resume.messages` for the sub-agent. `S` is then a pure function of
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

Three implementation points an earlier draft got wrong or omitted:

- **It is not an existing pattern.** `request_approval` is a *registered*
  registry tool whose authority check is bypassed by name; only
  `ask_for_clarification` is handled inline, and only at one of the four
  loops. So this is four new inline branches, written against one shared
  helper rather than copied four ways.
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

Rejected alternative: detecting "I don't have a tool for that" in the model's
prose and re-running with the full list. Brittle text matching on a small
model's output is the kind of heuristic this issue exists to avoid, and it
pays the full-list token cost on every false positive.

---

## 6. Where `S` is computed, and every call site

**Once per user turn, held fixed across the whole tool loop**, recomputed only
on an explicit `discover_tools` admission.

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
*next* turn; only an explicit admission changes `S` mid-turn, which is the
escape hatch's entire purpose. `S` therefore changes at most once per turn
plus once per `discover_tools` call. This still satisfies requirement 3 -
re-filtered every turn, over the whole conversation, never first-message-only.

| call site | method | coverage |
|---|---|---|
| chat | `AgentOrchestrator.processMessage` | per-turn, ledger keyed by primary agent id |
| task / resume | `AgentOrchestrator.processTaskCall` | per-turn, ledger seeded from `opts.history`; `ask_for_clarification` appended *after* the filter, so it is never in its accounting |
| streaming chat | `AgentOrchestrator.streamMessage` | per-turn, ledger keyed by primary agent id, `fallbackTier` passed to the gate |
| sub-agent | `runSubAgent` (`src/agents/sub-agent-runner.ts`) | per-turn, ledger seeded from `resume.messages` |
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

The policy is resolved once at boot into a module-level holder whose
hard-coded initial value is `enabled: false`, so every path not wired to the
daemon - tests, scripts, a standalone sub-agent runner - is unfiltered unless
it opts in. **Model classification is not frozen with it** (§4): the policy is
boot-time, the classification is per call.

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

The initial trigger table ships in code with a coverage test asserting every
droppable registered tool has at least one entry, so a new tool cannot ship
invisible to the filter:

| group | tools | triggers |
|---|---|---|
| browse | all `browser_*` | `https?://`, url, web, website, page, browse, article, link, online, google, search for, look up, summarise/summarize this |
| perceive | `desktop_snapshot`, `desktop_find_element`, `desktop_list_windows`, `desktop_screenshot`, `capture_screen`, `ui_snapshot` | screen, window, see, look, showing, display, dialog, button, field, what am i |
| act_desktop | `desktop_click/type/press_keys/launch_app/focus_window`, `ui_act` | open, launch, start, click, type, press, key, notepad, app, application |
| shell | `run_command` | run, command, terminal, shell, script, build, compile, test, install, npm, bun, git, log, process, restart, service |
| files | `read_file`, `list_directory` | path-like `[/\\][\w.-]+`, code fence, file, folder, directory, read, save, disk |
| clipboard | `get_clipboard` | clipboard, copy, paste |
| skills | `run_skill`, `record_skill`, `manage_skills` | skill, record, replay, macro, teach, demonstrate |
| delegation | `delegate_task`, `manage_agents` | delegate, agent, specialist, in parallel, background, spawn |
| workflows | `manage_workflow` | workflow, automation, automate, schedule, recurring, every morning, daily, trigger |
| goals | `manage_goals` | goal, objective, okr, target, milestone |
| commitments | `commitments` | remind, remember, commit, promise, todo, follow up, deadline, due |
| documents | `create_document` | document, note, write up, draft, memo, report |
| content | `content_pipeline` | content, pipeline, idea, outline, publish, post |
| research | `research_queue` | research queue, queued research, background research |

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

`A` = 42 tools, **39,420 bytes** of emitted JSON schema (the 33
`BUILTIN_TOOLS` at 22,445 B plus nine daemon-registered tools). Calibrated
against a real tokenizer on `qwen38-fast` (27.3B, Q4_K, ollama): the full
33-tool set is **6,091 prompt tokens**, giving **~3.83 bytes/token** for
these schemas, so a bytes/4 estimate undercounts by about 8%.

| set | tools | bytes |
|---|---|---|
| full `A` | 42 | 39,420 |
| `FLOOR(A)` | 2 | 2,262 |
| `PERCEPTION(A)` (the I1 union) | 16 | 11,384 |
| invariant triggers | 18 | 19,936 |
| `replay` | 5 | 6,487 |

The five cases from #483's own measurement table, plus its mid-task repro:

| case | tools | bytes | saving |
|---|---|---|---|
| `open notepad and type hello` | 24/42 | 18,230 | **-53.8%** |
| `research the competitor landscape and write it up` | 24/42 | 18,261 | **-53.7%** |
| `summarise this article https://example.com/post/1` | 21/42 | 17,277 | **-56.2%** |
| `set a goal to ship the release this week` | 4/42 | 4,310 | **-89.1%** |
| `schedule a daily check of the dashboard` | 22/42 | 20,447 | **-48.1%** |
| `open notepad` then `now remember that I did that` | 25/42 | 20,071 | **-49.1%** |

Over all 46 cases (the six above plus one generated per droppable tool):
**-61.0% aggregate**, best -92.7%, worst **-40.3%**, and zero invariant
violations.

Confirmed live against the real tokenizer, not only in bytes: on
`open notepad and type hello`, `qwen38-fast` reports **10,404 prompt tokens
unfiltered and 4,938 filtered, -52.5%**, against the -53.8% this table
predicts from bytes. The model called `desktop_launch_app` correctly in both
arms.

Four things worth saying plainly, because #475 was rejected partly for not
saying them:

1. **The worst case is about -40%, not -4%.** An earlier draft of this
   design computed the floor from `reach = none ∧ rank ≤ 302` and put the
   six fattest daemon tools (`manage_workflow` 4,785 B, `content_pipeline`
   2,498, `request_approval` 1,902, `commitments` 1,841, `create_document`
   1,597, `manage_goals` 1,449 - 36% of the budget) into the *undroppable*
   floor. It measured -3.9% to -56.4% on these same cases. Shrinking the
   floor to two tools and adding the `replay` class is what moved it.
2. **Almost every realistic turn trips I1**, because `ui_act` and
   `browser_evaluate` are both framed readers *and* rank above
   `access_browser`. That is intended: the saving comes from dropping the
   tools a turn has no use for, not from dropping perception.
3. **A single trigger word pins the set for the rest of the session.** I2 is
   monotone, so one "check the build" in turn 4 holds the set at
   `FLOOR ∪ PERCEPTION ∪ ...` thereafter. The steady state of a long mixed
   conversation is nearer -50% than -89%.
4. **These are schema bytes. They are not the whole cost.** See §10 on
   prompt-cache invalidation, which is unmeasured and could exceed the
   saving.

**And the cheapest win needs none of this.** Those six daemon tool
descriptions are 14,072 B, 36% of the budget, and trimming them needs no
invariant, no gate and no security review. Out of scope here, but it should
be an issue: it is a larger expected saving than the filter.

---

## 10. What the benchmark measures

`bench/tool-relevance/`, runnable, **not** part of the test suite.

1. **Token cost**, full vs filtered, with a real tokenizer where available and
   a labelled byte estimate otherwise; per case and in aggregate.
2. **Tool-selection accuracy.** Each case names the tool a correct answer
   would call; the model is asked twice, once per list, and scored correct /
   wrong / no-call. Plus the two failure modes this design exists for:
   - **substitution rate** - how often the model reached for `run_command`
     when the case wanted a framed perception tool. This is the number that
     would have exposed #475's defect empirically. 
   - **hatch rate** - how often it called `discover_tools` and recovered.
3. **Cache and latency**, which the first draft omitted and which may dominate
   everything else (§6): cached vs fresh input tokens (Anthropic reports the
   split; ollama reports `prompt_eval_cached_count`), and wall-clock prefill
   with and without a mid-conversation tool-set change.

Cases are generated from `BUILTIN_TOOLS` plus the conversation fixtures from
#483's table, so the before/after is directly comparable to the issue.

**Cost budget.** On the hardware available here a cold full-set prefill is
646 s at ~9.4 tok/s; floor-only is 87 s. A naive "every case, twice" sweep is
hours per model. The harness takes an explicit case count and a pinned model
ref rather than reading the tier map.

**Exit criteria for flipping the default**, on at least one real small/local
model:

- a measured token reduction that survives the cache accounting - i.e. the
  filter must not lose more to prefix invalidation than it saves in schema;
- tool-selection accuracy no worse than the full-list baseline within noise;
- **substitution rate exactly zero** - not "low". One observed unframed
  substitution on a case that wanted a framed tool is a stop;
- the I5 violation counter at zero over the whole run.

---

## 11. Authority-map gaps found while writing this

Pre-existing, independent of the filter, reported so they are not lost:

- **`manage_workflow`** (category `automation`) has no `TOOL_ACTION_MAP` entry
  and `automation` has no `CATEGORY_ACTION_MAP` entry, so `getActionForTool`
  resolves it to `read_data`, rank 100. It can `run`, `publish`, `enable` and
  `delete` workflows.
- **The eight site-builder tools** (category `site-builder`, registered at
  runtime when sites are enabled) are likewise unmapped and resolve to
  `read_data`. One of them, **`site_run_command`, is a
  `Bun.spawn(['sh','-c',cmd])` shell gated at level 1.**
- `builtin-tool-coverage.test.ts` exists precisely to prevent this and its
  header describes this exact failure - but it walks `BUILTIN_TOOLS`, and none
  of these tools is in `BUILTIN_TOOLS`.
- **`commitments` is mapped `write_data`** (level 3). Per §2.3 it is not a
  data write at all: it schedules an arbitrary unattended agent turn with a
  5-second default cancel window. That is the same complaint this list makes
  about a shell gated at level 1, and it deserves its own issue. A narrower
  fix worth considering there: refuse to auto-fire a commitment that the
  model itself created with a `when_due` inside the cancel window, or route
  it through `request_approval`.

Raising `site_run_command` to `execute_command` changes live gating for an
existing feature, so it is **not** done in this branch. The filter is designed
to be safe in spite of it: §2.1 gives an unmapped tool rank infinity, so all
of these are permanently floor-ineligible and permanently I1 triggers.

---

## 12. How #483's six requirements are met

| # | requirement | mechanism |
|---|---|---|
| 1 | model-class/tier gate | §4. Allowlist or capped ollama; frontier veto; unknown is ineligible; **every failover candidate must be eligible**. |
| 2 | a way back to the full set | §5. `discover_tools`, present whenever anything was dropped (I4), admission recorded in the ledger, emergency-gated and audited. |
| 3 | per-turn re-filtering over the conversation | §6 + I2. Recomputed every turn over the whole conversation, monotone via the ledger, so a follow-up can only add. |
| 4 | authority coupling as an invariant | I1, triggered by `fetch` reach *or* rank > 504, repaired by union with `PERCEPTION(A)`, checked on every returned set, tested from `BUILTIN_TOOLS`. |
| 5 | fixtures from `BUILTIN_TOOLS`, wrong-exclusion coverage | §3, §8. Classification and trigger coverage tests walk `BUILTIN_TOOLS`; negative tests assert a research/browse ask keeps the browser tools. |
| 6 | a real benchmark before default-on | §10, with exit criteria including a zero substitution rate and cache-accounted tokens. |

Plus the three explicit fixes: the fail-open off-by-one becomes set
containment against the actual input list (I3, I5); the kill switch
is a config key and an env var (§7); every call site goes through one gate
(§6).

## 13. Default posture

Off. `tools.relevance_filter.enabled` defaults to `false`, unknown models are
ineligible, and realtime is ineligible even when the filter is on. Nothing
changes for any existing install until an operator opts in, and the default
flips only on the §10 numbers.
