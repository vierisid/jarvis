/** Fixed operations for the hosted Figma grant; no token-bearing request follows a user URL. */
export const MANAGED_FIGMA_ACTIONS = [
  "get_file",
  "get_comments",
  "post_comment",
] as const;
const record = (v: unknown): v is Record<string, any> =>
  !!v && typeof v === "object" && !Array.isArray(v);
export function managedFigmaInput(
  piece: string,
  input: unknown,
): input is Record<string, unknown> {
  return (
    piece === "@activepieces/piece-figma" &&
    record(input) &&
    record(input.auth) &&
    input.auth.jarvis_managed === "figma"
  );
}
export function figmaFileKey(value: unknown): string {
  if (typeof value !== "string") throw Error("Enter a Figma file link or key.");
  const raw = value.trim();
  if (/^[A-Za-z0-9]{1,128}$/.test(raw)) return raw;
  try {
    const url = new URL(raw);
    if (
      url.protocol !== "https:" ||
      !["www.figma.com", "figma.com"].includes(url.hostname) ||
      url.port ||
      url.username ||
      url.password
    )
      throw Error();
    const parts = url.pathname.split("/").filter(Boolean);
    if (
      ![
        "file",
        "design",
        "board",
        "proto",
        "slides",
        "draw",
        "buzz",
        "site",
      ].includes(parts[0] ?? "")
    )
      throw Error();
    const key = parts[2] === "branch" ? parts[3] : parts[1];
    if (!key || !/^[A-Za-z0-9]{1,128}$/.test(key)) throw Error();
    return key;
  } catch {
    throw Error("Enter a Figma file link or key from figma.com.");
  }
}
export const FIGMA_RESPONSE_LIMIT = 8 * 1024 * 1024;
const validComment = (v: unknown, key: string) =>
  record(v) &&
  typeof v.id === "string" &&
  !!v.id &&
  v.file_key === key &&
  typeof v.message === "string" &&
  record(v.user) &&
  typeof v.user.id === "string";
export async function runManagedFigmaAction(
  action: string,
  input: Record<string, unknown>,
  request: typeof fetch = fetch,
): Promise<unknown> {
  if (!(MANAGED_FIGMA_ACTIONS as readonly string[]).includes(action))
    throw Error("This Figma action is not enabled for the managed connection.");
  const token = record(input.auth) ? input.auth.access_token : null;
  if (typeof token !== "string" || !token || token.length > 16384)
    throw Error("Reconnect Figma.");
  const key = figmaFileKey(input.file_key),
    posting = action === "post_comment";
  if (
    posting &&
    (typeof input.message !== "string" ||
      !input.message.trim() ||
      input.message.length > 10000)
  )
    throw Error("Enter a Figma comment of 1 to 10,000 characters.");
  const body = posting ? { message: input.message } : undefined;
  const url =
    "https://api.figma.com/v1/files/" +
    key +
    (action === "get_file" ? "" : "/comments");
  const uncertain = posting
    ? " Check the file before trying again; the comment may already have been posted."
    : " Try again shortly.";
  let response: Response;
  try {
    response = await request(url, {
      method: posting ? "POST" : "GET",
      redirect: "error",
      signal: AbortSignal.timeout(30000),
      headers: {
        Authorization: "Bearer " + token,
        Accept: "application/json",
        ...(posting ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw Error("Could not reach Figma." + uncertain);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    if (response.status === 429)
      throw Error(
        "Figma's API rate limit was reached. Wait before running this step again; limits depend on your Figma plan and seat." +
          uncertain,
      );
    if ([401, 403].includes(response.status))
      throw Error(
        "Figma refused access. Check file permissions or reconnect Figma.",
      );
    if (response.status === 404)
      throw Error("Figma file not found or unavailable to this account.");
    throw Error(
      "Figma could not complete the request (HTTP " +
        response.status +
        ")." +
        uncertain,
    );
  }
  const reader = response.body?.getReader();
  let result: any;
  try {
    if (!reader) throw Error();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > FIGMA_RESPONSE_LIMIT) throw Error();
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    result = JSON.parse(new TextDecoder().decode(bytes));
    if (!record(result) || result.err || result.error || result.status >= 400)
      throw Error();
    if (action === "get_file") {
      if (
        typeof result.name !== "string" ||
        typeof result.version !== "string" ||
        typeof result.lastModified !== "string" ||
        !record(result.document) ||
        result.document.type !== "DOCUMENT" ||
        typeof result.document.id !== "string"
      )
        throw Error();
    } else if (posting) {
      if (!validComment(result, key) || result.message !== input.message)
        throw Error();
    } else if (
      !Array.isArray(result.comments) ||
      !result.comments.every((c: unknown) => validComment(c, key))
    )
      throw Error();
  } catch {
    throw Error(
      "Figma returned an invalid or oversized response (8 MiB limit)." +
        uncertain,
    );
  } finally {
    await reader?.cancel().catch(() => {});
    reader?.releaseLock();
  }
  // Keep the published piece's wrapper so stored references work on either credential path.
  return {
    success: true,
    ...(body ? { request_body: body } : {}),
    response_body: result,
  };
}
