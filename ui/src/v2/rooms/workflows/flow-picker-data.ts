/**
 * Picker-side data source for the `flow_ref` widget.
 *
 * Pulled out of `WorkflowEditor.tsx` so we can unit-test the shape
 * resilience (non-2xx, non-array body, missing displayName) without
 * mounting the editor's React tree. The widget itself stays
 * declarative; this module owns the network boundary.
 */

export interface FlowPickerEntry {
  id: string;
  displayName: string;
}

/**
 * Fetch the list of workflows for the picker.
 *
 * Resilience contract: any unexpected response shape resolves to `[]`
 * rather than crashing the picker. The caller renders a "no workflows"
 * hint in that case. Non-OK HTTP responses throw, which the picker
 * catches and surfaces as an error row -- the user can tell the
 * difference between "nothing here" and "couldn't fetch."
 *
 * `displayName` falls back to `(unnamed)` when the field is missing or
 * empty so every entry has something readable.
 */
export async function fetchFlowsForPicker(): Promise<FlowPickerEntry[]> {
  const res = await fetch("/api/workflows");
  if (!res.ok) throw new Error(`GET /api/workflows -> ${res.status}`);
  const body = (await res.json()) as unknown;
  return normalizeFlowsResponse(body);
}

/**
 * Project a parsed `/api/workflows` response into the picker's shape.
 * Exported separately so tests can drive it with arbitrary inputs
 * (the network call is straight-line and trivial to fake separately).
 */
export function normalizeFlowsResponse(body: unknown): FlowPickerEntry[] {
  if (!Array.isArray(body)) return [];
  const out: FlowPickerEntry[] = [];
  for (const row of body) {
    if (typeof row !== "object" || row === null) continue;
    const id = (row as { id?: unknown }).id;
    if (typeof id !== "string" || id.length === 0) continue;
    const raw = (row as { displayName?: unknown }).displayName;
    const displayName = typeof raw === "string" && raw.length > 0 ? raw : "(unnamed)";
    out.push({ id, displayName });
  }
  return out;
}
