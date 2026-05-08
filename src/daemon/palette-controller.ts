/**
 * Palette controller — bridges the dashboard's `_palette` page back into
 * the daemon's panel-management code in `index.ts`. The daemon registers
 * a handler at startup; the api-routes module forwards palette actions
 * (HTTP POST `/api/palette/pick` and `/api/palette/close`) by calling
 * the handler. Decouples the route layer from the panel-tracking
 * closures without leaking sidecarManager wiring out of `index.ts`.
 *
 * This stays a thin module on purpose — no logic, just a function-pointer
 * registry. The same shape would let us wire other dashboard-spawned
 * panels into the daemon's bookkeeping without re-plumbing.
 */

export type PalettePickKind = 'room' | 'object';

export type PalettePickRequest = {
  kind: PalettePickKind;
  /** Room key when kind === "room"; object ref when kind === "object". */
  key: string;
  /** Shift+Enter — caller wants the fullscreen Room takeover, not the inline preview. */
  openInRoom?: boolean;
};

export interface PaletteHandler {
  pick(req: PalettePickRequest): Promise<void> | void;
  close(): Promise<void> | void;
}

let handler: PaletteHandler | null = null;

export function setPaletteHandler(h: PaletteHandler | null): void {
  handler = h;
}

export function getPaletteHandler(): PaletteHandler | null {
  return handler;
}
