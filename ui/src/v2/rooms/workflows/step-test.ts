/**
 * "Test this step": run one step of the on-screen workflow and say how it went.
 *
 * The run API tests the LATEST SAVED draft, so a test with unsaved edits would
 * run old settings and report on them. This saves the draft first, queues the
 * test, waits for it to finish and reads that one step's result back.
 */

export interface StepTestResult {
  ok: boolean;
  /** One plain sentence for the status line. */
  message: string;
  /** Present once the test ran to an end (it passed, or the step failed). */
  test?: {
    passed: boolean;
    /** What the step returned (passed only). */
    output?: unknown;
    /** Why it failed, in words (failed only). */
    detail?: string;
    /** The unsaved edits were saved before testing. */
    savedFirst: boolean;
  };
}

type Send = (input: string, init?: RequestInit) => Promise<Response>;

const TERMINAL = new Set(["SUCCEEDED", "FAILED", "STOPPED", "TIMEOUT", "INTERNAL_ERROR", "QUOTA_EXCEEDED", "MEMORY_LIMIT_EXCEEDED", "SCHEDULE_FAILURE"]);
const OFFLINE = "You are offline, so the test could not run. Your edits are still here.";

const object = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

async function readJson(res: Response): Promise<Record<string, unknown> | null> {
  try { const body = await res.json(); return object(body) ? body : null; } catch { return null; }
}

/** What a refused request says, in words: the server's sentence plus the first readiness issues. */
export function refusalText(body: Record<string, unknown> | null, status: number): string {
  const issues = Array.isArray(body?.issues) ? (body!.issues as unknown[]).map((i) => object(i) ? text(i.message) : "").filter(Boolean) : [];
  issues.splice(0, issues.length, ...new Set(issues));
  const head = text(body?.error);
  const shown = issues.slice(0, 3).join(" ");
  const more = issues.length > 3 ? ` And ${issues.length - 3} more.` : "";
  if (shown) return `${head && !/^workflow_not_ready$/i.test(head) ? head + " " : ""}${shown}${more}`.trim();
  return head && !/^[a-z_]+$/.test(head) ? head : `The test could not start (error ${status}).`;
}

/** The result of the one step under test, from a finished run. */
export function readStepResult(run: Record<string, unknown>, stepName: string): { passed: boolean; output?: unknown; detail?: string } {
  const steps = object(run.steps) ? run.steps : {};
  const record = object(steps[stepName]) ? steps[stepName] as Record<string, unknown> : null;
  const inner = record && object(record.output) && ("status" in record.output || "output" in record.output) ? record.output : record;
  const failure = object(run.failure) ? run.failure : null;
  const failedStep = object(run.failedStep) ? run.failedStep : null;
  const stepStatus = text(inner?.status);
  if (run.status === "SUCCEEDED" && (stepStatus === "" || stepStatus === "SUCCEEDED")) {
    return { passed: true, output: inner && "output" in inner ? inner.output : undefined };
  }
  const reason = [text(failure?.headline), text(failure?.outcome)].filter(Boolean).join(" ")
    || text(inner?.errorMessage) || text(failedStep?.errorMessage)
    || "The step did not finish. Open Runs to see what happened.";
  return { passed: false, detail: reason };
}

export async function runStepTest(opts: {
  request: Send;
  flowId: string;
  stepName: string;
  /** Persist on-screen edits first; null when nothing is unsaved. */
  saveFirst: (() => Promise<{ ok: boolean; message: string }>) | null;
  /** Called after a finished test so the sample output can be refreshed. */
  finished?: () => Promise<void>;
  alive?: () => boolean;
  pollMs?: number;
  timeoutMs?: number;
}): Promise<StepTestResult> {
  const { request, flowId, stepName } = opts;
  const alive = opts.alive ?? (() => true);
  let savedFirst = false;
  if (opts.saveFirst) {
    const saved = await opts.saveFirst();
    if (!saved.ok) return { ok: false, message: `Not tested: your changes could not be saved. ${saved.message}` };
    savedFirst = true;
  }
  let started: Response;
  try {
    started = await request(`/api/workflows/${flowId}/run`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ triggeredBy: "dashboard:test-from-here", stepNameToTest: stepName, environment: "TESTING" }),
    });
  } catch { return { ok: false, message: OFFLINE }; }
  const accepted = await readJson(started);
  if (!started.ok || typeof accepted?.id !== "string") return { ok: false, message: refusalText(accepted, started.status) };
  const deadline = Date.now() + (opts.timeoutMs ?? 90_000);
  for (;;) {
    let run: Record<string, unknown> | null = null;
    try {
      const res = await request(`/api/workflow-runs/${encodeURIComponent(accepted.id)}`);
      run = res.ok ? await readJson(res) : null;
    } catch { /* keep waiting; a blip must not end the test */ }
    if (run && typeof run.status === "string") {
      if (run.status === "PAUSED") return { ok: false, message: "The test is waiting for an answer. Open Runs to see it." };
      if (TERMINAL.has(run.status)) {
        const result = readStepResult(run, stepName);
        if (result.passed) await opts.finished?.().catch(() => undefined);
        return {
          ok: result.passed,
          message: result.passed ? "Test passed." : "Test failed.",
          test: { ...result, savedFirst },
        };
      }
    }
    if (!alive()) return { ok: false, message: "Test still running. Open Runs to see it." };
    if (Date.now() >= deadline) return { ok: false, message: "The test is taking longer than expected. Open Runs to see how it ends." };
    await new Promise((r) => setTimeout(r, opts.pollMs ?? 700));
  }
}
