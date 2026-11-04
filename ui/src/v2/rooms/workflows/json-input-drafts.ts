import { createContext } from 'react';
import type { FlowStepNode } from './useWorkflowEditor';
/** `base` is the serialized graph value the text was typed against; a different value means an outside change replaced it. */
export interface JsonInputDraft { text: string; error: string | null; base: string }
export const jsonInputBase = (value: unknown): string => JSON.stringify(value ?? null);
export function jsonInputScope(step: FlowStepNode): string {
  return JSON.stringify([step.name, step.type, step.settings?.pieceName, step.settings?.actionName, step.settings?.triggerName]);
}
export const JsonInputDraftContext = createContext<{
  scope: string;
  drafts: Record<string, JsonInputDraft>;
  set(key: string, draft: JsonInputDraft): void;
  clear(key: string): void;
} | null>(null);
export const jsonInputKey = (scope: string, field: string) => JSON.stringify([scope, field]);
