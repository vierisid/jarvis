/** GitLab.com only. One reviewed write, no arbitrary paths, redirects or automatic retries. */
export const MANAGED_GITLAB_ACTIONS = ["create_issue"] as const;
const record = (v: unknown): v is Record<string, any> =>
  !!v && typeof v === "object" && !Array.isArray(v);
export function managedGitLabInput(piece: string, input: unknown): boolean {
  return (
    piece === "@activepieces/piece-gitlab" &&
    record(input) &&
    record(input.auth) &&
    input.auth.jarvis_managed === "gitlab"
  );
}
function id(value: unknown): number {
  if (typeof value === "string" && /^[1-9][0-9]{0,15}$/.test(value))
    value = Number(value);
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    throw new Error(
      "Enter a positive numeric GitLab project ID or a workflow variable.",
    );
  return value;
}
function text(value: unknown, max: number, name: string): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)
  )
    throw new Error(`Enter a GitLab ${name} of 1 to ${max} characters.`);
  return value;
}
export async function runManagedGitLabAction(
  action: string,
  input: Record<string, unknown>,
  request: typeof fetch = fetch,
): Promise<unknown> {
  if (action !== "create_issue")
    throw new Error(
      "This GitLab action is not enabled for the managed connection.",
    );
  if (
    !record(input.auth) ||
    typeof input.auth.access_token !== "string" ||
    !input.auth.access_token
  )
    throw new Error("Reconnect GitLab.");
  for (const [key, value] of Object.entries(input))
    if (
      !["auth", "projectId", "title", "description"].includes(key) &&
      value !== undefined &&
      value !== null &&
      value !== ""
    )
      throw new Error(
        "Remove unsupported GitLab fields before creating the issue.",
      );
  const project = id(input.projectId),
    title = text(input.title, 255, "issue title");
  if (/[\r\n]/.test(title))
    throw new Error("Use a single line for the GitLab issue title.");
  const description =
    input.description == null || input.description === ""
      ? undefined
      : text(input.description, 10000, "issue description");
  // GitLab executes quick actions in API-created descriptions. They can move, close or change permissions
  // on an issue, so a create-only grant must not pass slash-command lines to the API.
  if (description && /(?:^|[\r\n])\s*\//.test(description))
    throw new Error("Remove GitLab slash commands from the issue description.");
  let response: Response;
  try {
    response = await request(
      `https://gitlab.com/api/v4/projects/${project}/issues`,
      {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(15000),
        headers: {
          Authorization: "Bearer " + input.auth.access_token,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          title,
          ...(description === undefined ? {} : { description }),
        }),
      },
    );
  } catch {
    throw new Error(
      "GitLab did not confirm issue creation. Check the project before trying again.",
    );
  }
  if (response.status !== 201) {
    await response.body?.cancel().catch(() => {});
    throw new Error(
      response.status === 401
        ? "GitLab refused access. Reconnect GitLab."
        : response.status === 429
          ? "GitLab is rate limiting requests. Check the project before trying again later."
          : "GitLab did not confirm issue creation. Check the project, account permissions and existing issues before trying again.",
    );
  }
  const reader = response.body?.getReader();
  if (!reader)
    throw new Error(
      "GitLab returned no issue details. Check the project before trying again.",
    );
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
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
    if (
      !record(result) ||
      id(result.project_id) !== project ||
      typeof result.title !== "string" ||
      !["opened", "closed"].includes(result.state) ||
      !(typeof result.description === "string" || result.description === null)
    )
      throw new Error();
    const issueId = id(result.id),
      iid = id(result.iid),
      url = new URL(result.web_url);
    if (
      url.origin !== "https://gitlab.com" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      // GitLab.com may link a new issue as a work item.
      !(
        url.pathname.endsWith("/-/issues/" + iid) ||
        url.pathname.endsWith("/-/work_items/" + iid)
      )
    )
      throw new Error();
    return {
      id: issueId,
      iid,
      project_id: project,
      title: result.title,
      description: result.description ?? "",
      state: result.state,
      web_url: url.href,
    };
  } catch {
    throw new Error(
      "GitLab returned invalid or oversized issue details. Check the project before trying again.",
    );
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
