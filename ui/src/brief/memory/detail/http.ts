import {
  CONFLICT,
  FAILURE,
  validDetail,
  validFactId,
  validItem,
  validReceipt,
  validScope,
  type DetailRead,
  type ReadFailure,
  type MemoryDetailPort,
} from "./model";

function failure(response: Response): ReadFailure | undefined {
  if (response.status === 401 || response.status === 403)
    return {
      state: "unavailable",
      reason: "Memory access ended. Sign in again.",
    };
  if (response.status === 404)
    return { state: "missing", reason: "This fact is no longer available." };
  if (response.status === 410)
    return { state: "forgotten", reason: "This fact has been forgotten." };
  if (response.status === 409) return CONFLICT;
  if (response.status === 501)
    return {
      state: "unsupported",
      reason: "This brain does not provide this memory operation.",
    };
  if (response.status === 503)
    return {
      state: "unavailable",
      reason: "Memory is temporarily unavailable. Try again later.",
    };
  if (!response.ok)
    return {
      state: "error",
      reason:
        "Memory could not be loaded or saved. Check your input and reload.",
    };
}
/** Existing authenticated F17/F19 reads and canonical fact decisions. Never registered by default.
 * F17 currently advertises canCorrect=false. Preserve that gate; do not infer write authority
 * from the legacy route's existence. The integration owner must verify permission readiness.
 */
export function memoryDetailHttpPort(
  scopeId: string,
  request: typeof fetch = fetch,
): MemoryDetailPort {
  const send = (url: string, signal: AbortSignal, body?: unknown) =>
    request(url, {
      method: body === undefined ? "GET" : "POST",
      credentials: "same-origin",
      cache: "no-store",
      signal,
      headers: {
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const detailUrl = (id: string) =>
    `/api/brief/memory/${encodeURIComponent(id)}`;
  async function read(id: string, signal: AbortSignal): Promise<DetailRead> {
    if (!validFactId(id)) return FAILURE;
    const first = await send(detailUrl(id), signal),
      problem = failure(first);
    if (problem) return problem;
    const before = await first.json();
    if (
      before?.state !== "ready" ||
      !validItem(before.data) ||
      before.data.factId !== id
    )
      return FAILURE;
    const canonical = await send(
        `/api/vault/facts/${encodeURIComponent(id)}`,
        signal,
      ),
      canonicalProblem = failure(canonical);
    if (canonicalProblem) return canonicalProblem;
    const fact = await canonical.json();
    // Never combine a stale stream sentence with a different canonical value or provenance.
    const last = await send(detailUrl(id), signal),
      lastProblem = failure(last);
    if (lastProblem) return lastProblem;
    const after = await last.json();
    if (
      after?.state !== "ready" ||
      !validItem(after.data) ||
      after.data.factId !== id
    )
      return FAILURE;
    if (before.data.revision !== after.data.revision) return CONFLICT;
    const data = { item: after.data, fact };
    return validDetail(data, id) ? { state: "ready", data } : FAILURE;
  }
  return {
    source: "live",
    scopeId,
    read,
    async history(id, signal) {
      if (!validFactId(id)) return FAILURE;
      const response = await send(`${detailUrl(id)}/history`, signal),
        problem = failure(response);
      if (problem) return problem;
      const body = await response.json();
      return body?.state === "ready" &&
        Array.isArray(body.data) &&
        body.data.length <= 100 &&
        body.data.every(validItem) &&
        body.data.some((item: any) => item.factId === id) &&
        new Set(body.data.map((item: any) => item.factId)).size ===
          body.data.length
        ? { state: "ready", items: body.data }
        : FAILURE;
    },
    async decide(command, signal) {
      const current = await read(command.factId, signal);
      if (current.state !== "ready") return current;
      if (
        !current.data.item.permissions.canCorrect ||
        current.data.item.status === "superseded"
      )
        return {
          state: "unavailable",
          reason: "Correction is not available for this fact.",
        };
      if (current.data.item.revision !== command.revision) return CONFLICT;
      try {
        // Canonical writer owns supersession and conflict semantics; never PATCH the display sentence.
        const response = await send(
          `/api/vault/facts/${encodeURIComponent(command.factId)}/${command.kind}`,
          signal,
          {
            confirmed: true,
            reason: command.reason,
            ...(command.kind === "correct" ? { object: command.object } : {}),
          },
        );
        if (response.status >= 500)
          return {
            state: "unknown",
            reason:
              "The save result is unknown. Reload the current fact before another action.",
          };
        const problem = failure(response);
        if (problem) return problem;
        const fact = await response.json();
        return validFactId(fact?.id) &&
          fact.subject_id === current.data.fact.subject_id &&
          fact.predicate === current.data.fact.predicate &&
          fact.scope === current.data.fact.scope &&
          fact.object ===
            (command.kind === "correct"
              ? command.object.trim()
              : current.data.fact.object) &&
          fact.basis === "confirmed" &&
          fact.status === "active"
          ? { state: "saved", factId: fact.id }
          : {
              state: "unknown",
              reason:
                "The save response could not be verified. Reload the current fact.",
            };
      } catch {
        return {
          state: "unknown",
          reason:
            "The save result is unknown. Reload the current fact before another action.",
        };
      }
    },
    async prepareForget(id, signal) {
      if (!validFactId(id)) return FAILURE;
      const response = await send(`${detailUrl(id)}/forget`, signal),
        problem = failure(response);
      if (problem) return problem;
      const body = await response.json();
      if (body?.state === "forgotten" && validReceipt(body.receipt, id))
        return body;
      return body?.state === "ready" &&
        body.factId === id &&
        typeof body.revision === "string" &&
        /^[a-f0-9]{64}$/.test(body.revision) &&
        validScope(body.scope)
        ? body
        : FAILURE;
    },
    async forget(id, command, signal) {
      if (!validFactId(id)) return FAILURE;
      try {
        const response = await send(`${detailUrl(id)}/forget`, signal, command);
        if (response.status >= 500)
          return {
            state: "unknown",
            reason:
              "The Forget result is unknown. Check its receipt before another action.",
          };
        const problem = failure(response);
        if (problem) return problem;
        const body = await response.json();
        return body?.state === "forgotten" &&
          validReceipt(body.receipt, id) &&
          body.receipt.revision === command.expectedRevision
          ? { state: "forgotten", receipt: body.receipt }
          : {
              state: "unknown",
              reason:
                "The Forget response could not be verified. Check its receipt.",
            };
      } catch {
        return {
          state: "unknown",
          reason:
            "The Forget result is unknown. Check its receipt before another action.",
        };
      }
    },
  };
}
