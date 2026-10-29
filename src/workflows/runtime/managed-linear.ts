/** Fixed GraphQL operations, bounded pages, no implicit write retries. */
export const MANAGED_LINEAR_ACTIONS = [
  "linear_get_issue",
  "linear_search_issues",
  "linear_create_issue",
  "linear_update_issue",
  "linear_create_comment",
] as const;
const record = (v: unknown): v is Record<string, any> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const provided = (v: unknown) => v !== undefined && v !== null && v !== "";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const KEY = /^[A-Za-z][A-Za-z0-9]{0,31}-[1-9][0-9]{0,12}$/;
const ISSUE_FIELDS =
  "id identifier title description url priority dueDate createdAt updatedAt team { id name key } state { id name } assignee { id name }";
export function managedLinearInput(
  input: unknown,
): Record<string, unknown> | null {
  return record(input) &&
    record(input.auth) &&
    input.auth.jarvis_managed === "linear"
    ? input
    : null;
}
function text(v: unknown, label: string, max = 512, multiline = false): string {
  if (
    typeof v !== "string" ||
    !v.trim() ||
    v.length > max ||
    (multiline ? /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/ : /[\x00-\x1f\x7f]/).test(v)
  )
    throw new Error("Enter a valid " + label + ".");
  return v.trim();
}
function id(v: unknown, label: string): string {
  const value = text(v, label, 36);
  if (!UUID.test(value))
    throw new Error(
      "Use the model UUID for " +
        label +
        ". Copy it from Linear's command menu.",
    );
  return value.toLowerCase();
}
function issueId(v: unknown): string {
  const value = text(v, "issue ID", 48);
  if (UUID.test(value)) return value.toLowerCase();
  if (KEY.test(value)) return value.toUpperCase();
  throw new Error("Use an issue UUID or key such as ENG-123.");
}
function boolean(v: unknown): boolean {
  if (!provided(v)) return false;
  if (typeof v !== "boolean") throw new Error("Choose a valid Linear filter.");
  return v;
}
function issue(v: unknown): Record<string, any> {
  if (
    !record(v) ||
    typeof v.id !== "string" ||
    !UUID.test(v.id) ||
    typeof v.identifier !== "string" ||
    !KEY.test(v.identifier) ||
    typeof v.title !== "string" ||
    typeof v.url !== "string" ||
    typeof v.priority !== "number" ||
    !record(v.team) ||
    typeof v.team.id !== "string" ||
    !UUID.test(v.team.id)
  )
    throw new Error();
  const url = new URL(v.url);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "linear.app" ||
    url.username ||
    url.password ||
    url.port
  )
    throw new Error();
  return {
    id: v.id,
    identifier: v.identifier,
    title: v.title,
    description: typeof v.description === "string" ? v.description : null,
    url: v.url,
    priority: v.priority,
    due_date: v.dueDate ?? null,
    created_at: v.createdAt,
    updated_at: v.updatedAt,
    team_id: v.team.id,
    team_name: v.team.name,
    team_key: v.team.key,
    state_id: v.state?.id ?? null,
    state_name: v.state?.name ?? null,
    assignee_id: v.assignee?.id ?? null,
    assignee_name: v.assignee?.name ?? null,
  };
}
/** Shared by the managed actions and the read-only setup choices. Never accepts a caller URL. */
export async function linearGraphql(
  token: string,
  query: string,
  variables: Record<string, unknown>,
  request: typeof fetch = fetch,
  writing = false,
): Promise<Record<string, any>> {
  let response: Response;
  try {
    response = await request("https://api.linear.app/graphql", {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ query, variables }),
    });
  } catch {
    throw new Error(
      writing
        ? "Linear's result is uncertain. Check the issue before trying again."
        : "Linear could not be reached. Try again shortly.",
    );
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(
      response.status === 401
        ? "Linear refused access. Reconnect Linear."
        : response.status === 429
          ? "Linear is rate limiting requests. Try again later."
          : "Linear refused this request. Check access and the issue before retrying.",
    );
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Linear returned an empty response.");
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
    const value = JSON.parse(new TextDecoder().decode(bytes));
    // A GraphQL 200 may contain partial data AND errors. Never treat that as success.
    if (
      !record(value) ||
      (value.errors !== undefined &&
        (!Array.isArray(value.errors) || value.errors.length)) ||
      !record(value.data)
    )
      throw new Error();
    return value.data;
  } catch {
    throw new Error(
      "Linear returned errors or an invalid response. Check permissions and the issue before retrying.",
    );
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export async function runManagedLinearAction(
  action: string,
  input: Record<string, unknown>,
  request: typeof fetch = fetch,
): Promise<unknown> {
  if (!(MANAGED_LINEAR_ACTIONS as readonly string[]).includes(action))
    throw new Error(
      "This Linear action has not been enabled for the managed connection.",
    );
  if (
    !record(input.auth) ||
    typeof input.auth.secret_text !== "string" ||
    !input.auth.secret_text
  )
    throw new Error("Reconnect Linear.");
  const gql = (
    query: string,
    variables: Record<string, unknown>,
    writing = false,
  ) =>
    linearGraphql(
      input.auth && (input.auth as any).secret_text,
      query,
      variables,
      request,
      writing,
    );
  const get = async (reference: string) => {
    const result = await gql(
      `query JarvisGetIssue($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`,
      { id: reference },
    );
    try {
      const value = issue(result.issue);
      if (
        UUID.test(reference)
          ? value.id.toLowerCase() !== reference
          : value.identifier !== reference
      )
        throw new Error();
      return value;
    } catch {
      throw new Error(
        "Linear did not return the requested issue. Check the issue ID and workspace access.",
      );
    }
  };
  if (action === "linear_get_issue") return get(issueId(input.issue_id));
  if (action === "linear_search_issues") {
    const first = provided(input.limit) ? input.limit : 25;
    if (
      typeof first !== "number" ||
      !Number.isInteger(first) ||
      first < 1 ||
      first > 100
    )
      throw new Error("Choose a result limit from 1 to 100.");
    const variables = {
      term: text(input.term, "search text", 1000),
      first,
      ...(provided(input.cursor)
        ? { after: text(input.cursor, "cursor", 2048) }
        : {}),
      includeComments: boolean(input.include_comments),
      includeArchived: boolean(input.include_archived),
      ...(provided(input.team_id)
        ? { filter: { team: { id: { eq: id(input.team_id, "team") } } } }
        : {}),
    };
    const data = await gql(
      `query JarvisSearchIssues($term: String!, $filter: IssueFilter, $first: Int, $after: String, $includeArchived: Boolean, $includeComments: Boolean) { searchIssues(term: $term, filter: $filter, first: $first, after: $after, includeArchived: $includeArchived, includeComments: $includeComments) { totalCount pageInfo { hasNextPage endCursor } nodes { ${ISSUE_FIELDS} } } }`,
      variables,
    );
    try {
      const page = data.searchIssues;
      if (
        !record(page) ||
        !Array.isArray(page.nodes) ||
        page.nodes.length > first ||
        !record(page.pageInfo) ||
        typeof page.pageInfo.hasNextPage !== "boolean" ||
        !Number.isInteger(page.totalCount) ||
        page.totalCount < page.nodes.length
      )
        throw new Error();
      const cursor = page.pageInfo.endCursor;
      if (
        (cursor !== null &&
          (typeof cursor !== "string" || !cursor || cursor.length > 2048)) ||
        (page.pageInfo.hasNextPage && !cursor)
      )
        throw new Error();
      const items = page.nodes.map(issue);
      if (
        provided(input.team_id) &&
        items.some((i: any) => i.team_id !== variables.filter!.team.id.eq)
      )
        throw new Error();
      return {
        items,
        count: items.length,
        total_count: page.totalCount,
        has_next_page: page.pageInfo.hasNextPage,
        end_cursor: cursor,
      };
    } catch {
      throw new Error("Linear returned an invalid search page.");
    }
  }
  const team = id(input.team_id, "team");
  const creating = action === "linear_create_issue";
  const commenting = action === "linear_create_comment";
  const reference = creating ? undefined : issueId(input.issue_id);
  // Validate every field before even the read preceding a mutation.
  const changes: Record<string, unknown> = {};
  if (creating) changes.teamId = team;
  if (creating || provided(input.title))
    changes.title = text(input.title, "issue title", 512);
  if (provided(input.description))
    changes.description = text(
      input.description,
      "issue description",
      100000,
      true,
    );
  for (const [key, field] of [
    ["state_id", "stateId"],
    ["assignee_id", "assigneeId"],
    ["project_id", "projectId"],
    ["cycle_id", "cycleId"],
    ["parent_id", "parentId"],
    ["template_id", "templateId"],
  ]) {
    if (provided(input[key!])) {
      if (key === "template_id" && !creating)
        throw new Error("Templates apply only when creating an issue.");
      changes[field!] = id(input[key!], key!.replace("_id", ""));
    }
  }
  if (provided(input.priority_id)) {
    if (
      typeof input.priority_id !== "number" ||
      !Number.isInteger(input.priority_id) ||
      input.priority_id < 0 ||
      input.priority_id > 4
    )
      throw new Error("Choose a priority from 0 to 4.");
    changes.priority = input.priority_id;
  }
  if (provided(input.estimate)) {
    if (
      typeof input.estimate !== "number" ||
      !Number.isInteger(input.estimate) ||
      input.estimate < 0 ||
      input.estimate > 10000
    )
      throw new Error("Enter a valid estimate.");
    changes.estimate = input.estimate;
  }
  if (provided(input.labels)) {
    if (!Array.isArray(input.labels) || input.labels.length > 100)
      throw new Error("Choose at most 100 label UUIDs.");
    // Match upstream's empty-fields-preserve behavior. Empty array does not clear labels.
    if (input.labels.length)
      changes.labelIds = input.labels.map((v) => id(v, "label"));
  }
  if (provided(input.due_date)) {
    const raw = text(input.due_date, "due date", 64),
      day = raw.slice(0, 10);
    if (
      !/^\d{4}-\d{2}-\d{2}(?:$|T)/.test(raw) ||
      !Number.isFinite(Date.parse(raw)) ||
      new Date(day).toISOString().slice(0, 10) !== day
    )
      throw new Error("Use a valid due date in YYYY-MM-DD format.");
    changes.dueDate = day;
  }
  const comment = commenting
    ? text(input.body, "comment", 100000, true)
    : undefined;
  if (provided(input.user_id))
    throw new Error(
      "Leave User empty. Comments are posted as your connected user.",
    );
  if (!creating && !commenting && !Object.keys(changes).length)
    throw new Error("Choose at least one field to update.");
  let target: Record<string, any> | undefined;
  if (reference) {
    target = await get(reference);
    if (target.team_id !== team)
      throw new Error("The issue does not belong to the selected team.");
  }
  const operation = commenting
    ? "commentCreate"
    : creating
      ? "issueCreate"
      : "issueUpdate";
  const response = await gql(
    commenting
      ? "mutation JarvisCreateComment($input: CommentCreateInput!) { commentCreate(input: $input) { success lastSyncId comment { id body url createdAt updatedAt } } }"
      : creating
        ? `mutation JarvisCreateIssue($input: IssueCreateInput!) { issueCreate(input: $input) { success lastSyncId issue { ${ISSUE_FIELDS} } } }`
        : `mutation JarvisUpdateIssue($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success lastSyncId issue { ${ISSUE_FIELDS} } } }`,
    commenting
      ? { input: { issueId: target!.id, body: comment } }
      : { ...(target ? { id: target.id } : {}), input: changes },
    true,
  );
  try {
    const result = response[operation];
    if (
      !record(result) ||
      result.success !== true ||
      typeof result.lastSyncId !== "number"
    )
      throw new Error();
    if (commenting) {
      const c = result.comment;
      if (
        !record(c) ||
        !UUID.test(c.id) ||
        c.body !== comment ||
        typeof c.url !== "string"
      )
        throw new Error();
      return {
        success: true,
        lastSyncId: result.lastSyncId,
        comment: {
          id: c.id,
          body: c.body,
          url: c.url,
          createdAt: c.createdAt,
          updatedAt: c.updatedAt,
        },
      };
    }
    const value = issue(result.issue);
    if (value.team_id !== team || (target && value.id !== target.id))
      throw new Error();
    // Match the upstream write envelope while keeping its issue's stable fields.
    return {
      success: true,
      lastSyncId: result.lastSyncId,
      issue: {
        id: value.id,
        identifier: value.identifier,
        title: value.title,
        description: value.description,
        url: value.url,
        priority: value.priority,
        dueDate: value.due_date,
        createdAt: value.created_at,
        updatedAt: value.updated_at,
      },
    };
  } catch {
    throw new Error(
      "Linear did not confirm this change. Check the issue before trying again.",
    );
  }
}
