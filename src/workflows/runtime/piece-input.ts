/**
 * Schema types describing a piece action's / trigger's typed input fields.
 *
 * Used at three layers:
 *   - `PieceCatalog` builds these from upstream `PiecePropertyMap` so dashboards
 *     and the NL composer can read structured input requirements without
 *     pulling the upstream zod runtime.
 *   - The dashboard's `WorkflowEditor` renders the right widget per `type`.
 *   - The NL workflow composer formats them into the LLM prompt and validates
 *     required fields on the model's reply.
 *
 * This module deliberately stays small and dependency-free so it can move
 * with the catalog if the workflow runtime is ever split out.
 */

/**
 * Type of a single input field on a piece action or trigger. Drives the
 * typed widget the dashboard renders (text input, dropdown, toggle, etc.).
 *
 * Kept Jarvis-native rather than mirroring upstream's full Property API --
 * our UI only needs to discriminate widget kinds, not preserve every
 * upstream affordance.
 *
 * KEEP THIS IN SYNC with the mirrored type in
 * `ui/src/v2/rooms/workflows/useWorkflowEditor.ts` (search for
 * "PieceInputType"). The duplication keeps the UI bundle independent of
 * daemon-side modules; each new variant must be added in both places or
 * the editor will silently fall through to its default branch.
 */
export type PieceInputType =
  | "string"      // single-line text input
  | "long_text"   // multi-line textarea
  | "number"      // numeric input
  | "boolean"     // toggle / checkbox
  | "enum"        // single-select dropdown
  | "multi_enum"  // multi-select chip list
  | "datetime"    // ISO-8601 date / datetime picker
  | "json"        // raw JSON textarea
  | "flow_ref";   // workflow picker -- searchable popover, stores a flow id

export interface PieceInputField {
  /** Stable key used in `settings.input`. */
  name: string;
  /** Display label for the panel. */
  label: string;
  type: PieceInputType;
  required: boolean;
  /** Optional inline help text below the widget. */
  description?: string;
  /** Optional placeholder for text/number widgets. */
  placeholder?: string;
  /**
   * Choices for enum / multi_enum. Order is rendering order. `group` is
   * optional; when present, the editor renders matching options inside
   * a labelled <optgroup>. Used to keep wide option lists scannable
   * (e.g. `observer.*` / `awareness.*` / `commitment.*` for the
   * jarvis-trigger:on_event eventType dropdown).
   */
  options?: ReadonlyArray<{ value: string; label: string; description?: string; group?: string }>;
  /** Suggested default. Used by the UI when the field is first revealed. */
  default?: unknown;
}

export interface PieceInputSchema {
  fields: ReadonlyArray<PieceInputField>;
}
