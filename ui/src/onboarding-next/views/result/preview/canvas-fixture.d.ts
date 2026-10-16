declare module 'on-u-09-canvas-fixture' {
  import type { ComponentType, Context } from 'react';
  export const available: boolean;
  export const WorkflowEditor: ComponentType<any>;
  export const WorkflowEditorEnvironment: Context<any>;
  export const NavigationShell: ComponentType<any>;
  export const UNKNOWN_NAVIGATION: Record<string, unknown>;
  export const CANVAS_CATALOG: unknown[];
  export function versionBoundRequest(request: typeof fetch, flowId: string, versionId: string): typeof fetch;
}
