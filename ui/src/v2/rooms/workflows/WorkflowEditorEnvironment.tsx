import React, { createContext, useContext } from "react";
import { createPortal } from "react-dom";

/** One authenticated owner or isolated fixture. Never replace global fetch. */
export type WorkflowRequest = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;
const defaultRequest: WorkflowRequest = (input, init) =>
  globalThis.fetch(input, init);
export const WorkflowEditorEnvironment = createContext<{
  request: WorkflowRequest;
  portalHost: HTMLElement | null;
  workspace: boolean;
  sampleDrafts?: Map<string, string>;
}>({ request: defaultRequest, portalHost: null, workspace: false });
export const useWorkflowRequest = () =>
  useContext(WorkflowEditorEnvironment).request;
export function WorkflowPortal({ children }: { children: React.ReactNode }) {
  const { portalHost } = useContext(WorkflowEditorEnvironment);
  return createPortal(children, portalHost ?? document.body);
}
