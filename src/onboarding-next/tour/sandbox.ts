import { accountMenuRoom, isTourStep } from './steps.ts';
import type { TourSnapshot } from './types.ts';
export interface WorkspaceState {
  roomId: string;
  selectedObject: { kind: string; id: string } | null;
  theme: 'light' | 'dark'; sidebar: 'expanded' | 'rail';
  chat: { open: boolean; conversationId: string | null };
}
/** Presentation-only overlay. There is deliberately no live navigation, theme
 * setter, send, upload, account or workflow port to call or restore. The owning
 * workspace/conversation stays mounted and untouched underneath. Supply actual
 * read-only D renderers separately; this module contains no sample user data. */
export function createTourSandbox(scopeId: string, workspace: WorkspaceState) {
  const original = structuredClone(workspace);
  let current: TourSnapshot | null = null, disposed = false, open = false;
  function read() {
    const active = current?.active === true && current.stepId !== null;
    const at = active ? current!.stepId! : null;
    return { active, original: structuredClone(original), mode: 'tutorial' as const, effects: 'disabled' as const,
      roomId: at === 'pebble' ? original.roomId : at ?? original.roomId,
      selectedObject: at === 'pebble' || !active ? structuredClone(original.selectedObject) : null,
      theme: original.theme, sidebar: original.sidebar, accountMenuOpen: at ? accountMenuRoom(at) : false,
      // Only the demonstration panel changes. The real chat identity/draft is retained by the host.
      chat: { ...original.chat, open: active ? at === 'pebble' && open : original.chat.open },
      model: current && { sessionId: current.sessionId, revision: current.revision, stepId: at,
        phase: 'ready' as const, theme: original.theme, sidebar: original.sidebar },
      roomStatus: current?.roomStatus ?? 'unsupported',
    };
  }
  return {
    read,
    present(next: TourSnapshot) {
      if (disposed || next.scopeId !== scopeId || (next.active && !isTourStep(next.stepId))) throw new Error('Tour sandbox unavailable');
      if (current && (next.sessionId !== current.sessionId || next.revision < current.revision)) throw new Error('Stale tour snapshot');
      if (!next.active || next.stepId !== 'pebble' || !current?.active) open = false;
      current = structuredClone(next);
      return read();
    },
    setPebbleOpen(value: boolean) {
      if (disposed || !current?.active || current.stepId !== 'pebble' || current.roomStatus !== 'ready' || typeof value !== 'boolean') throw new Error('Pebble unavailable');
      open = value; return read();
    },
    dispose() { disposed = true; current = null; open = false; },
  };
}
