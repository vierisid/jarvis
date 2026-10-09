/**
 * The pebble's one-shot voice fast paths: deciding, from the transcript
 * alone, whether a turn is a command the daemon can carry out without the
 * model (#926).
 *
 * These run in `runResponseCycleTurn` BEFORE the model. A match here skips the
 * model entirely, so a pattern that is too loose does not merely route a turn
 * badly: it answers on the user's behalf. Two ways that went wrong:
 *
 *   - a WRONG ACTION. "change the background to blue" matched the background
 *     trigger and spawned a specialist on the task "to blue"; "turn off the
 *     voice memo app" turned JARVIS speech off;
 *   - a CANNED REFUSAL. "close that window" with no background agents running
 *     answered "There are no background agents running."; "open the settings
 *     page" with no panel open answered "There's no panel open to navigate
 *     inside." instead of opening Settings. To the user both read as "it
 *     cannot do that", and the model never saw the turn.
 *
 * ONE RULE, applied to every plan here: a fast path claims a turn only when
 * it is sure what the turn means. It is sure when the utterance names the
 * object of the command (a background agent, text-to-speech, a room by name),
 * or when the thing it would act on exists (an open panel, a running agent of
 * that colour). Otherwise the plan is `null` and the model gets the turn. A
 * spoken refusal is allowed only once the intent is certain, because then it
 * is the honest answer to what the user asked.
 *
 * NO IMPORTS. The room table lives here so the planners and the daemon
 * resolve the same names; the daemon passes in what is live (open panels,
 * running agents), so every decision can be tested without standing the
 * daemon up. The closures in `src/daemon/index.ts` only carry the plan out.
 */

/**
 * Words that may come before a command without making it part of a sentence:
 * a greeting, the wake word, "please", "can you". A command that changes
 * state has to OPEN the utterance after these, so "I don't use groq for
 * transcription" or "I never turn off text to speech" is not one.
 */
const LEAD_IN = '^\\s*(?:(?:hey|hi|ok(?:ay)?|so|and|now|please|jarvis|can you|could you)[,.!]?\\s+)*';

// ---------------------------------------------------------------------------
// Settings: text-to-speech on/off, transcription provider
// ---------------------------------------------------------------------------

export type SttTarget = 'openai' | 'groq' | 'sarvam' | 'local' | 'usejarvis';

export type SettingsIntent =
  | { kind: 'tts'; enabled: boolean }
  | { kind: 'stt'; target: SttTarget };

/**
 * What the TTS toggle may be aimed at. Each names speech OUTPUT explicitly.
 * A bare "voice" or "speech" counts only as the last word ("turn off the
 * voice"): followed by anything it is usually something else, and "turn off
 * the voice memo app" used to silence JARVIS.
 */
const TTS_OBJECT =
  '(?:text[- ]to[- ]speech|tts(?: responses?)?|voice (?:output|responses?|replies)|speech output|spoken (?:responses?|replies)' +
  '|(?:voice|speech)(?=\\s*(?:,?\\s*please)?\\s*[.!]?\\s*$))';

export function parseSettingsIntent(text: string): SettingsIntent | null {
  const t = text.toLowerCase();
  const ttsOff = new RegExp(`${LEAD_IN}(turn off|disable|switch off|deactivate)\\s+(?:the\\s+)?${TTS_OBJECT}\\b`).test(t);
  const ttsOn = new RegExp(`${LEAD_IN}(turn on|enable|switch on|activate|reactivate)\\s+(?:the\\s+)?${TTS_OBJECT}\\b`).test(t);
  if (ttsOff) return { kind: 'tts', enabled: false };
  if (ttsOn) return { kind: 'tts', enabled: true };

  const sttMatch =
    new RegExp(`${LEAD_IN}(switch|change)\\s+(?:the\\s+)?(stt|speech[- ]to[- ]text|transcription|speech recognition|listening)\\s+(?:to|provider to)\\s+(openai|whisper|groq|sarvam|local|usejarvis|use jarvis|jarvis)\\b`).exec(t) ||
    new RegExp(`${LEAD_IN}use\\s+(openai|whisper|groq|sarvam|local|usejarvis|use jarvis|jarvis)\\s+(?:for\\s+(?:stt|speech[- ]to[- ]text|transcription|speech recognition|listening|hearing))\\b`).exec(t);
  if (!sttMatch) return null;
  // 'whisper' -> openai; 'jarvis' / 'use jarvis' (how STT typically
  // transcribes the brand name) -> the hosted usejarvis provider.
  const canonical = (name: string): SttTarget =>
    (name === 'whisper' ? 'openai' : name === 'use jarvis' || name === 'jarvis' ? 'usejarvis' : name) as SttTarget;
  let target = canonical(sttMatch[2]!);
  // The first capture group depends on which alternative matched.
  const candidate = (sttMatch[3] || sttMatch[1]) as string;
  if (candidate && /^(openai|whisper|groq|sarvam|local|usejarvis|use jarvis|jarvis)$/.test(candidate)) {
    target = canonical(candidate);
  }
  return { kind: 'stt', target };
}

// ---------------------------------------------------------------------------
// Rooms: the panels voice can open, and the names they answer to
// ---------------------------------------------------------------------------

export type RoomMeta = { aliases: string[]; title: string; w: number; h: number; alwaysOnTop?: boolean };

export const PEBBLE_ROOMS: Record<string, RoomMeta> = {
  settings:    { aliases: ['settings', 'preferences'],                title: 'Settings',    w: 560, h: 600 },
  workflows:   { aliases: ['workflows', 'workflow', 'flows'],         title: 'Workflows',   w: 900, h: 600 },
  memory:      { aliases: ['memory', 'vault', 'knowledge'],           title: 'Memory',      w: 480, h: 700 },
  tools:       { aliases: ['tools', 'tool catalog', 'tool catalogue'],title: 'Tools',       w: 560, h: 600 },
  agents:      { aliases: ['agents', 'agent monitor'],                title: 'Agents',      w: 600, h: 600 },
  agent_strip: { aliases: ['agent strip', 'agents strip', 'agent panel', 'agent dock', 'background agents'], title: 'Agent Strip', w: 290, h: 440, alwaysOnTop: true },
  authority:   { aliases: ['authority', 'approvals', 'permissions'],  title: 'Authority',   w: 480, h: 600 },
  logs:        { aliases: ['logs', 'log stream', 'log'],              title: 'Logs',        w: 800, h: 500 },
  calendar:    { aliases: ['calendar', 'schedule'],                   title: 'Calendar',    w: 720, h: 600 },
  goals:       { aliases: ['goals', 'okrs', 'goal'],                  title: 'Goals',       w: 600, h: 600 },
  tasks:       { aliases: ['tasks', 'todos', 'task list', 'task'],    title: 'Tasks',       w: 500, h: 600 },
  content:     { aliases: ['content', 'content pipeline', 'notes'],   title: 'Content',     w: 800, h: 600 },
  workspaces:  { aliases: ['workspaces', 'workspace', 'sites'],       title: 'Workspaces',  w: 800, h: 600 },
  usage:       { aliases: ['token usage', 'usage room'],              title: 'Usage',       w: 800, h: 600 },
};

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Aliases longest first, so "tool catalog" wins over "tools". */
const ORDERED_ALIASES: { alias: string; key: string; re: RegExp }[] = Object.entries(PEBBLE_ROOMS)
  .flatMap(([key, meta]) => meta.aliases.map((alias) => ({ alias, key, re: new RegExp(`\\b${escapeRe(alias)}\\b`) })))
  .sort((a, b) => b.alias.length - a.alias.length);

/** The room whose alias appears anywhere in `text` (longest alias first); null for none. */
export function findRoomKey(text: string): string | null {
  for (const { key, re } of ORDERED_ALIASES) if (re.test(text)) return key;
  return null;
}

/** The room this phrase IS, exactly ("agent strip"); null for anything else. */
export function exactRoomKey(phrase: string): string | null {
  const p = phrase.toLowerCase().trim();
  return ORDERED_ALIASES.find((a) => a.alias === p)?.key ?? null;
}

// ---------------------------------------------------------------------------
// Panels: shared lookups
// ---------------------------------------------------------------------------

export type PanelRef = { id: string; key: string; title: string };

export type PanelLookups = {
  /** The open panel a hint names, or the most recent one when there is no hint. */
  findPanel: (hint?: string) => PanelRef | null;
  /**
   * The display title of the room this phrase IS ("workflows", "agent strip"),
   * open or not; null when it is anything else. Exact, not a search: "chrome
   * settings" and "settings to default" are not the Settings room.
   */
  roomTitle: (phrase: string) => string | null;
};

export type SayPlan = { kind: 'say'; text: string };

/**
 * A spoken room phrase reduced to what `roomTitle` compares: "the workflows
 * window" -> "workflows". Pronouns come back as undefined.
 */
function cleanRoomPhrase(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let p = raw.toLowerCase().trim().replace(/[\s,]*(?:please)?[\s.!?]*$/, '');
  p = p.replace(/^(?:the|my)\s+/, '').replace(/\s+(?:window|panel|page|view)$/, '').trim();
  if (!p || /^(?:it|that|this|window|panel)$/.test(p)) return undefined;
  return p;
}

/** "The Workflows window isn't open." when the phrase is a room; null otherwise. */
function missingRoom(room: string | undefined, lookups: PanelLookups): SayPlan | null {
  const title = room ? lookups.roomTitle(room) : null;
  return title ? { kind: 'say', text: `The ${title} window isn't open.` } : null;
}

// ---------------------------------------------------------------------------
// In-panel navigation: "switch to the editor tab"
// ---------------------------------------------------------------------------

/**
 * Recognized tab synonyms across the dashboard rooms. Match is STRICT -- a
 * captured tab name that is not here falls through to the model. Without it,
 * "open Gmail on a new Chrome tab window" parsed as `switch_tab` with
 * tab="gmail_on_a_new_chrome", because the pattern captures anything that
 * ends with "... tab".
 */
const TAB_SYNONYMS: Record<string, string> = {
  editor: 'editor',
  edit: 'editor',
  'edit view': 'editor',
  builder: 'builder',
  'agent builder': 'agent_builder',
  list: 'list',
  all: 'list',
  logs: 'logs',
  history: 'logs',
  settings: 'settings',
  general: 'general',
  tts: 'tts',
  stt: 'stt',
  voice: 'voice',
  llm: 'llm',
  tools: 'tools',
  channels: 'channels',
};

export type InPanelPlan =
  | { kind: 'switch_tab'; target: PanelRef; tab: string; tabRaw: string; roomHint?: string }
  | SayPlan;

export function planInPanelAction(text: string, lookups: PanelLookups): InPanelPlan | null {
  const t = text.toLowerCase();
  // Imperative only: "show me where the editor tab is" is a question for the
  // model (with pointer guidance), not a tab switch.
  if (/\b(where|how|when|which|why|what)\b.*\b(tab|view|section)\b/i.test(t)) return null;
  // The room hint ("... in the workflows window") is captured to the end and
  // must then be a room. It was a lazy capture with nothing after it, so it
  // only ever held one letter ("w") unless a "panel" or "page" suffix followed.
  const re = /\b(?:switch to|go to|jump to|open|click on|select)\s+(?:the\s+)?([a-z][a-z0-9 \-_]{0,30}?)\s+(?:tab|view|section|page)\b(?:\s+(?:in|of)\s+(?:the\s+)?([a-z][a-z ]{0,40}))?/i;
  const m = re.exec(t);
  if (!m) return null;

  const tabRaw = (m[1] || '').trim();
  const roomHint = cleanRoomPhrase(m[2]);
  if (!tabRaw) return null;
  // A room hint must be a room. "in the morning" and "in chrome settings" are not.
  if (m[2] && (!roomHint || !lookups.roomTitle(roomHint))) return null;

  // Decide it is a JARVIS tab command at all BEFORE looking for a panel, so
  // a sentence that is not one never gets a panel-shaped refusal. A real
  // browser/window/app in the sentence makes "tab" almost certainly the
  // browser-tab sense, not a JARVIS panel sub-tab. The room hint is left out
  // of that test, having just been checked to be a room.
  const outsideHint = m[2] ? t.slice(0, m.index + m[0].length - m[2].length) + t.slice(m.index + m[0].length) : t;
  if (/\b(chrome|firefox|edge|safari|browser|gmail|google|mail|youtube|github|window)\b/i.test(outsideHint)) return null;
  // A "tab" that is a room's own name is the room: "open the settings page"
  // means Settings. No room takes "settings", "tools" or "logs" as a tab, so
  // treating them as one switched nothing and said it had.
  if (lookups.roomTitle(tabRaw)) return null;
  const tab = TAB_SYNONYMS[tabRaw];
  if (!tab) return null;

  const target = lookups.findPanel(roomHint);
  if (target) return { kind: 'switch_tab', target, tab, tabRaw, roomHint };
  // Nothing to navigate. Only a room named outright earns an answer; without
  // one the turn goes on to the model.
  return missingRoom(roomHint, lookups);
}

// ---------------------------------------------------------------------------
// Window management: expand / minimize / restore / close / focus a panel
// ---------------------------------------------------------------------------

export type WindowAction = 'maximized' | 'minimized' | 'normal' | 'close' | 'focus';

/**
 * Words that may open a bare command without making it part of a sentence.
 * Narrower than LEAD_IN: "can you expand" asks to elaborate as often as to
 * maximize.
 */
const WINDOW_LEAD_IN = '^(?:(?:hey|ok(?:ay)?|jarvis|please|now)[,.!]?\\s+)*';
/** What may close an utterance after the command itself. */
const TAIL = '[\\s,]*(?:please)?[\\s.!?]*$';
const PRONOUN = '(?:it|that|this|(?:the|this|that) (?:window|panel))';

/**
 * Match a window-management command. `roomHint` is the object after the verb,
 * cleaned ("expand the workflows window" -> "workflows"); the planner checks
 * it is a room.
 *
 * The command has to END the utterance, and a verb with no object has to BE
 * the utterance. Unanchored, these verbs claimed ordinary sentences whenever a
 * panel was open: "can you expand on that", "i need to focus", "close that
 * tab", "shut it down", "restore my settings to default".
 */
export function parseWindowAction(text: string): { action: WindowAction; roomHint?: string } | null {
  const t = text.toLowerCase().trim();

  const verb = (verbs: string, fixed: string): { roomHint?: string } | null => {
    // "<verb> <object>" at the end: a pronoun or a room phrase.
    const withObject = new RegExp(`\\b(?:${verbs})\\s+((?:the\\s+|my\\s+)?[a-z][a-z ]{0,40}?)${TAIL}`).exec(t);
    if (withObject) {
      const raw = withObject[1]!.trim();
      if (new RegExp(`^${PRONOUN}$`).test(raw)) return {};
      const hint = cleanRoomPhrase(raw);
      return hint ? { roomHint: hint } : {};
    }
    // A bare verb, or a phrase that carries its own pronoun ("put it away").
    if (new RegExp(`${WINDOW_LEAD_IN}(?:${verbs})${TAIL}`).test(t)) return {};
    if (fixed && new RegExp(`\\b(?:${fixed})${TAIL}`).test(t)) return {};
    return null;
  };

  const maxRes = verb(
    'expand|maximi[sz]e|enlarge|go full ?screen|full ?screen',
    'blow it up|make (?:it|that|the window) (?:bigger|big|larger|huge|full ?screen)',
  );
  if (maxRes) return { ...maxRes, action: 'maximized' };

  const minRes = verb(
    'minimi[sz]e|hide',
    'put it away|tuck it away|send it to (?:the )?taskbar',
  );
  if (minRes) return { ...minRes, action: 'minimized' };

  const restoreRes = verb(
    'restore|shrink|un ?maximi[sz]e|normalize',
    'reset (?:the )?(?:window|size)|normal size|make (?:it|that|the window) (?:smaller|small|normal)',
  );
  if (restoreRes) return { ...restoreRes, action: 'normal' };

  // Close (deictic -- pronoun only). "close <room>" stays in the open/close
  // room path so its alias matcher drives the selection.
  if (new RegExp(`\\b(?:close|dismiss|shut|kill|get rid of)\\s+${PRONOUN}${TAIL}|\\bthrow it away${TAIL}`).test(t)) {
    return { action: 'close' };
  }

  const focusRes = verb(
    'focus|raise|surface',
    'bring it (?:back|forward|to the front)|show me the window|where did (?:it|the window) go',
  );
  if (focusRes) return { ...focusRes, action: 'focus' };

  return null;
}

export type WindowPlan =
  | { kind: 'window'; action: WindowAction; target: PanelRef; roomHint?: string }
  | SayPlan;

export function planWindowAction(text: string, lookups: PanelLookups): WindowPlan | null {
  const parsed = parseWindowAction(text);
  if (!parsed) return null;
  const { action, roomHint } = parsed;
  // An object that is not a room is not a window command: "expand on that",
  // "restore my faith in people".
  if (roomHint && !lookups.roomTitle(roomHint)) return null;
  const target = lookups.findPanel(roomHint);
  if (target) return { kind: 'window', action, target, roomHint };
  // No panel to act on. Only a room named outright earns an answer ("can you
  // expand on that" used to get "I don't see a on window open."); "expand it"
  // with nothing open is left to the model.
  return missingRoom(roomHint, lookups);
}

// ---------------------------------------------------------------------------
// Closing background agents (sub-pebbles)
// ---------------------------------------------------------------------------

export type SubPebbleCand = { id: string; slot: number; color: string; agentName: string };

export const SUB_PEBBLE_COLORS = ['amber', 'sage', 'violet', 'mustard', 'teal', 'vermilion'] as const;

/** Says outright that the object is a background agent. */
const NAMED_AGENT = '(?:background (?:agents?|tasks?)|sub.?agents?|sub.?pebbles?)';
/** What may follow a colour or specialist name to make it an agent. */
const AGENT_NOUN = `(?:${NAMED_AGENT}|one|agent)`;
/** Words in the name slot that pick an agent by position, not by name. */
const RESERVED_HINTS = new Set([
  'this', 'that', 'the', 'a', 'an', 'background', 'all', 'every', 'sub',
  'newest', 'latest', 'last', 'recent', 'current', 'running', 'other', 'first', 'oldest', 'old',
]);

export type SubPebbleClosePlan =
  | { kind: 'close_all'; count: number }
  | { kind: 'close_one'; cand: SubPebbleCand; label: string }
  | SayPlan;

/**
 * `cands` is null when the slot table is empty for this pebble, and the live
 * candidates otherwise (possibly none, when every slot's task is gone).
 */
export function planSubPebbleClose(text: string, cands: readonly SubPebbleCand[] | null): SubPebbleClosePlan | null {
  const t = text.toLowerCase().trim();
  if (!/\b(close|dismiss|kill|get rid of|cancel)\b/.test(t)) return null;

  // The object has to be a background agent: named as one, or by the colour
  // or specialist of one that is running. A bare "this"/"that" or "agents"
  // is not enough: "close that window", "cancel this order" and "close the
  // agents window" all used to land here, and with an agent running they
  // closed it. "background agents window" is the Agent Strip room, not one.
  const named = new RegExp(`\\b${NAMED_AGENT}\\b(?!\\s+(?:window|panel|strip|dock))`).test(t);
  const live = cands ?? [];

  if (named && /\b(all|every|everything)\b/.test(t) && live.length > 0) {
    return { kind: 'close_all', count: live.length };
  }

  // "close the amber one". A colour that is running is certain; a colour
  // that is not, said with an agent noun, is answered rather than taken for
  // "the newest".
  const colour = new RegExp(`\\b(${SUB_PEBBLE_COLORS.join('|')})\\s+${AGENT_NOUN}\\b`).exec(t);
  if (colour) {
    const match = live.find((c) => c.color === colour[1]);
    if (match) return { kind: 'close_one', cand: match, label: colour[1]! };
    return named ? { kind: 'say', text: `There's no ${colour[1]} background agent running.` } : null;
  }

  // "close the research one" -> "Research Analyst".
  const m = new RegExp(`\\b(?:close|dismiss|kill|get rid of|cancel) (?:the )?([a-z]+)\\s+${AGENT_NOUN}\\b`).exec(t);
  if (m && m[1] && !RESERVED_HINTS.has(m[1])) {
    const hint = m[1];
    const match = live.find((c) => c.agentName.toLowerCase().includes(hint));
    if (match) return { kind: 'close_one', cand: match, label: match.agentName.toLowerCase() };
    if (named) return { kind: 'say', text: `There's no ${hint} background agent running.` };
    return null;
  }

  if (!named) return null;
  // Asked for a background agent outright: now a refusal is the honest answer.
  if (cands === null) return { kind: 'say', text: 'There are no background agents running.' };
  if (cands.length === 0) return { kind: 'say', text: 'There are no background agents to close.' };
  const newest = cands.slice().sort((a, b) => b.slot - a.slot)[0]!;
  return { kind: 'close_one', cand: newest, label: 'most recent' };
}

// ---------------------------------------------------------------------------
// Starting a background agent: "in the background, research X"
// ---------------------------------------------------------------------------

/**
 * The task a background command hands to a specialist, or null when the turn
 * is not one.
 *
 * The trigger must OPEN the utterance. It used to match anywhere, so
 * "change the background to blue" spawned a specialist on "to blue", and any
 * sentence with "background" in it started an agent on whatever followed. A
 * phrase also needs its punctuation ("In the background, X", "Background: X"):
 * "background noise is loud", "in the background music keeps playing" and
 * "in the background of this photo, what is that car" are not commands. The
 * cost is that an unpunctuated "in the background research X" goes to the
 * model, which can still start an agent through its own, gated, tool.
 */
export function parseBackgroundTask(text: string): string | null {
  const re = new RegExp(
    LEAD_IN +
      '(?:in the background[,:]\\s*|background[,:]\\s*|(?:spawn|start|launch) (?:a |an )?background\\s+(?:agent|task)\\s+(?:to\\s+|that\\s+)?)(.+)',
    'i',
  );
  const m = re.exec(text);
  if (!m) return null;
  const task = (m[1] ?? '').trim();
  return task.length < 3 ? null : task;
}
