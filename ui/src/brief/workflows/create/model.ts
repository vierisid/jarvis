/** Structural F-07 wire port. No import dependency on the unmerged feature track. */
export const PROMPT_BYTES = 16_384;
export interface CompositionRequest { requestId: string; prompt: string; name?: string }
export interface CompositionJob {
  jobId: string; requestId: string; specification: { name: string; prompt: string };
  state: "queued" | "running" | "draft_ready" | "blocked" | "failed" | "cancelled";
  progress: { checkedCandidates: number }; compositionId: string | null;
  workflow: { flowId: string; versionId: string } | null;
  blocker: { code: string; message: string; details: string[] } | null;
  createdAt: number; updatedAt: number;
}
export interface CompositionPort {
  submit(request: CompositionRequest): Promise<CompositionJob>;
  recover(request: CompositionRequest): Promise<CompositionJob | null>;
  read(jobId: string): Promise<CompositionJob>;
}
export const pendingJob = (job: CompositionJob | null) => !job || job.state === "queued" || job.state === "running";
export const validPrompt = (prompt: string) => !!prompt.trim() && new TextEncoder().encode(prompt).length <= PROMPT_BYTES;

/** Reject mismatched or malformed receipts before they can navigate to a different draft. */
export function readJob(value: unknown, request?: CompositionRequest): CompositionJob {
  if (!value || typeof value !== "object") throw Error("Invalid composition receipt");
  const j = value as CompositionJob;
  if (!j.jobId || typeof j.jobId !== "string" || typeof j.requestId !== "string"
    || !["queued","running","draft_ready","blocked","failed","cancelled"].includes(j.state)
    || typeof j.specification?.name !== "string" || typeof j.specification.prompt !== "string"
    || !Number.isSafeInteger(j.progress?.checkedCandidates) || j.progress.checkedCandidates < 0
    || !Number.isFinite(j.createdAt) || !Number.isFinite(j.updatedAt)
    || (j.workflow !== null && (!j.workflow || typeof j.workflow.flowId !== "string" || !j.workflow.flowId || typeof j.workflow.versionId !== "string" || !j.workflow.versionId))
    || (j.state === "draft_ready" && !j.workflow)
    || (j.state !== "draft_ready" && j.workflow !== null)
    || (j.blocker !== null && (!j.blocker || typeof j.blocker.message !== "string" || !Array.isArray(j.blocker.details) || !j.blocker.details.every(s => typeof s === "string")))
    || (request && (j.requestId !== request.requestId || j.specification.prompt !== request.prompt || j.specification.name !== (request.name ?? "New workflow")))) throw Error("Invalid composition receipt");
  return j;
}

export const WORKFLOW_SUGGESTIONS = [
  { id: "meetings", label: "Follow up after meetings", text: "After each meeting, read the notes and draft a concise follow-up in Gmail. Include the agreed next step, flag any unconfirmed date, and ask for my approval before sending." },
  { id: "inbox", label: "Summarise my inbox", text: "Every weekday morning, summarise my unread Gmail messages and show the ones that need my attention. Do not send or delete messages." },
  { id: "competitors", label: "Track competitors", text: "Every Tuesday, check the competitors I choose for product updates and prepare a brief with links to the changes." },
] as const;
