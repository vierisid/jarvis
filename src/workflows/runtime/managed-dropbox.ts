/** Fetch-only managed operations. No SDK retries or credential-bearing transport output. */
export const MANAGED_DROPBOX_ACTIONS = [
  "search_dropbox",
  "list_dropbox_folder",
  "get_dropbox_file_metadata",
  "create_new_dropbox_folder",
] as const;
export function managedDropboxInput(
  input: unknown,
): Record<string, unknown> | null {
  return (input as { auth?: { jarvis_managed?: unknown } } | null)?.auth
    ?.jarvis_managed === "dropbox"
    ? (input as Record<string, unknown>)
    : null;
}
function path(value: unknown, root = false, revision = false): string {
  if (
    typeof value !== "string" ||
    value.length > 4096 ||
    /[\x00-\x1f\x7f]/.test(value) ||
    !(
      (root && value === "") ||
      value.startsWith("/") ||
      /^id:[A-Za-z0-9_-]+$/.test(value) || (revision && /^rev:[a-f0-9]{9,}$/.test(value))
    )
  )
    throw new Error("Enter a Dropbox path or file ID.");
  return root && value === "/" ? "" : value;
}
function boundedNumber(value: unknown, fallback: number, max: number): number {
  if (value === undefined || value === null) return fallback;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > max
  )
    throw new Error("Choose a valid Dropbox result limit.");
  return value;
}
export async function runManagedDropboxAction(
  action: string,
  input: Record<string, unknown>,
  request: typeof fetch = fetch,
): Promise<unknown> {
  if (!(MANAGED_DROPBOX_ACTIONS as readonly string[]).includes(action))
    throw new Error(
      "This Dropbox action has not been enabled for the managed connection.",
    );
  const auth = input.auth as {
    access_token?: unknown;
    home_namespace_id?: unknown;
  };
  if (
    typeof auth?.access_token !== "string" ||
    !auth.access_token ||
    typeof auth.home_namespace_id !== "string" ||
    !/^\d+$/.test(auth.home_namespace_id)
  )
    throw new Error("Reconnect Dropbox.");
  let endpoint: string, body: Record<string, unknown>;
  if (action === "search_dropbox") {
    if (
      typeof input.query !== "string" ||
      input.query.trim().length < 3 ||
      input.query.length > 1000
    )
      throw new Error("Enter a search of 3 to 1,000 characters.");
    const orderBy = input.order_by ?? "relevance";
    if (orderBy !== "relevance" && orderBy !== "modified_time")
      throw new Error("Choose relevance or modified time for Dropbox search.");
    endpoint = "search_v2";
    body = {
      query: input.query,
      options: {
        path: path(input.path ?? "", true),
        max_results: boundedNumber(input.max_results, 100, 1000),
        filename_only: true,
        file_status: "active",
        order_by: orderBy,
      },
    };
    // Hosted search always matches file names only (filename_only is sent as
    // true whatever the step says; the catalog's field description says so).
    // Every other filter the endpoint does not send is refused, not ignored.
    for (const key of ["file_extensions", "file_categories", "account_id"])
      if (input[key])
        throw new Error(
          "Hosted Dropbox search supports a query and folder path. Remove advanced filters.",
        );
    if (input.file_status && input.file_status !== "active")
      throw new Error("Hosted Dropbox searches active files only.");
  } else if (action === "list_dropbox_folder") {
    endpoint = "list_folder";
    body = {
      path: path(input.path ?? "", true),
      recursive: input.recursive === true,
      limit: boundedNumber(input.limit, 100, 2000),
    };
  } else if (action === "get_dropbox_file_metadata") {
    endpoint = "get_metadata";
    body = {
      path: path(input.path, false, true),
      include_deleted: false,
      include_media_info: false,
      include_has_explicit_shared_members: false,
    };
    if (
      input.include_deleted ||
      input.include_media_info ||
      input.include_has_explicit_shared_members
    )
      throw new Error(
        "Hosted Dropbox supports basic metadata. Disable advanced metadata options.",
      );
  } else if (action === "create_new_dropbox_folder") {
    endpoint = "create_folder_v2";
    const destination = path(input.path);
    if (!destination.startsWith("/") || destination === "/")
      throw new Error("Enter the new folder's full Dropbox path.");
    body = { path: destination, autorename: input.autorename === true };
  } else {
    throw new Error(
      "This Dropbox action has not been enabled for the managed connection.",
    );
  }
  let response: Response;
  try {
    response = await request("https://api.dropboxapi.com/2/files/" + endpoint, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      headers: {
        Authorization: "Bearer " + auth.access_token,
        "Content-Type": "application/json",
        "Dropbox-API-Path-Root": JSON.stringify({ ".tag": "home" }),
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error(
      "Dropbox did not confirm the request. Check the folder before trying again.",
    );
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(
      response.status === 401
        ? "Dropbox refused access. Reconnect Dropbox."
        : response.status === 409
          ? "Dropbox could not complete this operation. Check the path and whether the folder already exists."
          : "Dropbox did not confirm the request. Check the folder before trying again.",
    );
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Dropbox returned an empty response.");
  try {
    let size = 0;
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 1048576) throw new Error();
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const c of chunks) {
      bytes.set(c, offset);
      offset += c.length;
    }
    const result = JSON.parse(new TextDecoder().decode(bytes));
    if (!result || typeof result !== "object" || Array.isArray(result))
      throw new Error();
    if (
      action === "create_new_dropbox_folder" &&
      (result.metadata?.[".tag"] !== "folder" ||
        typeof result.metadata?.id !== "string")
    )
      throw new Error();
    if (
      action === "list_dropbox_folder" &&
      (!Array.isArray(result.entries) || typeof result.has_more !== "boolean")
    )
      throw new Error();
    if (
      action === "search_dropbox" &&
      (!Array.isArray(result.matches) || typeof result.has_more !== "boolean")
    )
      throw new Error();
    return result;
  } catch {
    throw new Error(
      "Dropbox returned an invalid response. Check the folder before trying again.",
    );
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
