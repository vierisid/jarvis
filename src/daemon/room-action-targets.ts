/**
 * What a room action acts on, decided before anyone is asked to approve it
 * (#1008).
 *
 * The classifier path holds a high-impact room action and repeats it back
 * (#973); the person's yes runs it. The card showed the arguments the
 * classifier filled in, but two things were decided only when the handler ran,
 * after the yes:
 *
 *  - a default the handler supplies for an argument left out: replay
 *    onboarding with no scope is scope "all", which clears the user profile;
 *  - the item it acts on: a name matched loosely against whatever list the
 *    dashboard had loaded, or with no name at all, whatever was selected when
 *    the confirmation arrived. View actions are ungated, so the selection can
 *    move between the card and the click.
 *
 * So the daemon resolves both before the card is shown and pins them into the
 * held action, and the handler takes them as given: the defaults by calling
 * withRoomActionDefaults, the item by pickRoomActionTarget, which goes by id
 * when there is one and never falls back to a name or the selection. The
 * card then shows what confirming runs.
 *
 * room-actions.test.ts reads the handlers' side-effecting cases with the
 * TypeScript parser and holds them to these tables in both directions:
 *  - a literal default on an argument (`??`, `||`, either arm of a ternary,
 *    a destructuring default) is in ROOM_ACTION_DEFAULTS, read through
 *    withRoomActionDefaults, and not written in the case;
 *  - an argument that stands in for another is in ROOM_ACTION_ALIASES;
 *  - an item is found only through pickRoomActionTarget(<list>, args, ...),
 *    never by a direct find, findBy*, matcher or the selection;
 *  - every argument a case reads is in ROOM_ACTION_ARGS, and nothing else
 *    is (#1021).
 * It reads each case's own code. A default or lookup inside a data hook the
 * case calls is not seen. remember_that attaches to a memory entity rather
 * than picking an item from the room's list, and creates one when none has
 * the name, so it has its own table (ROOM_ACTION_ENTITY_TARGETS, #1023).
 *
 * NO IMPORTS: the UI bundles this file, as it does room-actions.ts.
 */

/** The onboarding reset scopes, as /api/onboarding/reset accepts them. */
export const ONBOARDING_RESET_SCOPES = ['all', 'setup', 'profile', 'tutorial'] as const;

type ArgDefault = {
  /** What the handler uses when the argument is left out. */
  value: string | null;
  /** The only values the handler takes; anything else is the default. */
  allowed?: readonly string[];
};

/**
 * room -> action -> argument -> the default its handler uses. A value that
 * is missing (undefined or null), not a string when the default is one, or
 * outside `allowed`, becomes the default.
 */
export const ROOM_ACTION_DEFAULTS: Record<string, Record<string, Record<string, ArgDefault>>> = {
  settings: {
    // "all" resets setup, the tutorial and the user profile.
    replay_onboarding: { scope: { value: 'all', allowed: ONBOARDING_RESET_SCOPES } },
  },
  workspaces: { create_project: { template: { value: 'vite-react' } } },
  goals: { create_goal: { level: { value: 'task' } } },
  // No agent unassigns the task.
  tasks: { reassign: { agent: { value: null } } },
};

const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

function defaultsFor(room: string, action: string): Record<string, ArgDefault> | null {
  if (!own(ROOM_ACTION_DEFAULTS, room)) return null;
  const actions = ROOM_ACTION_DEFAULTS[room]!;
  return own(actions, action) ? actions[action]! : null;
}

/**
 * `args` with every default `room`'s handler would supply for `action` filled
 * in. The handler calls this for its own defaults, and the daemon calls it
 * before it shows the card, so the two cannot differ.
 */
export function withRoomActionDefaults(room: string, action: string, args: Record<string, unknown>): Record<string, unknown> {
  const defaults = defaultsFor(room, action);
  if (!defaults) return args;
  const out: Record<string, unknown> = { ...args };
  for (const [name, d] of Object.entries(defaults)) {
    const v = out[name];
    const missing = v === undefined || v === null;
    const wrongType = typeof d.value === 'string' && typeof v !== 'string';
    const notAllowed = d.allowed !== undefined && !(typeof v === 'string' && d.allowed.includes(v));
    if (missing || wrongType || notAllowed) out[name] = d.value;
  }
  return out;
}

/** set_default_model's `ref`, else `provider:model`, as its handler picks. */
function collapseModelRef(args: Record<string, unknown>): Record<string, unknown> {
  const { ref, provider, model, ...rest } = args;
  const runs = ref ? String(ref) : provider && model ? `${String(provider)}:${String(model)}` : undefined;
  return runs === undefined ? rest : { ...rest, ref: runs };
}

/**
 * room -> action -> how arguments that say the same thing collapse into the
 * one its handler runs. The settings handler takes `ref` over
 * `provider`+`model`, and `provider` over `name`; a card that showed all of
 * them would let the one it ignores pass for what is approved (#1008). The
 * daemon applies this to a held action before its card, and sends the result,
 * so the handler only ever sees the one.
 */
export const ROOM_ACTION_ALIASES: Record<string, Record<string, (args: Record<string, unknown>) => Record<string, unknown>>> = {
  settings: {
    set_default_model: collapseModelRef,
    set_model: collapseModelRef,
    test_provider: ({ provider, name, ...rest }) => {
      const runs = provider ?? name;
      return runs === undefined || runs === null ? rest : { ...rest, provider: runs };
    },
  },
};

/** `args` with any arguments that alias one another collapsed (#1008). */
export function collapseRoomActionAliases(room: string, action: string, args: Record<string, unknown>): Record<string, unknown> {
  if (!own(ROOM_ACTION_ALIASES, room)) return args;
  const actions = ROOM_ACTION_ALIASES[room]!;
  return own(actions, action) ? actions[action]!(args) : args;
}

/** What an argument's value may be: a JSON scalar of one of these types. */
export type RoomActionArgType = 'string' | 'number' | 'boolean';

const S = ['string'] as const;
const N = ['number'] as const;
const B = ['boolean'] as const;
/** The item a picking action acts on (pickRoomActionTarget reads both). */
const PICK = { id: S, name: S } as const;

/**
 * room -> action -> every argument its handler reads, and the types of value
 * it takes for each (#1021). The classifier writes whatever keys it likes,
 * and a held action's card printed them all, so a key no handler reads (text
 * the classifier picked up from what it was shown, or a `duration` the
 * calendar never stored) sat on the card as part of what the person approved.
 * roomActionArgs keeps only what is listed here, and the card shows what is
 * left.
 *
 * A type is what the handler uses: one that checks `typeof args.x ===
 * "string"` lists only "string", since any other value is the argument left
 * out. Objects and arrays are never kept: no handler reads one. Only those
 * `typeof` checks are held to the handlers; a type for an argument read
 * through String(), Number() or a cast is set here by hand.
 *
 * room-actions.test.ts reads every handler case with the TypeScript parser
 * and holds this table to the arguments it reads in both directions,
 * including those read through pickRoomActionTarget (id, name) and
 * withRoomActionDefaults (the action's defaults, and whatever is read off
 * what it returns). The arguments the daemon pins into a held action (an
 * item's id; the memory entity, #1023) are arguments the handler reads, so
 * they are listed too.
 */
export const ROOM_ACTION_ARGS: Record<string, Record<string, Record<string, readonly RoomActionArgType[]>>> = {
  settings: {
    switch_tab: { tab: S },
    read_status: {},
    set_default_model: { ref: S, provider: S, model: S },
    set_model: { ref: S, provider: S, model: S },
    test_provider: { provider: S, name: S },
    enable_telegram: {},
    disable_telegram: {},
    enable_discord: {},
    disable_discord: {},
    set_stt_provider: { provider: S },
    enable_tts: {},
    disable_tts: {},
    set_tts_provider: { provider: S },
    set_tts_voice: { voice: S },
    // Number(args.minutes): "30" and 30 are the same to it.
    set_heartbeat_interval: { minutes: ['number', 'string'] },
    set_heartbeat_aggressiveness: { level: S },
    restart_daemon: {},
    replay_onboarding: { scope: S },
  },
  agents: {
    switch_tab: { tab: S },
    open_spawn_dialog: {},
    close_dialog: {},
    set_search: { query: S },
    spawn_agent: { specialist: S, task: S, context: S },
  },
  authority: { switch_tab: { tab: S }, set_filter: { decision: S } },
  memory: {
    switch_tab: { tab: S },
    search: { query: S },
    set_filter: { type: S },
    select: { name: S },
    // `id` or `new_entity` is the entity the daemon settled on (#1023).
    remember_that: { subject: S, predicate: S, object: S, id: S, new_entity: B },
  },
  goals: {
    switch_tab: { tab: S },
    search: { query: S },
    set_filter: { field: S, value: S },
    select: { name: S },
    create_goal: { title: S, level: S, deadline: N },
  },
  tasks: {
    switch_view: { view: S },
    search: { query: S },
    set_filter: { field: S, value: S },
    select: { name: S },
    create_task: { title: S, when: S, priority: S, assigned_to: S },
    complete_task: PICK,
    update_priority: { ...PICK, level: S },
    reassign: { ...PICK, agent: S },
  },
  workspaces: {
    switch_view: { view: S },
    search: { query: S },
    select_project: PICK,
    back_to_list: {},
    create_project: { name: S, template: S },
    start_server: PICK,
    stop_server: PICK,
  },
  content: {
    switch_view: { view: S },
    search: { query: S },
    set_filter: { field: S, value: S },
    select: { name: S },
    create_content: { title: S, type: S },
    advance: PICK,
    regress: PICK,
    schedule: { ...PICK, when: S },
  },
  tools: { set_filter: { filter: S }, search: { query: S }, select: { name: S } },
  logs: { toggle_source: { source: S }, set_time_window: { window: S }, toggle_live_tail: {}, refresh: {} },
  calendar: {
    switch_view: { view: S },
    search: { query: S },
    select_event: { title: S },
    schedule_event: { title: S, when: S, priority: S, with: S },
  },
  workflows: { create_from_nl: { prompt: S } },
};

function argsFor(room: string, action: string): Record<string, readonly RoomActionArgType[]> | null {
  if (!own(ROOM_ACTION_ARGS, room)) return null;
  const actions = ROOM_ACTION_ARGS[room]!;
  return own(actions, action) ? actions[action]! : null;
}

/**
 * `args` with only the arguments `room`'s handler reads for `action`, each of
 * a type it takes (#1021). Anything else is dropped, so it is neither shown
 * on a card nor sent: a key the table does not list, a value of another
 * type, an object or an array, and every argument of an action no handler
 * carries out.
 */
export function roomActionArgs(room: string, action: string, args: Record<string, unknown> | undefined): Record<string, unknown> {
  const spec = argsFor(room, action);
  const out: Record<string, unknown> = {};
  if (!spec || !args || typeof args !== 'object') return out;
  for (const [name, types] of Object.entries(spec)) {
    if (!own(args, name)) continue;
    const v = args[name];
    if ((types as readonly string[]).includes(typeof v) && !(typeof v === 'number' && !Number.isFinite(v))) out[name] = v;
  }
  return out;
}

export type RoomActionTargetKind = 'project' | 'content' | 'task';

/**
 * room -> action -> what kind of item it acts on, for every side-effecting
 * action that picks an existing item by name (or by the selection).
 */
export const ROOM_ACTION_TARGETS: Record<string, Record<string, RoomActionTargetKind>> = {
  workspaces: { select_project: 'project', start_server: 'project', stop_server: 'project' },
  content: { advance: 'content', regress: 'content', schedule: 'content' },
  tasks: { complete_task: 'task', update_priority: 'task', reassign: 'task' },
};

/** The kind of item `room`'s `action` acts on, or null when it picks none. */
export function roomActionTargetKind(room: string, action: string): RoomActionTargetKind | null {
  if (!own(ROOM_ACTION_TARGETS, room)) return null;
  const actions = ROOM_ACTION_TARGETS[room]!;
  return own(actions, action) ? actions[action]! : null;
}

/**
 * The item a room action acts on, as its handler finds it. A pinned `id` is
 * the item with that id or nothing: it was resolved and shown before the
 * person approved, so a missing item must not become another one. Otherwise
 * the item `name` matches, and only with no name at all, the selection.
 */
export function pickRoomActionTarget<T extends { id: string }>(
  items: readonly T[],
  args: Record<string, unknown>,
  byName: (name: string) => T | null,
  selection: T | null = null,
): T | null {
  if (typeof args.id === 'string' && args.id) return items.find((i) => i.id === args.id) ?? null;
  // Any name given, even a blank one, is matched (and a blank one matches
  // nothing): only a name left out falls to the selection.
  if (typeof args.name === 'string' && args.name !== '') {
    const name = args.name.trim();
    return name ? byName(name) : null;
  }
  return selection;
}

/**
 * The project `name` means: an exact match once case and punctuation are
 * set aside, then one name containing the other, then the best token
 * overlap. The Workspaces room and the daemon both match with this.
 */
export function matchProjectByName<T extends { name: string }>(projects: readonly T[], name: string): T | null {
  const q = name.trim().toLowerCase();
  if (!q) return null;
  // Normalize both sides: lowercase, replace any non-alphanumeric run
  // (dash, underscore, apostrophe, space, period) with a single space,
  // collapse, trim. Lets "jarvis landing" find "jarvis-landing" and
  // "jarv's landing" find the same.
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const qNorm = norm(q);
  if (!qNorm) return null;
  const qTokens = qNorm.split(' ').filter(Boolean);

  // 1. exact normalized match
  const exact = projects.find((p) => norm(p.name) === qNorm);
  if (exact) return exact;

  // 2. substring either direction (handles partials like "landing"
  //    matching "jarvis-landing" and full query matching a longer name)
  const sub = projects.find((p) => {
    const n = norm(p.name);
    return n.includes(qNorm) || qNorm.includes(n);
  });
  if (sub) return sub;

  // 3. token overlap: pick the project whose tokens cover the most query
  //    tokens (each query token must appear as a prefix of some project
  //    token). Threshold: at least one token matches AND at least half the
  //    query tokens match.
  let best: { project: T; score: number } | null = null;
  for (const p of projects) {
    const nTokens = norm(p.name).split(' ').filter(Boolean);
    let hits = 0;
    for (const qt of qTokens) {
      if (nTokens.some((nt) => nt.startsWith(qt) || qt.startsWith(nt))) hits++;
    }
    if (hits > 0 && hits / qTokens.length >= 0.5) {
      if (!best || hits > best.score) best = { project: p, score: hits };
    }
  }
  return best?.project ?? null;
}

/**
 * The item whose title `name` means: an exact match ignoring case, else the
 * first title containing it. The Content and Tasks rooms and the daemon all
 * match with this.
 */
export function matchByTitle<T>(items: readonly T[], titleOf: (item: T) => string, name: string): T | null {
  const q = name.trim().toLowerCase();
  if (!q) return null;
  const exact = items.find((i) => titleOf(i).toLowerCase() === q);
  if (exact) return exact;
  return items.find((i) => titleOf(i).toLowerCase().includes(q)) ?? null;
}

/**
 * room -> action -> the argument naming the memory entity it attaches to
 * (#1023). remember_that found its subject inside the Memory room's data
 * hook after the yes: by a substring of whatever the room had loaded (so "me"
 * found "James"), and with nothing loaded yet it made a duplicate. The card
 * showed the fact and not where it would land.
 *
 * So the daemon settles the entity before the card, as it does an item: it
 * pins the existing entity by `id` with its full name in the argument, or
 * marks `new_entity: true` when none has the name, and the card says which.
 * The hook takes either as given (useMemoryData.rememberThat) and never
 * looks the name up again.
 */
export const ROOM_ACTION_ENTITY_TARGETS: Record<string, Record<string, string>> = {
  memory: { remember_that: 'subject' },
};

/**
 * `args` without the entity pin (`id`, `new_entity`) for an entity action,
 * else as they are (#1023 review). Only the daemon's settling of a held
 * action sets the pin; an action that was not settled (the classifier's own
 * reading, the realtime model's call) is matched by name in the room, so a
 * pin it carries would be one nobody checked.
 */
export function withoutEntityPin(room: string, action: string, args: Record<string, unknown>): Record<string, unknown> {
  if (roomActionEntityArg(room, action) === null || !(own(args, 'id') || own(args, 'new_entity'))) return args;
  const { id: _id, new_entity: _new, ...rest } = args;
  return rest;
}

/** The argument naming the entity `room`'s `action` attaches to, or null. */
export function roomActionEntityArg(room: string, action: string): string | null {
  if (!own(ROOM_ACTION_ENTITY_TARGETS, room)) return null;
  const actions = ROOM_ACTION_ENTITY_TARGETS[room]!;
  return own(actions, action) ? actions[action]! : null;
}

/**
 * The entity `name` means (#1023): one whose name is it, ignoring case;
 * failing that, one whose name holds it as whole words ("alice" finds "Alice
 * Smith"; "me" does not find "James"). Two or more at the first step that
 * finds any is `ambiguous`, as the card could not say which; none is null.
 * The daemon and the Memory room both match with this.
 */
export function matchEntityByName<T extends { name: string }>(
  entities: readonly T[],
  name: string,
): { entity: T } | { ambiguous: number } | null {
  // NFC, so a name typed with combining accents is the one stored precomposed.
  const fold = (s: string) => s.normalize('NFC').trim().toLowerCase();
  const q = fold(name);
  if (!q) return null;
  const one = (found: T[]) => (found.length === 1 ? { entity: found[0]! } : found.length > 1 ? { ambiguous: found.length } : null);
  const exact = one(entities.filter((e) => fold(e.name) === q));
  if (exact) return exact;
  const words = (s: string) => ` ${fold(s).replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim()} `;
  const qWords = words(q);
  if (qWords.trim() === '') return null;
  return one(entities.filter((e) => words(e.name).includes(qWords)));
}
