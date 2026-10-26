/**
 * What a voice path may do with a room action that changes more than the
 * screen (#973).
 *
 * A room action runs the dashboard handler, whose REST calls reach the daemon
 * as clicks: no authority check, no taint gate, no realtime blocked
 * categories. ROOM_ACTIONS says which authority categories each action
 * reaches, and this holds a voice path to the emergency state, the realtime
 * blocked categories and the taint gate the way its own tool calls are. The
 * authority engine's own decision (a level cap, a deny override) is not
 * consulted: the handlers are clicks, and a click is not judged by it either.
 *
 * A voice command is the person's authority (the owner's decision), so an
 * ordinary action goes. The line is taint, as in lifecycle-gate.ts and the
 * realtime tool path in the orchestrator: once a realtime session has read
 * outside content this turn, an action whose category the taint profile
 * governs is refused, and the model tells the person to say it again as a
 * fresh request. The realtime path refuses rather than raising a card for the
 * same reason the realtime tool path does: there is no approval card that can
 * carry a dashboard handler out.
 *
 * The classifier is different. It has no turn the taint gate can see, it reads
 * the last few assistant replies (which repeat whatever outside content those
 * turns read), and it grades its own impact and confidence, so nothing the
 * daemon derives decides whether it acts. For an action in the governed
 * categories it does not act on its own reading at all: it holds the action
 * and repeats back what it would do, and the person's "yes" runs it: a click,
 * or a plain spoken yes that ws-service reads from the transcript itself, on
 * the same dashboard, within a minute, with no other hold it could be about.
 * That keeps voice as the authority while the person checks the one thing
 * that can go wrong, which is the classifier's reading.
 */

import { DEFAULT_TAINT_GOVERNED, taintProfile, type TaintGating } from '../authority/taint-gating.ts';
import { roomActionCategories, type RoomActionCategory } from './room-actions.ts';
import type { RoomActionOutcome, RoomAnswer } from './room-action-results.ts';
import type { AuthorityDecisionType, ResolutionChannel } from '../authority/audit.ts';
import {
  collapseRoomActionAliases, foldEntityName, matchByTitle, matchEntityByName, matchProjectByName, roomActionArgs, roomActionEntityArg,
  roomActionTargetKind, roomActionTimeArg, SETTLED_TIME_ARG, withRoomActionDefaults, type RoomActionTargetKind,
} from './room-action-targets.ts';
import { PASSED_GRACE_MS, parseRelativeDate } from '../voice/parse-date.ts';

export type RealtimeRoomActionContext = {
  /** The emergency state when it stops execution (paused, killed), else null. */
  halted: string | null;
  /** The realtime config's `blocked_categories`. */
  blockedCategories: readonly string[];
  taintGating: TaintGating | null;
  /** Outside content the realtime session read since the person last spoke. */
  taint: ReadonlySet<string>;
};

/**
 * Why the realtime model may not send `ra`, as the tool result it reads, or
 * null when it may. Presentation actions always may. The order is the
 * realtime tool path's: emergency, blocked categories, taint.
 */
export function realtimeRoomActionRefusal(
  ra: { room: string; action: string },
  ctx: RealtimeRoomActionContext,
): string | null {
  return realtimeRoomActionDecision(ra, ctx)?.message ?? null;
}

/**
 * realtimeRoomActionRefusal with why, for the audit row (#1009): the
 * emergency state, `blocked`, or `tainted`.
 */
export function realtimeRoomActionDecision(
  ra: { room: string; action: string },
  ctx: RealtimeRoomActionContext,
): { reason: 'paused' | 'killed' | 'blocked' | 'tainted'; message: string } | null {
  const categories = roomActionCategories(ra.room, ra.action);
  if (categories.length === 0) return null;
  const what = `${ra.room}/${ra.action}`;
  if (ctx.halted) {
    return { reason: ctx.halted === 'killed' ? 'killed' : 'paused', message: `[SYSTEM ${ctx.halted.toUpperCase()}] ${what} was not sent: actions are suspended while the system is ${ctx.halted}.` };
  }
  const blocked = categories.find((c) => ctx.blockedCategories.includes(c));
  if (blocked) {
    return { reason: 'blocked', message: `[BLOCKED] ${what} (${blocked}) is in the realtime blocked-categories list and was not sent.` };
  }
  const governed = taintProfile(ctx.taintGating, ctx.taint)?.governed_categories ?? [];
  const tainted = categories.find((c) => governed.includes(c));
  if (tainted) {
    return {
      reason: 'tainted',
      message: `[BLOCKED] ${what} (${tainted}) was not sent: this session read outside content (${[...ctx.taint].join(', ')}) and voice cannot approve it. `
        + 'Tell the user what you wanted to do and ask them to say it again as a fresh request.',
    };
  }
  return null;
}

/**
 * Whether the classifier must hold `ra` for the person to confirm rather than
 * act on its own reading: any action reaching a category the taint gating
 * governs. The governed list is the codebase's one definition of an action
 * that must not follow from an unchecked reading, so an owner who narrows it
 * narrows this too. The gating's on/off switch does not apply: this is not a
 * taint check, since the classifier has no taint to check.
 */
export function classifierMustConfirmRoomAction(
  ra: { room: string; action: string },
  gating: TaintGating | null,
): boolean {
  const governed: readonly string[] = gating?.governed_categories ?? DEFAULT_TAINT_GOVERNED;
  return roomActionCategories(ra.room, ra.action).some((c) => governed.includes(c));
}

/**
 * Where a voice room action came from (#1009): the realtime model's tool
 * call, the classifier (acting on its own reading, or holding the action for
 * a yes, which is also the origin recorded when the hold is dropped), or the
 * person's answer to a hold.
 */
export type RoomActionOrigin = 'realtime' | 'classifier' | 'confirm';

export type RoomActionAuditRow = {
  agent_id: string;
  agent_name: string;
  tool_name: string;
  action_category: RoomActionCategory;
  authority_decision: AuthorityDecisionType;
  approval_id: string | null;
  executed: boolean;
  channel: ResolutionChannel;
};

/**
 * What became of a voice room action, as its audit row records it (#1009):
 * the room's answer when it was sent, or why it was not. `no_answer` is not
 * "did not run": a room can run it and answer too late to be heard.
 */
export type RoomActionAuditReason =
  | RoomActionOutcome
  // The room's answer after its wait ran out, and what the first row said
  // then, on a follow-up row (#1034).
  | `late_${RoomAnswer}_after_${'started' | 'no_answer'}`
  // Its dashboard went before answering an action recorded as started.
  | 'late_disconnected_after_started'
  | 'held' | 'refused_yes' | 'cancelled' | 'unsettled' | 'blocked' | 'tainted'
  | 'paused' | 'killed' | 'expired' | 'disconnected' | 'shutdown' | 'failed' | 'not_a_room_action';

/**
 * Whether a room action the room answered for ran, for its audit row: done,
 * or under way when the wait ran out (#1015). Held for a card (#1016),
 * declined or unanswered is not.
 */
export function roomActionExecuted(outcome: RoomActionOutcome): boolean {
  return outcome === 'accepted' || outcome === 'started';
}

/**
 * The audit row for a decision about a voice room action (#1009), or null for
 * a view action, which changes only a screen. Realtime tool calls write
 * `channel: 'voice'` rows; room actions reach `make dev`, the user profile
 * and commitments through clicks no authority check sees, so for most of them
 * this is the only record of what voice did (agents/spawn_agent also gets the
 * lifecycle gate's own row, #986, when its handler starts the agent).
 *
 * The table has one category column. It holds the first category
 * ROOM_ACTIONS lists for the action, and the tool name carries the room, the
 * action, the origin, every category and the reason, e.g.
 * `room_action(settings/replay_onboarding; via classifier; delete_data,
 * modify_settings; held)`. `executed` is true only when the room said it ran
 * the action (roomActionExecuted): it finished it, or it was still working
 * on it when the wait ran out (reason `started`, #1015, whose end the row
 * cannot know). The reason says whether a false one was declined, held for
 * a card (`pending`, #1016), unreached, or unanswered, which may still have
 * run. When the room answers after `started` or `no_answer`, a follow-up row
 * says what it answered and what the first row reported, e.g.
 * `late_rejected_after_started` (#1034), with `executed` true only for
 * accepted; a started one whose dashboard goes first gets
 * `late_disconnected_after_started`, not run. `approval_id` is the hold's
 * id, linking a hold to what became of it.
 *
 * An authority grant or revoke is not a room action and has no categories,
 * but a voice path asking for one is what #969 refuses by name, so its
 * refusal is recorded too, as `modify_settings`.
 */
export function roomActionAuditRow(
  ra: { room: string; action: string },
  origin: RoomActionOrigin,
  decision: AuthorityDecisionType,
  executed: boolean,
  who: { agentId: string; agentName: string },
  opts: { approvalId?: string | null; channel?: ResolutionChannel; reason: RoomActionAuditReason },
): RoomActionAuditRow | null {
  const listed = roomActionCategories(ra.room, ra.action);
  const authorityOverride = ra.room === 'authority' && (ra.action === 'grant_access' || ra.action === 'revoke_access');
  const categories: readonly RoomActionCategory[] = listed.length > 0 ? listed : authorityOverride ? ['modify_settings'] : [];
  if (categories.length === 0) return null;
  return {
    agent_id: who.agentId,
    agent_name: who.agentName,
    tool_name: `room_action(${ra.room}/${ra.action}; via ${origin}; ${categories.join(', ')}; ${opts.reason})`,
    action_category: categories[0]!,
    authority_decision: decision,
    approval_id: opts.approvalId ?? null,
    executed,
    channel: opts.channel ?? 'voice',
  };
}

/**
 * The items a held action can act on, read the way the dashboard reads them,
 * and the memory entities a fact can attach to (#1023).
 */
export type RoomActionTargetLists = {
  [K in RoomActionTargetKind]: () => Promise<ReadonlyArray<{ id: string } & Record<string, unknown>>>;
} & {
  entity: () => Promise<ReadonlyArray<{ id: string; name: string }>>;
};

const TARGET_NOUN: Record<RoomActionTargetKind, string> = { project: 'project', content: 'content item', task: 'task' };

/** What the person called an item, and the field the room matches it on. */
function targetName(kind: RoomActionTargetKind, item: Record<string, unknown>): string {
  const v = kind === 'project' ? item.name : kind === 'content' ? item.title : item.what;
  return typeof v === 'string' ? v : '';
}

/**
 * A room action as it will be sent. `timeZone` is the zone a time it carries
 * was settled in (#1022), for the card and the reply to name it by; it is
 * not sent to the room, which takes the settled instant as given.
 */
export type HeldRoomAction = { room: string; action: string; args?: Record<string, unknown>; timeZone?: string };

/** When a voice action is settled, and the IANA zone its wall-clock times are in (#1022). */
export type VoiceClock = { now: number; timeZone: string };

/**
 * Why a dashboard's times cannot be read (#1022 review): its browser named a
 * zone this runtime does not know and none is configured. Null instead means
 * the tab never named one at all (it predates #1022).
 */
export type VoiceClockUnavailable = { unavailable: string };

/**
 * What a refusal says when a dashboard's browser named a zone this runtime
 * does not know ("Etc/Unknown") and the config sets none.
 */
export function unrecognisedTimeZone(reported: string): string {
  const shown = reported.length > 40 ? `${reported.slice(0, 40)}...` : reported;
  const said = reported ? `reported a time zone I don't recognise (${quoted(shown)})` : 'did not report a time zone';
  return `your browser ${said}, and no time zone is set in the Jarvis config. `
    + 'Set "timezone" in config.yaml and restart Jarvis, or set the time from the room.';
}

/** A settled time in a refusal: "Wed, Oct 21, 21:00", in its zone. */
function shortTime(ts: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone, weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    // Says which 01:30 on a fall-back night.
    timeZoneName: 'short',
  }).format(new Date(ts));
}

/** How far before now a settled time may be, for the time it takes to say it. */
const SETTLED_TIME_GRACE_MS = PASSED_GRACE_MS;

/** This process's own IANA zone. */
export function daemonTimeZone(): string {
  return new Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/**
 * `value` as an IANA zone this runtime knows, in its canonical spelling, or
 * null (#1022). A dashboard says which zone it is in, and anything else it
 * sends there (not a string, too long, not shaped like a zone name, or a
 * zone the runtime does not have) is no zone at all.
 */
export function voiceTimeZone(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) return null;
  // Digits in the first part too: EST5EDT and GMT0 are zones; so is an
  // offset ("+05:30") where the runtime takes one.
  if (!/^[A-Za-z0-9_+-]+(\/[A-Za-z0-9_+-]+){0,2}$/.test(value) && !/^[+-]\d{2}:?\d{2}$/.test(value)) return null;
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/**
 * A settled time as the card and the reply name it: the date and time in
 * the zone it was settled in, with that zone's abbreviation or offset, so a
 * repeated hour on a fall-back night says which it is, and the zone's name
 * ("Wed, Oct 21, 2026, 09:00 EDT (America/New_York)").
 */
export function describeSettledTime(ts: number, timeZone: string): string {
  const at = new Intl.DateTimeFormat('en-US', {
    timeZone, weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short',
  }).format(new Date(ts));
  return `${at} (${timeZone})`;
}

/** How far from now a settled time may be: a hundred years either way. */
const SETTLED_TIME_SPAN_MS = 100 * 366 * 86_400_000;

/**
 * `ra` with the time it is for settled (#1022): the phrase its time argument
 * holds ("tomorrow at 9") read by parseRelativeDate at `clock.now` in
 * `clock.timeZone`, and the instant pinned in SETTLED_TIME_ARG, which is
 * what the room uses. Any instant `ra` already carries is dropped first:
 * only this step sets one, so one the classifier or the realtime model wrote
 * is never taken as settled. An action with no time argument is returned as
 * it is; one whose phrase is left out keeps none, unless it needs one.
 *
 * Refused, with what to say instead, when the action needs a time and none
 * was given, the phrase does not read as one, or it names a time and there is
 * no `clock` (the dashboard never said its zone). `what` is how the refusal
 * names the action.
 */
export function settleRoomActionTime(
  ra: HeldRoomAction,
  clock: VoiceClock | VoiceClockUnavailable | null,
  what: string,
): { ok: true; ra: HeldRoomAction } | { ok: false; message: string } {
  const spec = roomActionTimeArg(ra.room, ra.action);
  if (!spec) return { ok: true, ra };
  const { [SETTLED_TIME_ARG]: _given, ...args } = ra.args ?? {};
  const said = typeof args[spec.arg] === 'string' ? (args[spec.arg] as string).trim() : '';
  const not = `I haven't done "${what}"`;
  if (!said) {
    if (spec.required) return { ok: false, message: `${not}: say when, like "tomorrow at 3pm", and I'll show you the time before I do it.` };
    return { ok: true, ra: { ...ra, args } };
  }
  // A dashboard tab that never said its zone is one from before #1022: it
  // reads the words again itself, in its own zone, and ignores the instant.
  if (!clock) return { ok: false, message: `${not}: the dashboard tab you spoke to did not say its time zone. Reload the dashboard to set times by voice.` };
  if ('unavailable' in clock) return { ok: false, message: `${not}: ${clock.unavailable}` };
  const parsed = parseRelativeDate(said, clock.now, clock.timeZone);
  // "in 999999999 weeks" reads, but as no date a card can show (#1022 review).
  if (!parsed || Math.abs(parsed.ts - clock.now) > SETTLED_TIME_SPAN_MS) {
    return { ok: false, message: `${not}: I couldn't tell what time ${quoted(said)} means. Say a day and a time with am or pm, like "tomorrow at 3pm" or "friday at 10am".` };
  }
  // A time already gone ("tonight" said at 22:30, "today at 9am" at noon,
  // "yesterday") is refused, not moved: nothing would run when it was meant to.
  if (parsed.ts < clock.now - SETTLED_TIME_GRACE_MS) {
    return { ok: false, message: `${not}: ${quoted(said)} is ${shortTime(parsed.ts, clock.timeZone)}, which has passed. Say a later time.` };
  }
  return { ok: true, ra: { ...ra, args: { ...args, [spec.arg]: said, [SETTLED_TIME_ARG]: parsed.ts }, timeZone: clock.timeZone } };
}

/**
 * A name the classifier gave, as a refusal repeats it to every dashboard:
 * quoted, and cut at 80 characters, since it is not checked against anything.
 */
function quoted(s: string): string {
  // JSON leaves bidi overrides and zero-width characters as they are; written
  // out, one cannot reorder or hide the rest of the reply (#1022 review).
  return JSON.stringify(s.length > 80 ? `${s.slice(0, 80)}...` : s)
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (c) => `\\u${c.codePointAt(0)!.toString(16).padStart(4, '0')}`);
}

/**
 * `ra` as it will run, settled before the person is asked about it (#1008):
 * only the arguments its handler reads (#1021), every default it would
 * supply filled in, and the item it acts on
 * resolved by the room's own match and pinned by id, its full name shown in
 * place of the one heard (a remembered fact's memory entity likewise,
 * resolveHeldEntity, #1023). Its handler takes a pinned id as given
 * (pickRoomActionTarget), so the selection and the list changing between the
 * card and the click cannot change what runs.
 *
 * An action that picks an item must name one: with no name its handler acts
 * on whatever the dashboard has selected, which the daemon cannot see and
 * the person cannot approve. Refused, with what to say instead, when no name
 * was given, nothing matches, or the list cannot be read. `what` is how the
 * refusal names the action.
 *
 * The time it is for is settled too (settleRoomActionTime, #1022), at
 * `clock`, so the card shows the instant that runs, and a phrase that does
 * not read as a time is refused before the card rather than after the yes.
 */
export async function resolveHeldRoomAction(
  ra: HeldRoomAction,
  lists: RoomActionTargetLists,
  what: string,
  clock: VoiceClock | VoiceClockUnavailable | null,
): Promise<{ ok: true; ra: HeldRoomAction } | { ok: false; message: string }> {
  const target = await resolveHeldTarget(ra, lists, what);
  return target.ok ? settleRoomActionTime(target.ra, clock, what) : target;
}

/** resolveHeldRoomAction but for the time: the arguments, defaults and item. */
async function resolveHeldTarget(
  ra: HeldRoomAction,
  lists: RoomActionTargetLists,
  what: string,
): Promise<{ ok: true; ra: HeldRoomAction } | { ok: false; message: string }> {
  // Only what the handler reads is kept (#1021), so the card shows nothing
  // that confirming does not use.
  const args = withRoomActionDefaults(ra.room, ra.action,
    collapseRoomActionAliases(ra.room, ra.action, roomActionArgs(ra.room, ra.action, ra.args)));
  const entityArg = roomActionEntityArg(ra.room, ra.action);
  if (entityArg) return resolveHeldEntity(ra, args, entityArg, lists, what);
  const kind = roomActionTargetKind(ra.room, ra.action);
  if (!kind) return { ok: true, ra: { ...ra, args } };
  const noun = TARGET_NOUN[kind];
  const not = `I haven't done "${what}"`;
  const pinnedId = typeof args.id === 'string' && args.id ? args.id : null;
  const name = typeof args.name === 'string' ? args.name.trim() : '';
  if (!pinnedId && !name) {
    return { ok: false, message: `${not}: say which ${noun} by name, and I'll show you which one before I do it.` };
  }
  let listed: ReadonlyArray<{ id: string } & Record<string, unknown>>;
  try {
    listed = await lists[kind]();
  } catch (err) {
    console.warn(`[voice] could not list ${noun}s for ${ra.room}/${ra.action}:`, err instanceof Error ? err.message : err);
    return { ok: false, message: `${not}: I couldn't look up your ${noun}s just now.` };
  }
  // A finished task is not one a voice command completes, reprioritises or
  // reassigns: a repeating "Pay rent" would otherwise pin last month's.
  const items = kind === 'task' ? listed.filter((i) => i.status !== 'completed' && i.status !== 'failed') : listed;
  const item = pinnedId
    ? items.find((i) => i.id === pinnedId) ?? null
    : kind === 'project'
      ? matchProjectByName(items.map((i) => ({ ...i, name: targetName(kind, i) })), name)
      : matchByTitle(items, (i) => targetName(kind, i), name);
  if (!item) {
    const said = pinnedId ? `with id ${quoted(pinnedId)}` : `called ${quoted(name)}`;
    return { ok: false, message: `${not}: I couldn't find a ${noun} ${said}.` };
  }
  // The card shows the item by its name, so two by the same name are two
  // the person cannot tell apart on it.
  const shown = targetName(kind, item);
  const same = items.filter((i) => targetName(kind, i).trim().toLowerCase() === shown.trim().toLowerCase()).length;
  if (same > 1) {
    return { ok: false, message: `${not}: ${same} ${noun}s are called ${JSON.stringify(shown)}, so I can't tell which you mean. Do it from the room.` };
  }
  return { ok: true, ra: { ...ra, args: { ...args, id: item.id, name: shown } } };
}

/**
 * The memory entity a held remember_that attaches to, settled before its
 * card (#1023): the one its subject names (matchEntityByName, as the Memory
 * room matches), pinned by `id` with its full name in place of the one heard,
 * or `new_entity: true` when none has the name, so the card says a new one
 * will be made. A pinned `id` (parseRoomAction drops one from the
 * classifier) is checked like an item's, and refused when another entity has
 * its name. A subject that matches two or more entities, or a list that
 * cannot be read, is refused, as is a subject or a predicate or object left
 * out.
 *
 * The predicate and object are trimmed, and the predicate lowercased, as the
 * fact is stored, so the card shows what is written.
 */
async function resolveHeldEntity(
  ra: HeldRoomAction,
  settled: Record<string, unknown>,
  entityArg: string,
  lists: RoomActionTargetLists,
  what: string,
): Promise<{ ok: true; ra: HeldRoomAction } | { ok: false; message: string }> {
  const { id: _id, new_entity: _new, ...args } = settled;
  const not = `I haven't done "${what}"`;
  const pinnedId = typeof settled.id === 'string' && settled.id ? settled.id : null;
  const name = typeof args[entityArg] === 'string' ? (args[entityArg] as string).trim() : '';
  if (!pinnedId && !name) return { ok: false, message: `${not}: say what it is about, and I'll show you where it goes before I save it.` };
  if (typeof args.predicate === 'string') args.predicate = args.predicate.trim().toLowerCase();
  if (typeof args.object === 'string') args.object = args.object.trim();
  // The room refuses a fact missing either half, so no card is raised for one.
  if (!args.predicate || !args.object) return { ok: false, message: `${not}: say what to remember about it as well.` };
  let entities: ReadonlyArray<{ id: string; name: string }>;
  try {
    entities = await lists.entity();
  } catch (err) {
    console.warn(`[voice] could not list memory entities for ${ra.room}/${ra.action}:`, err instanceof Error ? err.message : err);
    return { ok: false, message: `${not}: I couldn't look up your memory just now.` };
  }
  // A defensive guard: no current caller reaches it, since parseRoomAction
  // and every unsettled path strip the pin (withoutEntityPin). It is kept so
  // a held action that ever arrives with an id is checked, not trusted.
  if (pinnedId) {
    const entity = entities.find((e) => e.id === pinnedId);
    if (!entity) return { ok: false, message: `${not}: I couldn't find a memory entity with id ${quoted(pinnedId)}.` };
    // The card names it, so another by the same name is one it cannot tell apart.
    const same = entities.filter((e) => foldEntityName(e.name) === foldEntityName(entity.name)).length;
    if (same > 1) return { ok: false, message: `${not}: ${same} things in your memory are called ${quoted(entity.name)}, so I can't tell which you mean. Add it from the room.` };
    return { ok: true, ra: { ...ra, args: { ...args, [entityArg]: entity.name, id: entity.id } } };
  }
  const match = matchEntityByName(entities, name);
  if (match && 'ambiguous' in match) {
    return { ok: false, message: `${not}: ${match.ambiguous} things in your memory match ${quoted(name)}, so I can't tell which you mean. Say its full name, or add it from the room.` };
  }
  if (match) return { ok: true, ra: { ...ra, args: { ...args, [entityArg]: match.entity.name, id: match.entity.id } } };
  return { ok: true, ra: { ...ra, args: { ...args, [entityArg]: name, new_entity: true } } };
}
