/**
 * Sidecar Routing — Transparent Remote Execution
 *
 * Holds a reference to the SidecarManager and provides a helper
 * that existing tools call when a `target` parameter is present.
 * The AI decides where to run a command by specifying (or omitting) a target.
 */

import type { SidecarManager } from '../../sidecar/manager.ts';
import type { SidecarCapability, SidecarInfo } from '../../sidecar/types.ts';
import {
  familyLabel,
  hostTarget,
  osFamily,
  type ExecutionTarget,
} from '../../util/execution-environment.ts';
import { isNoLocalTools } from './local-tools-guard.ts';
import { ActionOutcomeError, type ActionFailure } from '../action-outcome.ts';
import { SidecarRPCError } from '../../sidecar/rpc.ts';
import { compareSemver, parseSemver } from '../../sidecar/compat.ts';
import { getMachineScope } from '../machine-scope.ts';
import { failedToolResult } from '../progress-context.ts';

let sidecarManager: SidecarManager | null = null;

/**
 * RPC error codes a sidecar sends for a request it refused before acting
 * (codedError in sidecar/client.go). Every other handler error may follow a
 * partial effect.
 *
 * MEMBERSHIP IS A CLAIM, not a label. Listing a code here asserts that the
 * handler had not acted yet when it produced that code, and the model is
 * entitled to retry or reword without checking the machine first. So the set
 * stays a short allow-list and the DEFAULT -- for a code this brain has never
 * heard of as much as for one it has -- is `may_have_occurred`.
 *
 * `HANDLER_PANIC` (#623) is the code that makes the default load-bearing, and
 * it is deliberately ABSENT here. A recovered panic cannot establish that
 * nothing happened: `runRPCHandler` (sidecar/client.go) wraps the WHOLE
 * handler, so the panic may be the type assertion on the first line or the line
 * after a click, a keystroke or a file write, and the recover sees no
 * difference. Adding it would turn a crash of unknown effect into a promise
 * that the machine is untouched -- the one inference the sidecar cannot support
 * and the one a model acts on. It is not listed, and `sidecar-route.test.ts`
 * fails if it becomes listed; `rpc_handler_panic_test.go` pins the other half,
 * that the sidecar's own message carries the uncertainty rather than claiming a
 * refusal, but it knows nothing about this set.
 */
const NOT_STARTED_RPC_CODES = new Set(['DESKTOP_INVALID_KEYS']);

/**
 * Inject the sidecar manager at startup. Called once from the daemon.
 */
export function setSidecarManagerRef(manager: SidecarManager): void {
  sidecarManager = manager;
}

export function getSidecarManager(): SidecarManager | null {
  return sidecarManager;
}

/**
 * Pick a default sidecar for tools that didn't get an explicit target.
 * Returns the first connected sidecar advertising the required capability,
 * or null when nothing's available. Used by desktop_* / browser_* /
 * etc. so calls land on the Go sidecar automatically when one is
 * connected, instead of falling back to legacy local controllers.
 */
export function autoTargetForCapability(cap: SidecarCapability): string | null {
  const scope = getMachineScope();
  if (scope) {
    const target = scope.resolveTarget(undefined, cap);
    scope.assertDispatch(target, cap);
    return target;
  }
  if (!sidecarManager) return null;
  for (const s of sidecarManager.listSidecars()) {
    if (!s.connected) continue;
    if (s.unavailable_capabilities?.some((u) => u.name === cap)) continue;
    if (s.capabilities && s.capabilities.includes(cap)) return s.id;
  }
  return null;
}

/**
 * The live execution inventory: every enrolled sidecar plus the brain's own
 * host, each with the OS it runs. Feeds the workflow composer's prompts and
 * the agent's tool guide, so both write commands for the machine a step
 * actually lands on instead of whichever OS the model's priors favour.
 *
 * Offline sidecars stay in the list: a workflow composed today runs on a
 * schedule tomorrow, and the laptop asleep right now is still the machine the
 * user means. Dropping it would leave the composer writing commands for the
 * Linux server the brain happens to live on.
 *
 * The host is omitted under --no-local-tools, where it refuses every call --
 * counting it would let a hosted brain's own OS excuse commands that can only
 * ever run on the user's sidecar.
 */
export function collectExecutionTargets(): ExecutionTarget[] {
  const targets: ExecutionTarget[] = [];
  try {
    for (const s of sidecarManager?.listSidecars() ?? []) {
      targets.push({
        id: s.id,
        name: s.name,
        os: s.os ?? null,
        // SidecarInfo.platform carries GOARCH, not an OS. See ExecutionTarget.
        arch: s.platform ?? null,
        connected: s.connected,
        ...(s.capabilities ? { capabilities: [...s.capabilities] } : {}),
      });
    }
  } catch {
    // Registry unavailable (DB not open yet, sidecars disabled). Report what
    // we can rather than nothing.
  }
  if (!isNoLocalTools()) targets.push(hostTarget());
  return targets;
}

/** A machine's name plus its OS, for an error a human has to act on. */
function describeMachine(sidecar: SidecarInfo): string {
  const fam = osFamily(sidecar.os);
  return fam ? `${sidecar.name}, ${familyLabel(fam)}` : sidecar.name;
}

/**
 * Pick the stack that will serve one tool call, and say which it was.
 *
 * Two implementations back every desktop_* and browser_* tool: the Go
 * sidecar, and the daemon's own local controllers. Which one runs depends on
 * whether a sidecar is connected, and the choice used to be made in silence,
 * so "it works sometimes" was untraceable after the fact. One line per call
 * names the stack that answered.
 *
 * An explicit target is passed through verbatim; findSidecar trims before
 * matching, so there is nothing to gain by doing it twice, and the log line
 * then shows exactly what the caller asked for. A blank string counts as no
 * target at all and falls through to auto-selection.
 */
export function resolveToolTarget(
  explicit: unknown,
  capability: SidecarCapability,
  tool: string,
): string | null {
  const named = typeof explicit === 'string' && explicit.trim() ? explicit : null;
  const scope = getMachineScope();
  const target = scope ? scope.resolveTarget(named, capability) : named ?? autoTargetForCapability(capability);
  scope?.assertDispatch(target, capability);
  console.log(
    target
      ? `[${capability}] ${tool} -> sidecar stack (target=${target}, ${named ? 'explicit' : 'auto'})`
      : `[${capability}] ${tool} -> local stack`,
  );
  return target;
}

/**
 * Find a sidecar by name or ID.
 * Priority: exact ID → exact name (case-insensitive) → contains match.
 */
export function findSidecar(nameOrId: string, sidecars: SidecarInfo[]): SidecarInfo | null {
  const query = nameOrId.trim();
  if (!query) return null;

  // Exact ID match
  const byId = sidecars.find((s) => s.id === query);
  if (byId) return byId;

  // Exact name (case-insensitive)
  const lower = query.toLowerCase();
  const byName = sidecars.find((s) => s.name.toLowerCase() === lower);
  if (byName) return byName;

  // Contains match
  const byContains = sidecars.find((s) => s.name.toLowerCase().includes(lower));
  return byContains ?? null;
}

/**
 * What a dispatch produced: either the sidecar's own reply, or a message this
 * module wrote about why there is no reply.
 *
 * The split exists so a caller can tell the two apart (#583). Collapsing both to
 * a string is right for a tool whose result is text, and wrong for one that must
 * also read a STRUCTURAL field off the reply: "no sidecar found" and "the
 * sidecar replied" would then be the same kind of value, and the caller would
 * have to tell them apart by parsing the very text it was trying not to parse.
 */
type SidecarDispatch =
  | { readonly kind: 'reply'; readonly result: unknown }
  | {
      readonly kind: 'message';
      readonly text: string;
      /**
       * Which refusal this was, for a caller that must tell them apart (#591),
       * and why it is not read off the text.
       *
       * `METHOD_NOT_FOUND` is the case that forces it. The code means the
       * sidecar does not HAVE the method, which in practice means it is older
       * than this brain -- a different condition from a capability the operator
       * turned off, and since #605 the two carry different messages naming
       * different remedies. The text is still not what a caller classifies on:
       * display text is written for the model and may be reworded, while a
       * caller like #591's coordinate probe needs the condition itself.
       *
       * OPTIONAL because not every message has one: the still-running
       * `run_command` note and a rethrown `ActionOutcomeError` are written as
       * literals rather than through `fail`. A consumer must DEFAULT its reason
       * rather than assume a code is present.
       *
       * NOT a complete classification on its own. The catch below also matches
       * `METHOD_NOT_FOUND` as a SUBSTRING of the error message when
       * `typedErrors` is false, which predates typed codes and is left alone --
       * so a remote sidecar whose message happens to contain that literal can
       * have its own coded refusal relabelled. Both outcomes are still "no
       * answer", so it costs a diagnosis and never a wrong answer.
       *
       * `routeToSidecar` and `routeBrowserReadToSidecar` read only `.text`, so
       * adding this changes nothing for either.
       */
      readonly code?: string;
    };

/**
 * Where a sidecar's version sits against the newest one this brain ships, for
 * the refusals whose remedy depends on it (#605), plus the parenthetical that
 * says so in the message.
 *
 * THREE-WAY, and ORDERED rather than compared for identity. Both obligations
 * matter and they are mirrors of each other: an absent version must read as
 * absent and never as current, and a current version must never read as skew.
 * Getting the second wrong is #605's own bug inverted -- telling the user to
 * update a sidecar that is already the newest one available is exactly as
 * unactionable as telling them to check a config file that is fine. A sidecar
 * AHEAD of the brain is a supported configuration (src/sidecar/compat.ts: "a
 * new sidecar release needs no brain change to be considered ok"), so it counts
 * as 'current', not as a mismatch.
 *
 * `latest_version` is the sidecar version THIS BRAIN SHIPS
 * (SIDECAR_LATEST_VERSION), which is the number the user can actually reach.
 * The daemon's own version is deliberately not used: it is a different series,
 * and naming it would send the user looking for a sidecar release that does not
 * exist.
 *
 * 'unknown' covers a dev build, an unparseable stamp and a sidecar that
 * reported nothing. `parseSemver` is used rather than `isUpdateAvailable`
 * because the latter answers a different question -- it refuses a
 * non-canonical stamp like `0.10.0+local` outright, where for a diagnosis that
 * build is perfectly comparable.
 *
 * Versions are printed as stored, with no "v" prefix added, because some are
 * already prefixed and some carry a `+local` suffix.
 */
function sidecarStanding(sidecar: SidecarInfo): {
  readonly age: 'behind' | 'current' | 'unknown';
  readonly note: string;
} {
  const reported = sidecar.version;
  if (!reported) return { age: 'unknown', note: '' };
  const v = parseSemver(reported);
  const latest = sidecar.latest_version ? parseSemver(sidecar.latest_version) : null;
  if (!v || !latest) return { age: 'unknown', note: ` (it reports ${reported})` };
  return compareSemver(v, latest) < 0
    ? { age: 'behind', note: ` (it reports ${reported}; this brain ships ${sidecar.latest_version})` }
    : { age: 'current', note: ` (it reports ${reported}, the newest sidecar this brain knows of)` };
}

/**
 * Fields a sidecar handler uses to say what went wrong, most specific first.
 *
 * A CLOSED list in a fixed order, because the handlers are not uniform: Linux
 * `focus_window` reports `{success:false, pid, error: <the error Go returned>}`
 * while `launch_app`'s negative probes report `{success:false, pid, note: <why
 * no window appeared>}` (sidecar/desktop_linux.go). `message` sits between them
 * for a handler that spells it the third way.
 *
 * How much of this is really the REMOTE machine's words varies, and the
 * difference is worth knowing before trusting a field: `runWithTimeout` builds
 * its error with `cmd.Output()` and never reads `ExitError.Stderr`, so
 * `focus_window`'s `error` is "exit status 1" rather than anything xdotool
 * said. `runProbe` keeps stderr deliberately, which is why `launch_app`'s note
 * genuinely does quote another process. Treated alike regardless: which handler
 * on which OS answered is not something this function can see.
 *
 * Order, not a search for the longest value: `error` is the field a handler
 * uses when it has a cause to report, and a reply carrying both should be read
 * for that rather than for a note explaining what to do next. A sidecar can
 * therefore demote a real cause into `note` by also sending a bland `error` --
 * which is no worse than before, since one that lies in a field could equally
 * have lied in the whole blob, and the `note` is still carried in the tail. The
 * three known sentence fields get the full budget there for that reason.
 */
const REPLY_FAILURE_FIELDS = ['error', 'message', 'note'] as const;

/** Longest remote string carried into one of these messages. */
const MAX_REPLY_FIELD_CHARS = 600;

/** Longest remote string carried as an incidental trailing `key=value` pair. */
const MAX_REPLY_TAIL_CHARS = 120;

/** Longest key NAME rendered in the tail; a key is a label, not a payload. */
const MAX_REPLY_KEY_CHARS = 40;

/** Most trailing pairs rendered, so the field count cannot be the payload. */
const MAX_REPLY_TAIL_PAIRS = 12;

/** Longest whole description this builds, tail and all. */
const MAX_REPLY_DESCRIPTION_CHARS = 1200;

/** Cut a remote string to a budget, saying so rather than cutting silently. */
function boundRemote(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}... (truncated, was ${s.length} chars)` : s;
}

/**
 * What a negative reply says failed, in prose, with its remaining fields after
 * it (#627).
 *
 * The old spelling was `JSON.stringify(reply)`, which is correct about losing
 * nothing and wrong about everything else: a `{success:false, error:"..."}`
 * reached the model as a serialised struct with the one field it needed buried
 * inside it. So the handler's own sentence leads, and the rest of the reply
 * follows as `[pid=7]` instead of being dropped -- the issue asks only for the
 * readable field, but the pid and the note surviving together was a deliberate
 * earlier decision on this path and prose keeps both.
 *
 * TYPE-CHECKED, not cast, for the reason `readSidecarPageReply` states below:
 * the value came from `JSON.parse` on another machine, through a validator that
 * preserves arrays and objects verbatim (sidecar/validator.ts), so an
 * `{error: ["..."]}` would coerce into a sentence under a `string` annotation
 * TypeScript erases at runtime. A non-string `error` is therefore not read as
 * the sentence; it goes in the tail as the value it is.
 *
 * BOUNDED IN TOTAL, not per field. Every remote string is cut, AND so are the
 * key names, the number of pairs and the finished sentence -- because each of
 * those is separately attacker-chosen: a reply of five thousand small keys, one
 * twenty-thousand-element array value, or one twenty-thousand-character key
 * name each produced tens of kilobytes from per-field caps alone. The reply
 * itself is only soft-limited, by the websocket's payload ceiling.
 *
 * Downstream caps exist but are not a substitute: `markUntrustedToolFailure`
 * cuts the model-facing copy at `MAX_TOOL_RESULT_CHARS`, and nothing cuts the
 * copies that get logged or stored. (It would also be the wrong cut to rely on
 * here -- `describeMachine` is at the START of this message and there is no
 * remedy clause after the interpolation, so an end-truncation would take this
 * text rather than the sentence around it.)
 *
 * NOT a machine-readable rendering, and not pretending to be one. A remote
 * machine can put `[pid=1]` or a truncation marker inside its own `error`
 * string and have it render indistinguishably from the real tail, and a key
 * name containing `=` can manufacture a pair. `JSON.stringify` was unambiguous
 * by construction and this is not. Accepted because the consumer is a model
 * reading a framed block for a sentence, the worst outcome is a misattributed
 * field, and the thing actually acted on -- the code, status and effect triple
 * -- is not built from this string at all.
 *
 * Still only a READABILITY change: the caller's triple is untouched, which is
 * what #605 established and #620 verified. The try/catch is what makes that
 * structural rather than circumstantial -- this runs inside `dispatchToSidecar`'s
 * `try`, so a throw here would be relabelled `SIDECAR_OUTCOME_UNKNOWN` by the
 * catch below and silently change the outcome. `JSON.stringify` cannot throw on
 * a `JSON.parse` product, so this is a guard against a future caller rather than
 * a live bug.
 *
 * And it does NOT frame the text -- framing this path is #629's subject, and it
 * happens at the model boundary. Which means this helper must not be reused in
 * front of a PERSON without a `forCard`-style reduction: dropping the old
 * `JSON.stringify` also dropped its incidental escaping, so newlines, C0 and
 * bidi characters now reach the string as themselves.
 */
function describeReplyFailure(reply: Record<string, unknown>): string {
  try {
    return boundRemote(replyFailureSentence(reply), MAX_REPLY_DESCRIPTION_CHARS);
  } catch {
    return '(the reply could not be rendered)';
  }
}

function replyFailureSentence(reply: Record<string, unknown>): string {
  const field = REPLY_FAILURE_FIELDS.find((f) => typeof reply[f] === 'string' && (reply[f] as string).trim().length > 0);
  // No sentence to read: carry the struct, with the budget the sentence would
  // have had rather than the tail's, since it is now the whole diagnosis.
  if (!field) return boundRemote(JSON.stringify(reply), MAX_REPLY_DESCRIPTION_CHARS);
  const said = boundRemote((reply[field] as string).trim(), MAX_REPLY_FIELD_CHARS);
  // `success` is the flag that selected this branch, so repeating it says
  // nothing; the consumed field is already the sentence.
  const entries = Object.entries(reply).filter(([k]) => k !== field && k !== 'success');
  const rest = entries.slice(0, MAX_REPLY_TAIL_PAIRS).map(([k, v]) => {
    // A field the issue is about keeps the sentence budget even when it lost
    // the sentence; anything else is incidental context and gets the short one.
    const budget = (REPLY_FAILURE_FIELDS as readonly string[]).includes(k)
      ? MAX_REPLY_FIELD_CHARS : MAX_REPLY_TAIL_CHARS;
    const rendered = typeof v === 'string' ? boundRemote(v, budget) : boundRemote(JSON.stringify(v), budget);
    return `${boundRemote(k, MAX_REPLY_KEY_CHARS)}=${rendered}`;
  });
  if (entries.length > rest.length) rest.push(`(+${entries.length - rest.length} more fields)`);
  return rest.length > 0 ? `${said} [${rest.join(', ')}]` : said;
}

/**
 * One dispatch, with every check and every refusal the two public wrappers
 * share. Only the success path yields `kind: 'reply'`, so a caller that reads a
 * field off the reply is looking at something a sidecar actually sent.
 *
 * The refusals below are the ones a tool called DIRECTLY gets. Inside a
 * workflow, `scope.assertDispatch` refuses first and more coarsely:
 * `WORKFLOW_CAPABILITY_UNAVAILABLE` covers "the operator turned it off" and
 * "the host cannot provide it" with one code and one message
 * (src/workflows/runtime/machine-binding.ts), so the distinctions this function
 * draws do not reach a model running a bound flow. Noted because it is easy to
 * read the list below as the whole story.
 */
async function dispatchToSidecar(
  target: string,
  method: string,
  params: Record<string, unknown>,
  requiredCapability: SidecarCapability,
  typedErrors: boolean,
): Promise<SidecarDispatch> {
  // Ahead of the typed/legacy split: a workflow binding failure must stay an
  // exception even for tools that have not adopted typed outcomes.
  const scope = getMachineScope();
  if (scope) {
    target = scope.resolveTarget(target, requiredCapability)!;
    scope.assertDispatch(target, requiredCapability);
  }
  // Keep legacy text callers stable while desktop tools adopt the typed
  // contract. Classification happens here, never by parsing display text.
  const fail = (status: ActionFailure['status'], code: string, message: string,
    effect: ActionFailure['effect'] = 'not_started'): SidecarDispatch => {
    failedToolResult(undefined);
    if (typedErrors) throw new ActionOutcomeError({ status, code, message, effect });
    return { kind: 'message', text: message, code };
  };
  if (!sidecarManager) {
    return fail('blocked', 'SIDECAR_UNINITIALIZED', 'Error: Sidecar system not initialized.');
  }

  const sidecars = sidecarManager.listSidecars();
  const sidecar = findSidecar(target, sidecars);

  if (!sidecar) {
    const available = sidecars.map((s) => s.name).join(', ') || 'none';
    return fail('blocked', 'SIDECAR_NOT_FOUND', `Error: No sidecar found matching "${target}". Available: ${available}`);
  }

  if (!sidecar.connected) {
    return fail('blocked', 'SIDECAR_OFFLINE', `Error: Sidecar "${describeMachine(sidecar)}" is offline.`);
  }

  // A capability the operator ENABLED that the host cannot provide. Named as
  // neither of the other two so the three cannot be read for each other: not a
  // setting to flip, and not a version to raise.
  const unavail = sidecar.unavailable_capabilities?.find(u => u.name === requiredCapability);
  if (unavail) {
    return fail('blocked', 'CAPABILITY_UNAVAILABLE', `Error: Sidecar "${sidecar.name}" has "${requiredCapability}" enabled but it is unavailable: ${unavail.reason}. That is something missing on that machine, not a capability setting - ask the user to install what the reason names. Do NOT retry.`);
  }

  if (sidecar.capabilities && !sidecar.capabilities.includes(requiredCapability)) {
    // #605's neighbour. An operator who turned the capability off and a sidecar
    // too old to have heard of the name BOTH leave it out of this list, and the
    // remedies are opposites. A sidecar that is not behind rules age out, so
    // only the setting is named; otherwise both are, and the message says so
    // rather than picking one and being confidently wrong half the time.
    const standing = sidecarStanding(sidecar);
    const remedy = standing.age === 'current'
      ? `Do NOT retry - ask the user to enable it in the sidecar's config.`
      : `Do NOT retry. Either the operator turned it off, in which case ask the user to enable it in the sidecar's config, or this sidecar is too old to offer it at all${standing.note}, in which case ask the user to update it.`;
    return fail('blocked', 'CAPABILITY_DISABLED', `Error: Sidecar "${sidecar.name}" does not advertise the "${requiredCapability}" capability. Available capabilities: ${sidecar.capabilities.join(', ') || 'none'}. ${remedy}`);
  }

  try {
    const result = await sidecarManager.dispatchRPC(sidecar.id, method, params);

    // This is the run_command handler's receipt, before display serialization.
    // Other methods can return arbitrary file/page data with similar field names.
    if (method === 'run_command' && result && typeof result === 'object'
      && 'exit_code' in result && typeof result.exit_code === 'number' && result.exit_code !== 0) {
      failedToolResult(undefined);
    }

    if (result === 'detached') {
      // The RPC outlived the initial timeout. Detached completions are only
      // console-logged (manager.ts onDetachedComplete) — the result never
      // reaches the model — so claiming background success would be a lie
      // for anything interactive. Only run_command keeps fire-and-forget
      // semantics; everything else reports an honest timeout.
      if (method === 'run_command' && !typedErrors) {
        return { kind: 'message', text: `Command dispatched to "${describeMachine(sidecar)}" and still running in the background. Its output will NOT be reported back — verify its effect yourself if it matters.` };
      }
      return fail('unknown', 'SIDECAR_TIMEOUT', `Error [${describeMachine(sidecar)}]: "${method}" did not complete within the timeout. The action may or may not have taken effect — do NOT assume it succeeded; verify the current state (e.g. take a snapshot) before continuing.`, 'may_have_occurred');
    }

    // A structured negative receipt is a failure the handler reported about
    // itself, so it is an outcome rather than a value -- and nothing in the
    // reply is lost: what the handler SAID leads the sentence and every other
    // field follows it, so the pid and the handler's own note both survive
    // without the model having to read a failure out of a struct (#627).
    //
    // `window_visible: null` is deliberately NOT one of these. The sidecar
    // sets it alongside `success: true` for "the process is alive and I could
    // not look for its window" (Wayland, no xdotool, an unprompted Mac), and
    // its handlers exist to stop that being reported as a failure: called one,
    // the model relaunches an app that is already open. See
    // launchResultLinux / launchResultDarwin.
    if (typedErrors && result && typeof result === 'object') {
      const reply = result as Record<string, unknown>;
      if (reply.success === false) {
        return fail('error', 'SIDECAR_ACTION_FAILED', `Error [${describeMachine(sidecar)}]: "${method}" reported failure: ${describeReplyFailure(reply)}`, 'may_have_occurred');
      }
    }

    return { kind: 'reply', result };
  } catch (err) {
    if (err instanceof ActionOutcomeError) {
      failedToolResult(undefined);
      if (typedErrors) throw err;
      return { kind: 'message', text: `Error [${describeMachine(sidecar)}]: ${err.message}` };
    }
    const msg = err instanceof Error ? err.message : String(err);

    // METHOD_NOT_FOUND means the sidecar does not HAVE the method, so it is
    // older than this brain -- NOT a capability the operator turned off (#605).
    // The two used to share one message, and it was the wrong one: the
    // capability check above has already run and PASSED, so by the time control
    // reaches here this sidecar has positively advertised the capability. The
    // old sentence sent the user to a config file that is fine while the real
    // remedy, a sidecar update, went unsaid (#442: a Mac on 0.9.6).
    //
    // There is ALWAYS a sidecar-side remedy, and it is never the config. What
    // it is depends on the version standing, and that is read with an ORDERED
    // comparison, not from `update_available` -- which is false for a
    // non-canonical version and for `dev` builds (src/sidecar/compat.ts),
    // precisely the sidecars most likely to be missing a method.
    //
    // The 'current' case is the one worth spelling out, because it is the
    // normal state of `main`: a method lands in the brain and `sidecar/VERSION`
    // is bumped in a later commit (browser_element_point did exactly that), so
    // a user on the newest released sidecar legitimately has no method and no
    // update to install. Telling them to update then is as useless as telling
    // them to check a config file, which is the whole complaint in #605.
    if (err instanceof SidecarRPCError && err.code === 'METHOD_NOT_FOUND' || !typedErrors && msg.includes('METHOD_NOT_FOUND')) {
      const standing = sidecarStanding(sidecar);
      // Claimed only where the check above actually established it: that guard
      // is skipped when `capabilities` is undefined, and an emphatic "this is
      // not a configuration problem" is not something to assert on a hunch.
      const advertised = sidecar.capabilities?.includes(requiredCapability)
        ? ` It does advertise the "${requiredCapability}" capability, so this is NOT a configuration problem and nothing in the sidecar's config will fix it.`
        : '';
      const [diagnosis, remedy] = standing.age === 'current'
        ? [`so its build predates that method${standing.note} -- which means there may be nothing newer to install: if a fresh sidecar was just built, a stale jarvis-sidecar process has probably reconnected in its place.`,
           `Do NOT retry this call - ask the user to make sure that machine is running the newest sidecar build.`]
        : [`so it is older than this brain${standing.note}.`,
           `Do NOT retry this call - ask the user to update the sidecar on that machine.`];
      return fail('blocked', 'METHOD_NOT_FOUND', `Error [${describeMachine(sidecar)}]: this sidecar has no "${method}" method, ${diagnosis}${advertised} ${remedy}`);
    }

    // The OS goes in the message on purpose: the commonest remote failure is
    // a command written for the wrong platform (`notepad.exe` sent to a Mac),
    // and "command not found" alone tells neither the model nor the user why.
    const refused = err instanceof SidecarRPCError && NOT_STARTED_RPC_CODES.has(err.code);
    return fail(err instanceof SidecarRPCError ? 'error' : 'unknown',
      err instanceof SidecarRPCError ? err.code : 'SIDECAR_OUTCOME_UNKNOWN',
      `Error [${describeMachine(sidecar)}]: ${msg}`, refused ? 'not_started' : 'may_have_occurred');
  }
}

/**
 * Route an RPC call to a sidecar. Returns the result string, or an error message.
 *
 * @param target - Sidecar name or ID
 * @param method - RPC method name (e.g. "run_command", "read_file")
 * @param params - RPC parameters
 * @param requiredCapability - The sidecar must advertise this capability
 */
export async function routeToSidecar(
  target: string,
  method: string,
  params: Record<string, unknown>,
  requiredCapability: SidecarCapability,
  typedErrors = false,
): Promise<string> {
  const out = await dispatchToSidecar(target, method, params, requiredCapability, typedErrors);
  if (out.kind === 'message') return out.text;
  // Unchanged from before the split, including the stringify: most methods
  // reply with a string, and the ones that reply with an object are read as
  // display text by their callers.
  return typeof out.result === 'string' ? out.result : JSON.stringify(out.result, null, 2);
}

/** Desktop callers require a typed failure, even outside workflows. */
export function routeToSidecarAction(target: string, method: string,
  params: Record<string, unknown>, capability: SidecarCapability): Promise<string> {
  return routeToSidecar(target, method, params, capability, true);
}

/**
 * Longest `loader_id` accepted off the wire.
 *
 * Chrome's is a short hex string, and the sidecar already refuses to send one
 * over 64 bytes. This is the daemon not taking that on trust: an unbounded field
 * from another machine is an unbounded field, whatever the sender promises.
 */
const MAX_LOADER_ID_LENGTH = 128;

/**
 * A browser read from a remote browser: the page text, plus the URL the BROWSER
 * confirmed for it, or null.
 *
 * Returned as ONE VALUE on purpose (#583). The pairing is the guarantee: #579
 * requires that the URL name the document the text came from, and a URL handed
 * back through a side channel -- a callback writing to a variable the caller
 * closed over -- makes that pairing temporal instead of structural. It would hold
 * only while nothing was ever added after the decode, which is invisible at the
 * call site and would fail silently as a stale URL against fresh text.
 */
export type SidecarPageRead = { readonly text: string; readonly pageUrl: string | null };

/**
 * Read the structural page identity out of a browser reply (#583).
 *
 * TYPE-CHECKED, not cast. The value arrives from `JSON.parse` on another
 * machine, through a validator that preserves arrays and objects verbatim
 * (`sanitize` in sidecar/validator.ts), and `usablePageUrl` downstream is built
 * of `.length`, a regex and `new URL()` -- all three of which COERCE, so
 * `["https://mail.google.com/"]` would sail through a `string | null`
 * annotation that TypeScript erases at runtime and select Gmail's playbook.
 * TypeScript describes the reply; only these checks constrain it.
 *
 * AND A URL IS NEVER ACCEPTED WITHOUT A LOADER ID. That is what carries #579's
 * same-document guarantee across the wire: the sidecar reports an identity only
 * when the browser named the document AND held the page to that name across the
 * read, so a URL arriving without one did not come from that path and is not the
 * thing the guarantee is about. The daemon cannot redo the check itself -- that
 * would be another round-trip, at a different instant, to the machine making the
 * claim -- so it refuses what it cannot vouch for instead.
 *
 * An older sidecar replies with a bare string: that is the whole reply, and there
 * is no identity to read. Same for any shape that is not the documented one.
 */
function readSidecarPageReply(result: unknown): SidecarPageRead {
  if (typeof result === 'string') return { text: result, pageUrl: null };
  if (result === null || typeof result !== 'object' || Array.isArray(result)) {
    return { text: JSON.stringify(result, null, 2), pageUrl: null };
  }
  const reply = result as Record<string, unknown>;
  // No usable text half means no page, so there is no identity worth reading
  // either -- and the fallback keeps the pre-#583 rendering of an odd reply.
  if (typeof reply.text !== 'string') return { text: JSON.stringify(result, null, 2), pageUrl: null };
  const hasLoader = typeof reply.loader_id === 'string'
    && reply.loader_id.length > 0
    && reply.loader_id.length <= MAX_LOADER_ID_LENGTH;
  const pageUrl = hasLoader && typeof reply.page_url === 'string' ? reply.page_url : null;
  return { text: reply.text, pageUrl };
}

/**
 * Route a browser READ (`browser_navigate`, `browser_snapshot`) and bring back
 * the browser-confirmed page URL with it (#583).
 *
 * Asking for the identity is an opt-in request parameter, so an older sidecar
 * that has never heard of it replies with the bare text it always did and this
 * returns `pageUrl: null`. The flag is set HERE, from trusted code, and is not
 * taken from the tool's own parameters: nothing a model writes may decide the
 * shape of a reply this function reads structurally.
 *
 * A dispatch that never reached a page -- no such sidecar, offline, capability
 * refused, detached past the timeout -- yields a message rather than a reply, so
 * `pageUrl` is null exactly when no page was confirmed. `WHY` says which, for a
 * log line the caller writes: the silent version of this is #583 itself, where a
 * remote browser simply never got a playbook and nothing said so.
 */
export async function routeBrowserReadToSidecar(
  target: string,
  method: 'browser_navigate' | 'browser_snapshot',
  params: Record<string, unknown>,
): Promise<SidecarPageRead & { readonly why: 'confirmed' | 'no_reply' | 'no_page_identity' }> {
  const out = await dispatchToSidecar(target, method, { ...params, page_identity: true }, 'browser', false);
  if (out.kind === 'message') return { text: out.text, pageUrl: null, why: 'no_reply' };
  const read = readSidecarPageReply(out.result);
  return { ...read, why: read.pageUrl ? 'confirmed' : 'no_page_identity' };
}

/**
 * Widest absolute screen coordinate the brain will pass on.
 *
 * A SANITY BOUND, not a screen size, and far outside any real multi-monitor
 * desktop. It fits the pebble's `atomic.Int32` target
 * (sidecar/pebble_runtime.go) with room to spare, which is the floor it must
 * clear rather than the reason for its value -- nothing can be read off a
 * screen here, because `platformGetScreenSize` is a hardcoded stub on darwin
 * and linux.
 *
 * `maxElementPointCoord` in sidecar/browser_element_point.go is the same
 * number, and both ends check: the sidecar computes the point, but the brain is
 * the one that hands it to `pebble.point_at`, and a confident pointer at the
 * wrong place is the single outcome #585 and #591 exist to prevent. The two
 * constants are a matched pair -- see the note in
 * docs/sidecar/SIDECAR_PROTOCOL.md.
 */
const MAX_ELEMENT_POINT_COORD = 1 << 20;

/** Where a snapshot element is on the sidecar's screen, or why we do not know. */
export type SidecarElementPoint =
  | { readonly kind: 'point'; readonly x: number; readonly y: number; readonly loaderId: string }
  | { readonly kind: 'none'; readonly why: ElementPointRefusal };

/**
 * Why no point came back: a CLOSED set of brain-authored reasons, so the log
 * line a caller writes never interpolates text from another machine.
 */
export type ElementPointRefusal =
  /** The dispatch never reached a page -- offline, capability off, timed out. */
  | 'no_reply'
  /** The sidecar has no such method, so it predates this surface (#591). */
  | 'sidecar_too_old'
  /** The sidecar's handler refused: no browser, headless, stale id, off-screen. */
  | 'refused'
  /** The reply was not the documented shape, or claimed a space we do not know. */
  | 'unusable_reply';

/**
 * The only coordinate space this brain knows how to hand `pebble.point_at`.
 *
 * Checked rather than assumed, and that is the entire purpose of the field. The
 * sidecar's answer is exact on macOS and Linux and off by the DPI scale on
 * Windows above 100%; when a measured per-platform conversion lands it ships
 * under a NEW space name, and an unpatched brain then refuses and shows
 * "(location unknown)" rather than confidently misplacing the pointer.
 */
const ELEMENT_POINT_SPACE = 'screen_dip';

/**
 * Read a `browser_element_point` reply, strictly.
 *
 * TYPE-CHECKED, not cast, for the reason #594 gives at length: the value came
 * from `JSON.parse` on another machine, through a validator that preserves
 * arrays and objects verbatim (`sanitize` in src/sidecar/validator.ts), and
 * everything downstream COERCES -- `Math.round(["431"])` is 431, and arithmetic
 * on a one-element array works. So a `number` annotation, which TypeScript
 * erases at runtime, would let `{"x": ["431"]}` through. TypeScript describes
 * the reply; only these checks constrain it.
 *
 * A COORDINATE IS NEVER ACCEPTED WITHOUT ITS LOADER ID. That is #594's pairing
 * rule transposed: there, no `page_url` without a `loader_id`, because the
 * loader id is what makes the URL name this document; here, no `x`/`y` without
 * one, because it is what says which document the two numbers describe. The
 * sidecar sends all four or an error, so a reply carrying a coordinate and no
 * identity did not come from that path and is not the thing the guarantee is
 * about.
 */
function readSidecarElementPoint(result: unknown): SidecarElementPoint {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) {
    return { kind: 'none', why: 'unusable_reply' };
  }
  const reply = result as Record<string, unknown>;
  // OWN properties only. Dotted access walks the prototype chain, so with a
  // polluted `Object.prototype` an EMPTY reply would answer a complete,
  // confident point -- exactly the outcome this whole change exists to prevent.
  // `sanitize` (src/sidecar/validator.ts) does strip `__proto__` and rebuild
  // plain objects, so the sidecar channel cannot supply the pollution itself;
  // this is the cheap half of not depending on that.
  if (!Object.hasOwn(reply, 'space') || !Object.hasOwn(reply, 'loader_id')
    || !Object.hasOwn(reply, 'x') || !Object.hasOwn(reply, 'y')) {
    return { kind: 'none', why: 'unusable_reply' };
  }
  if (reply.space !== ELEMENT_POINT_SPACE) {
    return { kind: 'none', why: 'unusable_reply' };
  }
  // Every field is bound ONCE, before it is checked, so a property that is a
  // getter cannot answer one value to the check and another to the use. Not
  // reachable through `JSON.parse`, which cannot produce getters -- but the
  // alternative is a function whose guarantees depend on that staying true.
  const { x, y, loader_id: loaderId } = reply;
  if (typeof loaderId !== 'string'
    || loaderId.length === 0
    || loaderId.length > MAX_LOADER_ID_LENGTH) {
    return { kind: 'none', why: 'unusable_reply' };
  }
  if (typeof x !== 'number' || typeof y !== 'number'
    || !Number.isFinite(x) || !Number.isFinite(y)
    || Math.abs(x) > MAX_ELEMENT_POINT_COORD || Math.abs(y) > MAX_ELEMENT_POINT_COORD) {
    return { kind: 'none', why: 'unusable_reply' };
  }
  return { kind: 'point', x: Math.round(x), y: Math.round(y), loaderId };
}

/**
 * Ask a sidecar where the element its last snapshot called `elementId` sits on
 * its screen (#591).
 *
 * This is what lets the pebble point at a browser action again. #585 made the
 * narration read the click's own coordinates and fail closed when there are
 * none -- and on a default install there are none, because `CapBrowser` is in
 * the sidecar's default capability set, so the click runs there and its
 * coordinate map lives in that process. PR #590 was held in draft for exactly
 * this gap.
 *
 * READ-ONLY on the far side, which is what makes it safe for a narration to
 * call at all: it cannot launch a browser, evaluate script, move focus or
 * navigate. sidecar/browser_element_point.go enforces that structurally and
 * docs/sidecar/SIDECAR_PROTOCOL.md states the contract. The path this replaces
 * dispatched `browser_evaluate`, which is `execute_command` authority in
 * TOOL_ACTION_MAP -- the same class as `run_command` -- and could lazily start
 * a headed Chromium for a cosmetic code path.
 *
 * `element_id` is the ONLY parameter sent, and pointedly not the tool's own
 * arguments: no `headless` (which on a sibling method tears a running browser
 * down and relaunches it) and no `target` override. Nothing a model writes may
 * widen what this call does or where it goes.
 *
 * AN OLDER SIDECAR DOES NOT ANSWER, and that is detected from the dispatch's
 * `code`. A method that does not exist leaves no reply field to duck-type on,
 * so `METHOD_NOT_FOUND` is the signal -- read as a code rather than as text.
 * Since #605 that text says "older than this brain" and no longer asserts the
 * capability is disabled, which removes the mismatch this classification was
 * working around; it does NOT make the text safe to classify on. Display text
 * is written for the model and gets reworded, and some of the refusals on this
 * path come from `refuseLocalContent`, whose message embeds the page URL.
 *
 * One honest caveat: `dispatchToSidecar`'s catch ALSO matches that literal as a
 * substring of the error message, which predates typed codes and is left alone
 * here. So a sidecar whose own refusal message happens to contain
 * "METHOD_NOT_FOUND" would be labelled too old rather than refusing. That costs
 * a diagnosis in a log line and nothing else: both are `kind: 'none'`. Either
 * way the answer is `kind: 'none'`, the
 * caller keeps #585's fail-closed path, and NOTHING falls back to a re-query:
 * not `browser_evaluate`, not this process's own local `elementCoords` (which
 * may hold a live snapshot of a different page the model visited locally, and a
 * hit there would look exactly as authoritative as a real answer), and not a
 * fresh DOM lookup.
 */
export async function routeBrowserElementPointToSidecar(
  target: string,
  elementId: number,
): Promise<SidecarElementPoint> {
  const out = await dispatchToSidecar(
    target, 'browser_element_point', { element_id: elementId }, 'browser', false,
  );
  if (out.kind === 'message') {
    // Classified on the CODE. `BROWSER_*` are the handler's own coded refusals
    // (sidecar/browser_element_point.go); everything else -- offline, no such
    // sidecar, capability off, timed out, or a message written outside `fail`
    // and carrying no code at all -- means the call never reached a page, which
    // the dispatch has already explained.
    const code = out.code;
    return {
      kind: 'none',
      why: code === 'METHOD_NOT_FOUND' ? 'sidecar_too_old'
        : code?.startsWith('BROWSER_') ? 'refused'
        : 'no_reply',
    };
  }
  return readSidecarElementPoint(out.result);
}
