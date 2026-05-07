/**
 * NL workflow composer. Builds a draft flow from a plain-English description
 * by prompting the configured Jarvis LLM with the piece catalog + a schema
 * the response must conform to.
 *
 * The composer never edits live state on its own; it returns a parsed +
 * validated trigger tree that the caller (the manage_workflow tool) writes
 * via the existing flow / flow_version repos.
 */

import type {
  JarvisPiece,
  JarvisPieceRegistry,
  PieceInputField,
  PieceInputSchema,
  PieceLlmClient,
} from "../../workflows/jarvis-pieces/types.ts";

export interface ComposedFlow {
  displayName: string;
  trigger: ComposedStep;
}

export interface ComposedStep {
  name: string;
  type: "EMPTY" | "PIECE_TRIGGER" | "PIECE";
  displayName?: string;
  settings?: {
    pieceName?: string;
    triggerName?: string;
    actionName?: string;
    input?: Record<string, unknown>;
  };
  nextAction?: ComposedStep;
}

export interface ComposeRequest {
  /** Display name for the new flow. */
  name: string;
  /** Plain-English description from the user. */
  description: string;
}

export interface ComposeOk {
  ok: true;
  flow: ComposedFlow;
  /** The raw LLM reply, kept for debugging / logging. */
  rawResponse: string;
}

export interface ComposeFail {
  ok: false;
  /** One or more reasons the compose attempt failed. */
  errors: string[];
  /** The raw LLM reply (if any) so the assistant can iterate. */
  rawResponse: string | null;
}

export type ComposeResult = ComposeOk | ComposeFail;

export interface ComposeDeps {
  llm: PieceLlmClient;
  pieceRegistry: JarvisPieceRegistry;
}

/** Build + validate a draft flow from a description. */
export async function composeFlow(
  deps: ComposeDeps,
  req: ComposeRequest,
): Promise<ComposeResult> {
  if (!req.name.trim()) return { ok: false, errors: ["name is required"], rawResponse: null };
  if (!req.description.trim()) return { ok: false, errors: ["description is required"], rawResponse: null };

  const catalogText = renderCatalog(deps.pieceRegistry);
  const system = buildSystemPrompt(catalogText);
  const prompt = `User description: ${req.description.trim()}\n\nReturn ONLY the JSON object. No prose, no markdown fences.`;

  let raw: string;
  try {
    const reply = await deps.llm.chat({ system, prompt });
    raw = reply.text.trim();
  } catch (e) {
    return { ok: false, errors: [`LLM call failed: ${(e as Error).message}`], rawResponse: null };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonFence(raw));
  } catch (e) {
    return { ok: false, errors: [`response was not valid JSON: ${(e as Error).message}`], rawResponse: raw };
  }

  const validation = validateComposedFlow(parsed, deps.pieceRegistry, req.name);
  if (!validation.ok) return { ok: false, errors: validation.errors, rawResponse: raw };

  return { ok: true, flow: validation.flow, rawResponse: raw };
}

/* ---------------------------------------------------------- system prompt */

function buildSystemPrompt(catalog: string): string {
  return [
    "You are the Jarvis workflow composer. Convert the user's description into a workflow definition.",
    "",
    "Output a single JSON object with this exact shape:",
    '{ "displayName": "<short title>",',
    '  "trigger": { ',
    '    "name": "trigger",',
    '    "type": "EMPTY" | "PIECE_TRIGGER",',
    '    "displayName": "<optional>",',
    '    "settings": { "pieceName": "...", "triggerName": "...", "input": { ... } },',
    '    "nextAction": { "name": "step_1", "type": "PIECE", "settings": { "pieceName": "...", "actionName": "...", "input": { ... } }, "nextAction": { ... } }',
    "  } }",
    "",
    "Rules:",
    "  - The first node is named 'trigger'. Action steps are named 'step_1', 'step_2', etc.",
    "  - Use type='EMPTY' for manual / on-demand flows. Use type='PIECE_TRIGGER' for scheduled, webhook, or event-driven.",
    "  - For schedule triggers: pieceName='schedule', input.cron_expression='<5-field cron>' (e.g. '0 8 * * *' for 8am daily).",
    "  - For webhook triggers: pieceName='webhook', input.secret optional.",
    "  - For event triggers: pieceName='jarvis-trigger', triggerName='on_event', input.eventType='<event type>'.",
    "  - For action steps, type MUST be 'PIECE' and settings MUST include pieceName + actionName.",
    "  - Use {{trigger.field}} and {{step_N.field}} templates to wire data between steps.",
    "  - Every required input field MUST be present.",
    "  - Output ONLY the JSON. No markdown. No explanation.",
    "",
    "Available pieces:",
    catalog,
  ].join("\n");
}

function renderCatalog(registry: JarvisPieceRegistry): string {
  const lines: string[] = [];
  for (const piece of registry.list()) {
    lines.push(`- ${piece.name} (${piece.displayName}): ${piece.description}`);
    for (const trigger of Object.values(piece.triggers ?? {})) {
      lines.push(`    trigger ${trigger.name}: ${trigger.description}`);
      lines.push(...renderSchemaLines(trigger.inputSchema, 6));
    }
    for (const action of Object.values(piece.actions)) {
      lines.push(`    action  ${action.name}: ${action.description}`);
      lines.push(...renderSchemaLines(action.inputSchema, 6));
    }
  }
  // Surface the schedule and webhook primitives the trigger manager understands
  // even though they aren't in the JarvisPieceRegistry today.
  lines.push("");
  lines.push("Built-in trigger primitives (no piece registration needed):");
  lines.push("- schedule: settings={pieceName:'schedule', input:{cron_expression:'0 8 * * *'}} fires on cron.");
  lines.push("- webhook:  settings={pieceName:'webhook',  input:{secret:'<optional HMAC secret>'}} fires on HTTP POST to /api/webhooks/<flow_id>.");
  return lines.join("\n");
}

function renderSchemaLines(schema: PieceInputSchema | undefined, indent: number): string[] {
  if (!schema) return [];
  const pad = " ".repeat(indent);
  return schema.fields.map((f) => `${pad}- input.${f.name}: ${formatField(f)}`);
}

function formatField(f: PieceInputField): string {
  const parts: string[] = [`${f.type}${f.required ? ", REQUIRED" : ""}`];
  if (f.options && f.options.length > 0) {
    parts.push(`options=${f.options.map((o) => o.value).join("|")}`);
  }
  if (f.description) parts.push(f.description);
  return `${parts.join("; ")}`;
}

/* ------------------------------------------------------------- validation */

interface ValidationOk { ok: true; flow: ComposedFlow }
interface ValidationFail { ok: false; errors: string[] }

function validateComposedFlow(
  raw: unknown,
  registry: JarvisPieceRegistry,
  fallbackName: string,
): ValidationOk | ValidationFail {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, errors: ["expected an object at the top level"] };
  }
  const root = raw as Record<string, unknown>;
  const displayName = typeof root.displayName === "string" && root.displayName.trim() ? root.displayName.trim() : fallbackName;
  const triggerRaw = root.trigger;
  if (typeof triggerRaw !== "object" || triggerRaw === null) {
    return { ok: false, errors: ["missing or invalid 'trigger' object"] };
  }
  const errors: string[] = [];
  const knownNames = new Set<string>();
  const trigger = validateStep(triggerRaw as Record<string, unknown>, errors, knownNames, true, registry);
  if (!trigger) return { ok: false, errors };

  // Walk subsequent actions.
  let cursor: Record<string, unknown> | null = (triggerRaw as Record<string, unknown>).nextAction
    ? ((triggerRaw as Record<string, unknown>).nextAction as Record<string, unknown>)
    : null;
  let last: ComposedStep = trigger;
  let depth = 0;
  while (cursor) {
    if (++depth > 100) {
      errors.push("flow exceeds 100 steps");
      break;
    }
    const step = validateStep(cursor, errors, knownNames, false, registry);
    if (!step) break;
    last.nextAction = step;
    last = step;
    cursor = cursor.nextAction ? (cursor.nextAction as Record<string, unknown>) : null;
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, flow: { displayName, trigger } };
}

function validateStep(
  raw: Record<string, unknown>,
  errors: string[],
  knownNames: Set<string>,
  isTrigger: boolean,
  registry: JarvisPieceRegistry,
): ComposedStep | null {
  const name = typeof raw.name === "string" ? raw.name : null;
  if (!name) {
    errors.push(isTrigger ? "trigger missing name" : "action step missing name");
    return null;
  }
  if (knownNames.has(name)) {
    errors.push(`duplicate step name: ${name}`);
    return null;
  }
  knownNames.add(name);

  const type = raw.type;
  if (isTrigger) {
    if (type !== "EMPTY" && type !== "PIECE_TRIGGER") {
      errors.push(`trigger.type must be EMPTY or PIECE_TRIGGER (got ${String(type)})`);
      return null;
    }
  } else if (type !== "PIECE") {
    errors.push(`action step "${name}" must have type='PIECE' (got ${String(type)})`);
    return null;
  }

  const step: ComposedStep = {
    name,
    type: type as ComposedStep["type"],
  };
  if (typeof raw.displayName === "string") step.displayName = raw.displayName;

  const settingsRaw = raw.settings;
  if (settingsRaw !== undefined) {
    if (typeof settingsRaw !== "object" || settingsRaw === null || Array.isArray(settingsRaw)) {
      errors.push(`step "${name}" settings must be an object`);
      return null;
    }
    step.settings = settingsRaw as ComposedStep["settings"];
  }

  if (type === "EMPTY") return step; // manual trigger is always valid

  const settings = step.settings ?? {};
  const pieceName = typeof settings.pieceName === "string" ? settings.pieceName : null;
  if (!pieceName) {
    errors.push(`step "${name}" missing settings.pieceName`);
    return step;
  }

  // Schedule + webhook are runtime primitives, not registered pieces.
  if (isTrigger && (pieceName === "schedule" || pieceName === "webhook")) {
    return step;
  }

  const piece = registry.get(pieceName);
  if (!piece) {
    errors.push(`step "${name}" references unknown piece "${pieceName}"`);
    return step;
  }

  const subKey = isTrigger ? "triggerName" : "actionName";
  const subName = typeof settings[subKey] === "string" ? (settings[subKey] as string) : null;
  if (!subName) {
    errors.push(`step "${name}" missing settings.${subKey}`);
    return step;
  }

  const sub = isTrigger
    ? piece.triggers?.[subName]
    : piece.actions[subName];
  if (!sub) {
    errors.push(`step "${name}" references unknown ${isTrigger ? "trigger" : "action"} ${pieceName}:${subName}`);
    return step;
  }

  // Required-field check.
  const input = (settings.input ?? {}) as Record<string, unknown>;
  const schema = (sub as { inputSchema?: PieceInputSchema }).inputSchema;
  if (schema) {
    for (const field of schema.fields) {
      if (!field.required) continue;
      const v = input[field.name];
      const empty = v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
      if (empty) {
        errors.push(`step "${name}" (${pieceName}:${subName}) missing required input "${field.name}"`);
      }
    }
  }
  return step;
}

function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  const m = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i.exec(trimmed);
  if (m && typeof m[1] === "string") return m[1].trim();
  return trimmed;
}

// Mark unused import as used to keep the symbol referenced for type narrowing.
type _Piece = JarvisPiece;
