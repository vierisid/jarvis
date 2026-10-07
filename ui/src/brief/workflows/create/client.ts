import { isBriefCapabilityEnabled } from "../../../../../src/brief/capabilities";
import { readJob, type CompositionPort } from "./model";

/** Explicitly injected by the authenticated host. Construction performs no requests.
 * The host must retire this port/controller when its account or vault changes. */
export function createCompositionPort(capabilities: () => unknown, request: (url: string, init?: RequestInit) => Promise<Response> = fetch): CompositionPort {
  const base = "/api/brief/workflow-compositions";
  async function json(path: string, init?: RequestInit): Promise<unknown> {
    if (!isBriefCapabilityEnabled(capabilities(), "workflowComposition")) throw Error("Composition unavailable");
    const res = await request(path, { credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(15_000), ...init });
    if (!res.ok) throw Error("Composition unavailable");
    return res.json();
  }
  return {
    async submit(spec) {
      if (spec.ingredients !== undefined && !isBriefCapabilityEnabled(capabilities(), "compositionIngredients")) throw Error("Ingredient selection unavailable");
      const value = await json(base, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(spec) }) as { job?: unknown };
      return readJob(value?.job, spec);
    },
    async recover(spec) {
      const value = await json(`${base}?requestId=${encodeURIComponent(spec.requestId)}`) as { jobs?: unknown[] };
      if (!Array.isArray(value?.jobs) || value.jobs.length > 1) throw Error("Invalid recovery response");
      return value.jobs.length ? readJob(value.jobs[0], spec) : null;
    },
    async read(id) { return readJob(await json(`${base}/${encodeURIComponent(id)}`)); },
  };
}
