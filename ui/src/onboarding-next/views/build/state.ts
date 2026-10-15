export type BuildPhase = "understanding" | "building" | "validating" | "saving";
export type BuildOutcome = "queued" | "working" | "needs_input" | "succeeded" | "failed" | "cancelled";
export interface BuildStatus {
  jobId: string;
  revision: number;
  outcome: BuildOutcome;
  phase?: BuildPhase;
  completedPhases?: BuildPhase[];
  safeError?: string;
  missingInputs?: string[];
}
export interface DraftReference {
  jobId: string;
  requestId: string;
  compositionRecordId: string;
  flowId: string;
  versionId: string;
  readiness: "ready" | "needs_input";
  activation: "disabled";
}
export const phases: readonly { id: BuildPhase; label: string }[] = [
  { id: "understanding", label: "Understanding your routine" },
  { id: "building", label: "Putting the steps together" },
  { id: "validating", label: "Checking the review points" },
  { id: "saving", label: "Saving your draft" },
];
const outcomes: readonly string[] = ["queued", "working", "needs_input", "succeeded", "failed", "cancelled"];
export const isTerminal = (status: BuildStatus | null) =>
  Boolean(status && ["succeeded", "failed", "cancelled"].includes(status.outcome));

/** Presentation guard only. B08 still owns authoritative ordering and terminality.
 * Corrections must retain a terminal outcome; a new attempt uses a new job scope. */
export function acceptStatus(previous: BuildStatus | null, incoming: BuildStatus | undefined, jobId: string): BuildStatus | null {
  if (!incoming || incoming.jobId !== jobId || !Number.isSafeInteger(incoming.revision) || incoming.revision < 0
    || !outcomes.includes(incoming.outcome)
    || (incoming.phase !== undefined && !phases.some(phase => phase.id === incoming.phase))
    || (previous && incoming.revision <= previous.revision)
    || (isTerminal(previous) && incoming.outcome !== previous!.outcome)) return previous;
  return { ...incoming, completedPhases: incoming.completedPhases?.filter(phase => phases.some(item => item.id === phase)),
    missingInputs: incoming.missingInputs ? [...incoming.missingInputs] : undefined };
}

export function verifiedReference(reference: DraftReference | undefined, jobId: string, requestId: string): reference is DraftReference {
  return Boolean(reference && reference.jobId === jobId && reference.requestId === requestId
    && reference.activation === "disabled" && ["ready", "needs_input"].includes(reference.readiness)
    && [reference.compositionRecordId, reference.flowId, reference.versionId].every(id => typeof id === "string" && id.trim().length > 0));
}
