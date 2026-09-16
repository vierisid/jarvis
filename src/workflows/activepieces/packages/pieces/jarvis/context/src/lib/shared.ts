/**
 * Shared helpers for jarvis-context actions: a single fetcher that POSTs
 * to a daemon-internal `/v1/jarvis/context/...` route with the engineToken.
 *
 * All four actions share the same wire envelope (POST + JSON body + JSON
 * response) so they collapse to one helper.
 *
 * The daemon governs these reads through its Authority boundary. A `200`
 * carries the payload unchanged; a `202` means the read is waiting on an
 * approval, so the helper parks the run on the returned waitpoint and hands
 * back `pending` as the step's placeholder output.
 */

type ContextActionContext = {
  server: { apiUrl: string; token: string };
  step: { name: string; executionPath?: readonly [string, number][] };
  run: { waitForWaitpoint(waitpointId: string): void };
};

export async function postContext<T>(
  context: ContextActionContext,
  path: string,
  body: Record<string, unknown>,
  pending: T,
): Promise<T> {
  const url = trimSlash(context.server.apiUrl) + path;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${context.server.token}`,
      "X-Jarvis-Step-Name": context.step.name,
      "X-Jarvis-Execution-Path": JSON.stringify(context.step.executionPath ?? []),
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `jarvis-context: daemon responded ${response.status}: ${text.slice(0, 500)}`,
    );
  }
  if (response.status === 202) {
    const { approval } = (await response.json()) as {
      approval?: { effectId: string; approvalId: string; waitpointId: string };
    };
    if (!approval) {
      throw new Error("jarvis-context: daemon returned 202 without an approval");
    }
    context.run.waitForWaitpoint(approval.waitpointId);
    return pending;
  }
  return (await response.json()) as T;
}

function trimSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}
