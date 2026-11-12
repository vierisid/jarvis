import React, { createContext, useContext } from "react";
import { createPortal } from "react-dom";

/** One authenticated owner or isolated fixture. Never replace global fetch. */
export type WorkflowRequest = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;
const defaultRequest: WorkflowRequest = (input, init) =>
  globalThis.fetch(input, init);
export interface EditCopy { read(): string | null; write(value: string): void; clear(): void }
export const WorkflowEditorEnvironment = createContext<{
  request: WorkflowRequest;
  portalHost: HTMLElement | null;
  workspace: boolean;
  sampleDrafts?: Map<string, string>;
  /** Where unsaved edits are copied, so a reload or a lost session does not lose them. */
  editCopy?: EditCopy;
}>({ request: defaultRequest, portalHost: null, workspace: false });
export const useEditCopy = () => useContext(WorkflowEditorEnvironment).editCopy;
export const useWorkflowRequest = () =>
  useContext(WorkflowEditorEnvironment).request;
export function WorkflowPortal({ children }: { children: React.ReactNode }) {
  const { portalHost } = useContext(WorkflowEditorEnvironment);
  return createPortal(children, portalHost ?? document.body);
}
