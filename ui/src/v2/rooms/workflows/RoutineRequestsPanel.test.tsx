import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initWorkflowDb } from "../../../../../src/workflows/db";
import { closeDb, getDb } from "../../../../../src/vault/schema";
import { createSuggestion } from "../../../../../src/vault/awareness";
import { createGoal } from "../../../../../src/vault/goals";
import { getSuggestionLearning } from "../../../../../src/awareness/suggestion-feedback";
import { createSuggestionFeedbackRoutes } from "../../../../../src/awareness/suggestion-feedback-routes";
import { SuggestionComposer } from "../../../../../src/awareness/suggestion-composer";

const NativeRequest = globalThis.Request;
const NativeResponse = globalThis.Response;
const originalFetch = globalThis.fetch;
GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let act: typeof import("react").act;
let createRoot: typeof import("react-dom/client").createRoot;
let WorkflowsRoomBody: typeof import("./WorkflowsRoom").WorkflowsRoomBody;
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot> | null = null;
let worker: SuggestionComposer | undefined;
let directory: string;
let database: string;
let suggestion: ReturnType<typeof createSuggestion>;
let requests: string[];
let lostAcceptance = false;
let acceptanceBodies: string[];
let failDismiss = false;

beforeAll(async () => {
  ({ act } = await import("react"));
  ({ createRoot } = await import("react-dom/client"));
  ({ WorkflowsRoomBody } = await import("./WorkflowsRoom"));
});
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "jarvis-routines-ui-")); database = join(directory, "test.db");
  initWorkflowDb(database); requests = []; acceptanceBodies = []; lostAcceptance = false; failDismiss = false;
  suggestion = createSuggestion({ type: "automation", title: "Invoice review", body: "Invoice checks recur.",
    context: { opportunity: { patternKey: "job-v1:invoice-review", evidence: [{ captureId: "capture-1", app: "Mail", cue: "invoices" }] } } });
  const routes = createSuggestionFeedbackRoutes(() => worker) as Record<string, Record<string, (request: any) => Promise<Response>>>;
  globalThis.fetch = (async (input, options = {}) => {
    const url = String(input); requests.push(url);
    const pathname = url.split("?")[0]!;
    if (["/api/workflows", "/api/workflows/triggers"].includes(pathname)) return NativeResponse.json([]);
    if (pathname === "/api/goals") return NativeResponse.json(getDb().query("SELECT id, title FROM goals WHERE status = 'active'").all());
    const route = Object.keys(routes).find(key => key.replace(":id", suggestion.id) === pathname);
    if (!route) return NativeResponse.json({ error: "Fixture has no editor data" }, { status: 404 });
    if (failDismiss && url.endsWith("/dismiss")) return NativeResponse.json({ error: "Dismissal unavailable" }, { status: 500 });
    // The browser signal belongs to Happy DOM; the server receives a fresh request.
    const { signal: _browserSignal, ...serverOptions } = options;
    const request = Object.assign(new NativeRequest(`http://localhost${url}`, serverOptions), { params: { id: suggestion.id } });
    const result = await routes[route]![options.method ?? "GET"]!(request);
    if (url.endsWith("/accept")) {
      acceptanceBodies.push(String(options.body));
      if (lostAcceptance) { lostAcceptance = false; throw new Error("Response lost. Retry to recover your saved request."); }
    }
    return result;
  }) as typeof fetch;
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount()); root = null; host?.remove();
  worker?.stop(); await worker?.idle(); worker = undefined;
  closeDb(); rmSync(directory, { recursive: true, force: true }); globalThis.fetch = originalFetch;
});
afterAll(() => GlobalRegistrator.unregister());

const button = (label: string) => {
  const found = [...host.querySelectorAll("button")].find(el => el.textContent?.trim() === label);
  if (!found) throw new Error(`Missing ${label}: ${host.textContent}`);
  return found;
};
async function mount() {
  if (root) { await act(async () => root!.unmount()); host.remove(); }
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(<WorkflowsRoomBody />));
  await act(async () => button("Routine requests").click());
}
async function submitDraft() {
  await act(async () => button("Draft a routine").click());
  (host.querySelector('[name="description"]') as HTMLTextAreaElement).value = "Collect invoices for review";
  (host.querySelector('[name="expectedOutcome"]') as HTMLTextAreaElement).value = "Invoices needing attention";
  await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
}

test("active Workflows room recovers an old delivered proposal, accepts once, retries after restart and opens its draft", async () => {
  getDb().run("UPDATE awareness_suggestions SET delivered = 1, created_at = 1 WHERE id = ?", [suggestion.id]);
  closeDb(); initWorkflowDb(database);
  await mount(); expect(host.textContent).toContain("Invoice review"); expect(host.textContent).toContain("capture-1");
  await submitDraft();
  expect(getSuggestionLearning(suggestion.id).composition?.state).toBe("queued");
  expect(acceptanceBodies).toHaveLength(1);
  worker = new SuggestionComposer(async () => ({ ok: false, errors: ["Connect invoice service"], rawResponse: null }));
  worker.start(); await worker.idle(); worker.stop();
  closeDb(); initWorkflowDb(database); await mount();
  expect(host.textContent).toContain("Connect invoice service");
  worker = new SuggestionComposer(async () => ({ ok: true, rawResponse: "", flow: {
    displayName: "Invoice review", trigger: { type: "EMPTY", name: "trigger" },
  } })); worker.start(); await worker.idle();
  await act(async () => { button("Retry composition").click(); }); await worker.idle();
  await act(async () => button("Refresh requests").click());
  const learning = getSuggestionLearning(suggestion.id);
  expect(learning.composition?.state).toBe("draft_ready");
  await act(async () => button("Review draft").click());
  expect(requests).toContain(`/api/workflows/${learning.composition!.workflowId}`);
  expect(getDb().query<{ count: number }, []>("SELECT COUNT(*) AS count FROM flow").get()!.count).toBe(1);
});

test("dashboard records dismissal reasons and retains the proposal after a failed save", async () => {
  await mount(); await act(async () => button("Dismiss proposal").click());
  (host.querySelector('[name="reason"]') as HTMLTextAreaElement).value = "Already automated";
  failDismiss = true;
  await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Dismissal unavailable");
  expect(getSuggestionLearning(suggestion.id).status).toBe("proposed");
  failDismiss = false;
  await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  closeDb(); initWorkflowDb(database); await mount();
  expect(host.textContent).toContain("Dismissed"); expect(host.textContent).toContain("Already automated");
  expect(host.textContent).not.toContain("Draft a routine");
});

test("dashboard requires explicit goal confirmation and recovers an uncertain acceptance", async () => {
  const goal = createGoal("Close the books", "objective", { status: "active" });
  await mount(); await act(async () => button("Draft a routine").click());
  expect((host.querySelector('[name="goalId"]') as HTMLSelectElement).value).toBe("");
  await act(async () => {
    const select = host.querySelector('[name="goalId"]') as HTMLSelectElement;
    select.value = goal.id; select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect((host.querySelector('[name="goalReason"]') as HTMLInputElement).required).toBe(true);
  (host.querySelector('[name="goalReason"]') as HTMLInputElement).value = "Invoice review supports month-end close";
  (host.querySelector('[name="description"]') as HTMLTextAreaElement).value = "Review invoices";
  (host.querySelector('[name="expectedOutcome"]') as HTMLTextAreaElement).value = "Review summary";
  lostAcceptance = true;
  await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(host.textContent).toContain("Response lost");
  await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(acceptanceBodies).toHaveLength(2); expect(acceptanceBodies[0]).toBe(acceptanceBodies[1]);
  expect(getSuggestionLearning(suggestion.id).goalLink?.goalId).toBe(goal.id);
  expect(getDb().query<{ count: number }, []>("SELECT COUNT(*) AS count FROM suggestion_composition_jobs").get()!.count).toBe(1);
});

test("an empty older page still lets the user return to saved requests", async () => {
  getDb().transaction(() => {
    for (let i = 0; i < 99; i++) createSuggestion({ type: "automation", title: `Routine ${i}`, body: "Recurring work",
      context: { opportunity: { patternKey: `page-${i}` } } });
  })();
  await mount(); await act(async () => button("Older requests").click());
  expect(host.textContent).toContain("No older requests.");
  await act(async () => button("Newer requests").click());
  expect(host.querySelectorAll(".wf-routines__row")).toHaveLength(100);
});
