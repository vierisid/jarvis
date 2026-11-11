/**
 * A workflow described as a job Jarvis does, in plain English.
 *
 * Built from the step graph alone (no model call), so the same graph always
 * reads the same. The trigger comes first, then the steps in order as short
 * phrases from each step's display name and piece/action. Routers read as
 * "if ... otherwise ...", loops as "for each ...". Unknown pieces fall back to
 * their display name, then to a humanized piece name, so nothing is ever blank.
 */

import { forCard } from "../../../../../src/util/card-text";
import { describeSchedule, isScheduleSettings } from "./schedule-words";
import { detectTriggerKind } from "./trigger-kinds";
import type { FlowStepNode, PieceCatalogEntry } from "./useWorkflowEditor";

export interface WorkflowSummary {
  /** The trigger in words, for example "Every weekday at 9:00 (Europe/Rome)". */
  trigger: string;
  /** Top-level steps shown in the sentence, in order. */
  steps: string[];
  /** Top-level steps left out to keep the sentence short. */
  hiddenSteps: number;
  /** The whole sentence, ready to show. */
  text: string;
}

/** Longest sentence the summary shows before it stops listing steps. */
export const SUMMARY_MAX_CHARS = 280;
const PHRASE_MAX_CHARS = 160;
const DISPLAY_NAME_MAX_CHARS = 70;
const NOTIFY_PIECE = "@jarvispieces/piece-jarvis-notify";

/** "@jarvispieces/piece-jarvis-notify" becomes "jarvis notify"; "@activepieces/piece-slack" becomes "slack". */
export function humanizePieceName(pieceName: string): string {
  const bare = pieceName.replace(/^@[^/]+\//, "").replace(/^piece-/, "");
  return bare.replace(/[-_.]+/g, " ").trim() || "a step";
}

function humanizeId(id: string): string {
  return id.replace(/[._:-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim().toLowerCase();
}

/**
 * Make a display name read mid-sentence: "Send Email" becomes "send email". A name that is not
 * Title Case ("Send message to Slack") only loses its first capital, and a name like "GitHub" or
 * "AI" is kept as written.
 */
function lowerFirst(text: string): string {
  const words = text.split(/\s+/);
  const plain = (w: string): boolean => /^[A-Z][a-z]*$/.test(w);
  const titleCase = words.length > 1 && words.filter((w) => w.length > 3).every(plain);
  return words.map((w, i) => (plain(w) && (i === 0 || titleCase) ? w.toLowerCase() : w)).join(" ");
}

function shorten(text: string, max = PHRASE_MAX_CHARS): string {
  return text.length <= max ? text : `${text.slice(0, max - 3).trimEnd()}...`;
}

/**
 * One line of text a person or a model wrote (a step name, a branch value).
 * Invisible and control characters go, as on an approval card: a bidi override
 * in one step name would otherwise reorder the rest of the sentence.
 */
function oneLine(text: string): string {
  return forCard(text, Number.POSITIVE_INFINITY);
}

/** The first name a template refers to: "{{step_1.items}}" gives "step_1". */
function firstReference(template: unknown): string | null {
  if (typeof template !== "string") return null;
  const match = /\{\{\s*([A-Za-z_][\w-]*)/.exec(template);
  return match ? match[1]! : null;
}

/** "{{step_1.score}}" reads as "score"; plain text is kept. */
function plainValue(value: unknown): string {
  const text = oneLine(String(value ?? ""));
  return text.replace(/\{\{\s*([^}]*?)\s*\}\}/g, (_all, expr: string) => {
    const last = expr.split(/[.\[\]'"]+/).filter(Boolean).pop() ?? expr;
    return humanizeId(last);
  });
}

function operatorWords(operator: string): string {
  const parts = operator.toLowerCase().split("_");
  if (["text", "number", "boolean", "date", "list"].includes(parts[0]!) && parts.length > 1) parts.shift();
  return parts.join(" ");
}

interface Condition { firstValue: string; operator: string; secondValue?: string }

function conditionWords(branch: { conditions?: Condition[][] }): string {
  const first = branch.conditions?.[0]?.[0];
  if (!first || !first.firstValue) return "";
  const rest = branch.conditions?.length && (branch.conditions.length > 1 || branch.conditions[0]!.length > 1) ? " and more" : "";
  return shorten(oneLine(`${plainValue(first.firstValue)} ${operatorWords(first.operator)} ${plainValue(first.secondValue ?? "")}`)) + rest;
}

class Summarizer {
  private readonly byName = new Map<string, FlowStepNode>();

  constructor(trigger: FlowStepNode, private readonly catalog: PieceCatalogEntry[]) {
    const visit = (node: FlowStepNode | null | undefined): void => {
      for (let cursor = node ?? undefined; cursor; cursor = cursor.nextAction) {
        this.byName.set(cursor.name, cursor);
        visit(cursor.firstLoopAction);
        for (const child of cursor.children ?? []) visit(child);
      }
    };
    visit(trigger);
  }

  private piece(step: FlowStepNode): PieceCatalogEntry | undefined {
    return this.catalog.find((p) => p.name === step.settings?.pieceName);
  }

  trigger(step: FlowStepNode): string {
    const kind = detectTriggerKind(step);
    if (kind === "manual") return "When you run it";
    if (kind === "schedule" || isScheduleSettings(step.settings)) return describeSchedule(step.settings);
    if (kind === "webhook") return "When a webhook receives data";
    if (kind === "event") {
      const eventType = step.settings?.input?.["eventType"];
      return typeof eventType === "string" && eventType ? `When a ${humanizeId(eventType)} event happens` : "When a Jarvis event happens";
    }
    const piece = this.piece(step);
    const what = piece?.triggers.find((t) => t.name === step.settings?.triggerName)?.displayName;
    const pieceLabel = piece?.displayName ?? (step.settings?.pieceName ? humanizePieceName(step.settings.pieceName) : "");
    if (what && pieceLabel) return `When ${lowerFirst(oneLine(what))} in ${pieceLabel}`;
    return pieceLabel ? `When something happens in ${pieceLabel}` : "When something outside Jarvis starts it";
  }

  private notifyPhrase(step: FlowStepNode): string {
    const raw = step.settings?.input?.["channels"];
    const channels = (Array.isArray(raw) ? raw : []).filter((c): c is string => typeof c === "string" && c !== "auto");
    if (!channels.length) return "notify you";
    const label = (c: string): string => (c === "dashboard" ? "the dashboard" : c === "desktop" ? "your desktop" : c === "voice" ? "voice" : c.charAt(0).toUpperCase() + c.slice(1));
    return `notify you on ${joinList(channels.map(label))}`;
  }

  private stepPhrase(step: FlowStepNode): string {
    switch (step.type) {
      case "CODE":
        return this.named(step) ?? "run custom code";
      case "LOOP_ON_ITEMS":
        return this.loop(step);
      case "ROUTER":
        return this.router(step);
      default:
        break;
    }
    if (step.settings?.pieceName === NOTIFY_PIECE && step.settings.actionName === "notify") return this.notifyPhrase(step);
    const named = this.named(step);
    if (named) return named;
    const piece = this.piece(step);
    const action = piece?.actions.find((a) => a.name === step.settings?.actionName)?.displayName;
    if (action) return lowerFirst(oneLine(action));
    if (piece) return `use ${piece.displayName}`;
    return step.settings?.pieceName ? `use ${humanizePieceName(step.settings.pieceName)}` : "do a step that is not set up yet";
  }

  /** What the person called the step, when that is short enough to read as a phrase. */
  private named(step: FlowStepNode): string | null {
    const name = oneLine(step.displayName ?? "");
    if (!name || name.length > DISPLAY_NAME_MAX_CHARS || /[;:]/.test(name) || name === step.name) return null;
    return lowerFirst(name);
  }

  private loop(step: FlowStepNode): string {
    const ref = firstReference(step.settings?.items);
    const source = ref ? this.byName.get(ref) : undefined;
    const from = source && source.type !== "PIECE_TRIGGER" && source.type !== "EMPTY" ? ` from the result of ${shorten(this.stepPhrase(source), 40)}` : "";
    const body = this.chain(step.firstLoopAction, " and then ");
    return shorten(`for each item${from}${body ? `, ${body}` : ""}`);
  }

  private router(step: FlowStepNode): string {
    const branches = step.settings?.branches ?? [];
    const parts: string[] = [];
    let sawIf = false;
    branches.forEach((branch, index) => {
      const body = this.chain(step.children?.[index] ?? undefined, " and then ") || "do nothing";
      if (branch.branchType === "FALLBACK") {
        parts.push(`otherwise ${body}`);
        return;
      }
      const label = branch.branchName && !/^(true|false|branch[_ ]?\d*)$/i.test(branch.branchName) ? plainValue(branch.branchName) : "";
      const when = conditionWords(branch) || label || "it matches";
      parts.push(`${sawIf ? "else if" : "if"} ${when}, ${body}`);
      sawIf = true;
    });
    // A strict "If" has no explicit fallback: its False branch is the otherwise.
    if (!parts.length) return "decide what to do next";
    return shorten(parts.join("; "), PHRASE_MAX_CHARS * 2);
  }

  /** The phrases of a chain joined in order; empty for no steps. */
  chain(start: FlowStepNode | undefined, joiner: string): string {
    return this.phrases(start).join(joiner);
  }

  phrases(start: FlowStepNode | undefined): string[] {
    const out: string[] = [];
    for (let cursor = start; cursor; cursor = cursor.nextAction) out.push(shorten(this.stepPhrase(cursor)));
    return out;
  }
}

function joinList(items: string[]): string {
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** Describe the workflow from its trigger tree. Pure: no request, no clock, no model. */
export function summarizeWorkflow(trigger: FlowStepNode, catalog: PieceCatalogEntry[] = []): WorkflowSummary {
  const summarizer = new Summarizer(trigger, catalog);
  const triggerText = summarizer.trigger(trigger);
  const all = summarizer.phrases(trigger.nextAction);
  const steps: string[] = [];
  let length = triggerText.length;
  for (const phrase of all) {
    if (steps.length && length + phrase.length + 7 > SUMMARY_MAX_CHARS) break;
    steps.push(phrase);
    length += phrase.length + 7;
  }
  const hiddenSteps = all.length - steps.length;
  // The trigger and piece names come from the graph too: clean the whole sentence once more.
  const clean = (text: string): string => forCard(text, Number.POSITIVE_INFINITY);
  const more = hiddenSteps ? [`${hiddenSteps} more ${hiddenSteps === 1 ? "step" : "steps"}`] : [];
  const sentence = [triggerText, ...steps.map((s) => `then ${s}`), ...more.map((m) => `and ${m}`)].join(", ");
  return {
    trigger: clean(triggerText),
    steps: steps.map(clean),
    hiddenSteps,
    text: clean(steps.length || more.length ? `${sentence}.` : `${triggerText}, then nothing else yet.`),
  };
}
