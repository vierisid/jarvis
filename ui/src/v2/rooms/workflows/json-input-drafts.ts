import { createContext } from 'react';
import type { FlowStepNode } from './useWorkflowEditor';
export interface JsonInputDraft { text: string; error: string | null }
export function jsonInputScope(step: FlowStepNode): string {
  return JSON.stringify([step.name, step.type, step.settings?.pieceName, step.settings?.actionName, step.settings?.triggerName]);
}
export const JsonInputDraftContext = createContext<{
  scope: string;
  drafts: Record<string, JsonInputDraft>;
  set(key: string, draft: JsonInputDraft): void;
} | null>(null);
export const jsonInputKey = (scope: string, field: string) => JSON.stringify([scope, field]);
