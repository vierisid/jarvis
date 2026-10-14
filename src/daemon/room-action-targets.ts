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
 *    never by a direct find, findBy*, matcher or the selection.
 * It reads each case's own code. A default or lookup inside a data hook the
 * case calls (useMemoryData's rememberThat finds its subject itself) is not
 * seen, so remember_that is not covered here.
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
