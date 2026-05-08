/**
 * Shared helpers for jarvis-context actions: a single fetcher that POSTs
 * to a daemon-internal `/v1/jarvis/context/...` route with the engineToken.
 *
 * All four actions share the same wire envelope (POST + JSON body + JSON
 * response) so they collapse to one helper.
 */

export async function postContext<T>(
  serverUrl: string,
  serverToken: string,
  path: string,
  body: Record<string, unknown>,
): Promise<T> {
  const url = trimSlash(serverUrl) + path;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${serverToken}`,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `jarvis-context: daemon responded ${response.status}: ${text.slice(0, 500)}`,
    );
  }
  return (await response.json()) as T;
}

function trimSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}
