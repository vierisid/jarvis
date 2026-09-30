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
import { getMachineScope } from '../machine-scope.ts';

let sidecarManager: SidecarManager | null = null;

/**
 * RPC error codes a sidecar sends for a request it refused before acting
 * (codedError in sidecar/client.go). Every other handler error may follow a
 * partial effect.
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
  | { readonly kind: 'message'; readonly text: string };

/**
 * One dispatch, with every check and every refusal the two public wrappers
 * share. Only the success path yields `kind: 'reply'`, so a caller that reads a
 * field off the reply is looking at something a sidecar actually sent.
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
    if (typedErrors) throw new ActionOutcomeError({ status, code, message, effect });
    return { kind: 'message', text: message };
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

  // Check if capability is enabled but unavailable (missing system dependencies)
  const unavail = sidecar.unavailable_capabilities?.find(u => u.name === requiredCapability);
  if (unavail) {
    return fail('blocked', 'CAPABILITY_UNAVAILABLE', `Error: Sidecar "${sidecar.name}" has "${requiredCapability}" enabled but it is unavailable: ${unavail.reason}. Do NOT retry.`);
  }

  if (sidecar.capabilities && !sidecar.capabilities.includes(requiredCapability)) {
    return fail('blocked', 'CAPABILITY_DISABLED', `Error: Sidecar "${sidecar.name}" does not have the "${requiredCapability}" capability enabled. Available capabilities: ${sidecar.capabilities.join(', ')}. Do NOT retry — ask the user to enable it in the sidecar's config if needed.`);
  }

  try {
    const result = await sidecarManager.dispatchRPC(sidecar.id, method, params);

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
    // itself, so it is an outcome rather than a value -- and the whole reply
    // is carried so the pid and the handler's own note are not lost.
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
        return fail('error', 'SIDECAR_ACTION_FAILED', `Error [${describeMachine(sidecar)}]: "${method}" reported failure: ${JSON.stringify(reply)}`, 'may_have_occurred');
      }
    }

    return { kind: 'reply', result };
  } catch (err) {
    if (err instanceof ActionOutcomeError) {
      if (typedErrors) throw err;
      return { kind: 'message', text: `Error [${describeMachine(sidecar)}]: ${err.message}` };
    }
    const msg = err instanceof Error ? err.message : String(err);

    // METHOD_NOT_FOUND means the capability is disabled — tell the LLM not to retry
    if (err instanceof SidecarRPCError && err.code === 'METHOD_NOT_FOUND' || !typedErrors && msg.includes('METHOD_NOT_FOUND')) {
      return fail('blocked', 'METHOD_NOT_FOUND', `Error [${describeMachine(sidecar)}]: Method "${method}" is not available. The "${requiredCapability}" capability is not enabled on this sidecar. Do NOT retry this call — ask the user to enable the capability in the sidecar's config if needed.`);
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
