/**
 * What a workflow card for a reviewed browser or desktop action says (#1314).
 *
 * Before, the card named the tool and, for a browser call, an origin and an
 * element: the text a type would enter, the app a launch would open, the key a
 * press would send and the computer any of them would act on were never
 * shown, although trigger data can supply every one of them. Now the card
 * carries every frozen argument, the computer the call is pinned to, and what
 * the page or window was when the card was raised.
 *
 * Each value is one line of JSON with every character a card cannot show as
 * written escaped, so the card holds exactly what runs: nothing dropped,
 * collapsed or cut, and no value can close its own quotes and continue the
 * sentence. A value from run data is marked so. A value the card would have
 * to cut is refused, typed and before any card exists (#1040): never approved
 * unseen. The page, the element and the window are display only, never a
 * binding: the live guard is what holds the call to the screen.
 */
import { canonicalJson } from './effect-context';
import { forCard } from '../../util/card-text';
import type { WorkflowEffect } from '../db/repos/workflow-effect';

/** The longest one value may be on a card, as rendered. */
export const UI_CARD_VALUE_MAX_CHARS = 600;
/** The most values one card lists; the Brief shows every one of them. */
export const UI_CARD_MAX_VALUES = 20;
/** The longest card sentence: the Brief title holds 1000 and delivery 1024. */
export const UI_CARD_MAX_CHARS = 1000;

const HIDDEN = /[\p{Cf}\p{Default_Ignorable_Code_Point}\x7f-\x9f]|[^\S ]/gu;
const escapeUnits = (character: string) => [...Array(character.length).keys()]
  .map((i) => `\\u${character.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0')}`).join('');

/** A value as a card shows it: one line of JSON, every unshowable character escaped. */
export function cardValue(value: unknown): string {
  return (canonicalJson(value) ?? 'null').replace(HIDDEN, escapeUnits);
}

export type UiCardValue = { name: string; value: string; source: 'workflow' | 'run_data' | 'agent' };
/** The structured card the Brief renders; the sentence carries the same. */
export type UiCard = {
  tool: string; computer: string; values: UiCardValue[];
  /** Keys the tool does not declare: the card refuses them, never shows them as names. */
  undeclared?: string[];
  page?: string; element?: string; window?: string;
};

const VERBS: Record<string, string> = {
  browser_navigate: 'open a web page', browser_click: 'click in the browser', browser_type: 'type into the browser',
  browser_press_key: 'press a key in the browser', browser_hover: 'hover in the browser', browser_scroll: 'scroll the browser page',
  desktop_launch_app: 'open an app', desktop_focus_window: 'bring a window to the front', desktop_click: 'act on an app control',
};
const SOURCE_NOTE: Record<UiCardValue['source'], string> = { workflow: '', run_data: ' (from run data)', agent: ' (chosen by the agent)' };

/**
 * The card for one call. `source` says where a value came from: a direct
 * step's templated params are run data, everything a delegated agent sends is
 * the agent's. `target` is the computer, shown on its own.
 */
export function workflowUiCard(tool: string, args: Record<string, unknown>, opts: {
  computer: string; source: (name: string) => UiCardValue['source'];
  page?: string; element?: string; window?: string;
  /** The tool's declared parameter names; any other key is refused (`uiCardRefusal`). */
  declared?: readonly string[];
}): UiCard {
  const values = Object.keys(args).filter((name) => name !== 'target').sort()
    .map((name) => ({ name, value: cardValue(args[name]), source: opts.source(name) }));
  // Screen text is display only and cut to a line; the values above never are.
  const shown = (text: string | undefined) => text ? forCard(text, 160) || undefined : undefined;
  const page = shown(opts.page), element = shown(opts.element), window = shown(opts.window);
  const undeclared = opts.declared ? Object.keys(args).filter(name => name !== 'target' && !opts.declared!.includes(name)) : [];
  return { tool, computer: opts.computer, values, ...(undeclared.length ? { undeclared } : {}),
    ...(page ? { page } : {}), ...(element ? { element } : {}), ...(window ? { window } : {}) };
}

/**
 * The card as one sentence: the computer first (Jarvis knows it), then the
 * page, window and element (what the screen said, each one quoted), and the
 * values last, each one escaped and marked by where it came from.
 */
export function uiCardSentence(card: UiCard): string {
  const parts = [`On ${cardValue(card.computer)}: ${VERBS[card.tool] ?? card.tool} (${card.tool})`];
  if (card.page) parts.push(`page ${cardValue(card.page)}`);
  if (card.window) parts.push(`window ${cardValue(card.window)}`);
  if (card.element) parts.push(`element ${cardValue(card.element)}`);
  const values = card.values.map((v) => `${v.name}=${v.value}${SOURCE_NOTE[v.source]}`);
  return `${parts.join('; ')}${values.length ? `. Values: ${values.join(', ')}` : ''}. Check the current screen before approving.`;
}

/** Why this card cannot show the call as it would run, or null (#1040). */
export function uiCardRefusal(card: UiCard): string | null {
  // A key is a label the card shows as written, so it is one the tool declares (#1314 review).
  if (card.undeclared?.length || card.values.some(v => !/^[a-z][a-z0-9_]{0,63}$/.test(v.name))) {
    return `This call sends a parameter ${cardValue((card.undeclared ?? card.values.map(v => v.name))[0])} that ${card.tool} does not take, so no card is raised for it.`;
  }
  if (card.values.length > UI_CARD_MAX_VALUES) return `This call sends ${card.values.length} values; a card shows at most ${UI_CARD_MAX_VALUES}.`;
  const long = card.values.find((v) => v.value.length > UI_CARD_VALUE_MAX_CHARS);
  if (long) {
    return `The ${long.name} is ${long.value.length} characters as the approval card shows it; the limit is ${UI_CARD_VALUE_MAX_CHARS}, so the card can show all of it. Shorten it.`;
  }
  const sentence = uiCardSentence(card);
  if (sentence.length > UI_CARD_MAX_CHARS) {
    return `This action's card would be ${sentence.length} characters; the limit is ${UI_CARD_MAX_CHARS}, so the card can show all of it. Shorten its values.`;
  }
  return null;
}

type Snapshot = { window?: string; pid?: number; labels: Map<number, string> };

/** A desktop snapshot receipt, remote (the sidecar's JSON) or local (its text), or null. */
function parseDesktopSnapshot(result: unknown): Snapshot | null {
  if (typeof result !== 'string') return null;
  const labels = new Map<number, string>();
  try {
    const tree = JSON.parse(result) as Record<string, unknown>;
    if (!tree || typeof tree !== 'object') return null;
    const walk = (node: unknown, depth: number): void => {
      if (depth > 64 || labels.size > 5_000) return;
      if (Array.isArray(node)) { for (const item of node) walk(item, depth + 1); return; }
      if (!node || typeof node !== 'object') return;
      const el = node as Record<string, unknown>;
      if (typeof el.id === 'number' && typeof el.name === 'string' && el.name.trim()) labels.set(el.id, el.name);
      for (const value of Object.values(el)) if (value && typeof value === 'object') walk(value, depth + 1);
    };
    walk(tree.elements, 0);
    return { ...(typeof tree.window_title === 'string' ? { window: tree.window_title } : {}),
      ...(typeof tree.pid === 'number' ? { pid: tree.pid } : {}), labels };
  } catch { /* The host's text form: its names and values are written raw, so a window could forge a line. No labels from it. */ }
  return null;
}

/** Window titles by pid from a desktop_list_windows receipt, remote or local. */
function parseWindowList(result: unknown): Map<number, string> {
  const titles = new Map<number, string>();
  if (typeof result !== 'string') return titles;
  try {
    const parsed = JSON.parse(result) as unknown;
    const list = Array.isArray(parsed) ? parsed : (parsed as { windows?: unknown })?.windows;
    if (Array.isArray(list)) for (const w of list) {
      const win = w as Record<string, unknown>;
      if (typeof win?.pid === 'number' && typeof win.title === 'string') titles.set(win.pid, win.title);
    }
    return titles;
  } catch { /* the local text form */ }
  // The host's text form writes titles raw: a title could forge another line, so none are read from it.
  return titles;
}

/**
 * The window and element a desktop call names, as THIS RUN's latest desktop
 * read on the same computer reported them (#1314): display only, never a
 * binding, and never another run's or the chat's read. Unknown says so rather
 * than showing a bare number as if it named something.
 */
export function desktopSubjectFromRun(effects: readonly WorkflowEffect[], toolName: string,
  args: Record<string, unknown>): { window?: string; element?: string } {
  // A run is bound to one computer (machine-binding.ts), so every read in it is a read of that computer.
  const sameComputer = (e: WorkflowEffect) => e.status === 'succeeded';
  const newest = (name: string) => [...effects].reverse().find(e => e.toolName === name && sameComputer(e));
  if (toolName === 'desktop_click' && typeof args.element_id === 'number') {
    const snap = parseDesktopSnapshot(newest('desktop_snapshot')?.result);
    const label = snap?.labels.get(args.element_id);
    return { ...(snap?.window ? { window: snap.window } : {}),
      // Display only: anything else that reads this computer's screen renumbers its elements, so the label is what this run last saw.
      element: label ? `"${label}" [${args.element_id}] as this run's latest desktop snapshot named it` : `[${args.element_id}], not named in this run's latest desktop snapshot` };
  }
  if (toolName === 'desktop_focus_window' && typeof args.pid === 'number') {
    const title = parseWindowList(newest('desktop_list_windows')?.result).get(args.pid)
      ?? (() => { const snap = parseDesktopSnapshot(newest('desktop_snapshot')?.result); return snap?.pid === args.pid ? snap.window : undefined; })();
    return { window: title ? `${title} (pid ${args.pid})` : `pid ${args.pid}, not listed in this run's latest window list` };
  }
  return {};
}
