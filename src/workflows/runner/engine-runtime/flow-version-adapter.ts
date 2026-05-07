/**
 * Convert our `FlowVersion` (as persisted in the workflow DB) into the exact
 * shape activepieces' engine validates against
 * (`@activepieces/shared` `FlowVersion`/`FlowTrigger`/`FlowAction`).
 *
 * Differences we bridge:
 *   - Timestamps: we store epoch ms, upstream wants ISO strings on every node
 *     (`created`, `updated`, and `lastUpdatedDate` per action/trigger).
 *   - Per-node defaults: `valid` defaults to true if absent, `displayName`
 *     defaults to `name`, action `settings` are passed through as-is.
 *   - LOOP / ROUTER children stay nested; the engine walks them recursively.
 *
 * We do NOT validate against upstream's zod schemas at the adapter boundary.
 * The engine validates its inputs itself; if our shape is wrong it returns a
 * structured error that surfaces back to the daemon. Adding a separate zod
 * pass here would just duplicate work.
 */

import type {
  FlowTriggerNode,
  FlowVersion as JarvisFlowVersion,
} from "../../db/repos/flow-version";

interface UpstreamCommonNode {
  name: string;
  valid: boolean;
  displayName: string;
  lastUpdatedDate: string;
}

interface UpstreamEmptyTrigger extends UpstreamCommonNode {
  type: "EMPTY";
  settings: Record<string, unknown>;
  nextAction?: UpstreamFlowAction;
}

interface UpstreamPieceTrigger extends UpstreamCommonNode {
  type: "PIECE_TRIGGER";
  settings: {
    pieceName: string;
    pieceVersion: string;
    triggerName?: string;
    input: Record<string, unknown>;
    propertySettings: Record<string, unknown>;
  };
  nextAction?: UpstreamFlowAction;
}

type UpstreamFlowTrigger = UpstreamEmptyTrigger | UpstreamPieceTrigger;

interface UpstreamCodeAction extends UpstreamCommonNode {
  type: "CODE";
  skip?: boolean;
  settings: {
    sourceCode: { packageJson: string; code: string };
    input: Record<string, unknown>;
  };
  nextAction?: UpstreamFlowAction;
}

interface UpstreamPieceAction extends UpstreamCommonNode {
  type: "PIECE";
  skip?: boolean;
  settings: {
    pieceName: string;
    pieceVersion: string;
    actionName?: string;
    input: Record<string, unknown>;
    propertySettings: Record<string, unknown>;
  };
  nextAction?: UpstreamFlowAction;
}

interface UpstreamLoopAction extends UpstreamCommonNode {
  type: "LOOP_ON_ITEMS";
  skip?: boolean;
  settings: { items: string };
  firstLoopAction?: UpstreamFlowAction;
  nextAction?: UpstreamFlowAction;
}

interface UpstreamRouterAction extends UpstreamCommonNode {
  type: "ROUTER";
  skip?: boolean;
  settings: {
    branches: Array<unknown>;
    executionType: "EXECUTE_FIRST_MATCH" | "EXECUTE_ALL_MATCH";
  };
  children: Array<UpstreamFlowAction | null>;
  nextAction?: UpstreamFlowAction;
}

export type UpstreamFlowAction =
  | UpstreamCodeAction
  | UpstreamPieceAction
  | UpstreamLoopAction
  | UpstreamRouterAction;

export interface UpstreamFlowVersion {
  id: string;
  created: string;
  updated: string;
  flowId: string;
  displayName: string;
  trigger: UpstreamFlowTrigger;
  updatedBy: string | null;
  valid: boolean;
  schemaVersion: string | null;
  agentIds: string[];
  state: "DRAFT" | "LOCKED";
  connectionIds: string[];
  backupFiles: Record<string, string> | null;
  notes: unknown[];
}

const DEFAULT_PIECE_VERSION = "0.0.0";

function toIso(epochMs: number | null | undefined, fallback: string): string {
  if (typeof epochMs !== "number" || Number.isNaN(epochMs)) return fallback;
  return new Date(epochMs).toISOString();
}

function nodeDisplayName(node: FlowTriggerNode): string {
  return node.displayName ?? node.name;
}

function adaptTrigger(
  trigger: FlowTriggerNode,
  fallbackTimestamp: string,
): UpstreamFlowTrigger {
  const common: UpstreamCommonNode = {
    name: trigger.name,
    valid: true,
    displayName: nodeDisplayName(trigger),
    lastUpdatedDate: fallbackTimestamp,
  };
  if (trigger.type === "EMPTY") {
    return {
      ...common,
      type: "EMPTY",
      settings: (trigger.settings as Record<string, unknown> | undefined) ?? {},
      nextAction: trigger.nextAction
        ? adaptAction(trigger.nextAction, fallbackTimestamp)
        : undefined,
    };
  }
  if (trigger.type === "PIECE_TRIGGER") {
    const settings = trigger.settings ?? {};
    const pieceName = settings.pieceName ?? "";
    return {
      ...common,
      type: "PIECE_TRIGGER",
      settings: {
        pieceName,
        pieceVersion: DEFAULT_PIECE_VERSION,
        triggerName: settings.triggerName,
        input: settings.input ?? {},
        propertySettings: {},
      },
      nextAction: trigger.nextAction
        ? adaptAction(trigger.nextAction, fallbackTimestamp)
        : undefined,
    };
  }
  throw new Error(`unsupported trigger type: ${trigger.type}`);
}

function adaptAction(
  node: FlowTriggerNode,
  fallbackTimestamp: string,
): UpstreamFlowAction {
  const common: UpstreamCommonNode = {
    name: node.name,
    valid: true,
    displayName: nodeDisplayName(node),
    lastUpdatedDate: fallbackTimestamp,
  };
  const settings = node.settings ?? {};
  const next = node.nextAction
    ? adaptAction(node.nextAction, fallbackTimestamp)
    : undefined;

  if (node.type === "PIECE") {
    return {
      ...common,
      type: "PIECE",
      settings: {
        pieceName: settings.pieceName ?? "",
        pieceVersion: DEFAULT_PIECE_VERSION,
        actionName: settings.actionName,
        input: settings.input ?? {},
        propertySettings: {},
      },
      nextAction: next,
    };
  }
  if (node.type === "CODE") {
    // Our `FlowTriggerNode.settings` is loose; CODE callers are expected to
    // place `sourceCode: {packageJson, code}` and `input` on it.
    const looseSettings = settings as Record<string, unknown>;
    const sourceCode = looseSettings["sourceCode"] as
      | { packageJson?: string; code?: string }
      | undefined;
    return {
      ...common,
      type: "CODE",
      settings: {
        sourceCode: {
          packageJson: sourceCode?.packageJson ?? "{}",
          code: sourceCode?.code ?? "",
        },
        input: (looseSettings["input"] as Record<string, unknown> | undefined) ?? {},
      },
      nextAction: next,
    };
  }
  if (node.type === "LOOP_ON_ITEMS") {
    return {
      ...common,
      type: "LOOP_ON_ITEMS",
      settings: { items: settings.items ?? "" },
      firstLoopAction: node.firstLoopAction
        ? adaptAction(node.firstLoopAction, fallbackTimestamp)
        : undefined,
      nextAction: next,
    };
  }
  if (node.type === "ROUTER") {
    return {
      ...common,
      type: "ROUTER",
      settings: {
        branches: settings.branches ?? [],
        executionType: settings.executionType ?? "EXECUTE_FIRST_MATCH",
      },
      children: (node.children ?? []).map((child) =>
        child ? adaptAction(child, fallbackTimestamp) : null,
      ),
      nextAction: next,
    };
  }
  throw new Error(`unsupported action type: ${node.type}`);
}

export function toUpstreamFlowVersion(version: JarvisFlowVersion): UpstreamFlowVersion {
  const created = toIso(version.created, new Date().toISOString());
  const updated = toIso(version.updated, created);
  return {
    id: version.id,
    created,
    updated,
    flowId: version.flowId,
    displayName: version.displayName,
    trigger: adaptTrigger(version.trigger, updated),
    updatedBy: version.updatedBy,
    valid: version.valid,
    schemaVersion: version.schemaVersion,
    agentIds: version.agentIds,
    state: version.state,
    connectionIds: version.connectionIds,
    backupFiles: version.backupFiles,
    notes: version.notes,
  };
}

/** Walk every CODE action in a flow version, yielding its source bundle. */
export function collectCodeActions(version: UpstreamFlowVersion): Array<{
  stepName: string;
  packageJson: string;
  code: string;
}> {
  const result: Array<{ stepName: string; packageJson: string; code: string }> = [];
  function visit(action: UpstreamFlowAction | undefined): void {
    if (!action) return;
    if (action.type === "CODE") {
      result.push({
        stepName: action.name,
        packageJson: action.settings.sourceCode.packageJson,
        code: action.settings.sourceCode.code,
      });
    }
    if (action.type === "LOOP_ON_ITEMS") visit(action.firstLoopAction);
    if (action.type === "ROUTER") {
      for (const child of action.children) visit(child ?? undefined);
    }
    visit(action.nextAction);
  }
  visit(version.trigger.nextAction);
  return result;
}
