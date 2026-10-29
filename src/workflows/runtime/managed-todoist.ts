/** Four qualified task operations on Todoist API v1. No implicit write retries. */
export const MANAGED_TODOIST_ACTIONS = [
  "create_task",
  "update_task",
  "find_task",
  "mark_task_completed",
] as const;
const record = (v: unknown): v is Record<string, any> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const provided = (v: unknown) => v !== undefined && v !== null && v !== "";
export function todoistId(v: unknown): string {
  if (typeof v !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(v))
    throw new Error("Enter a valid Todoist ID or workflow variable.");
  return v;
}
function text(
  v: unknown,
  name: string,
  max: number,
  multiline = false,
): string {
  if (
    typeof v !== "string" ||
    !v.trim() ||
    v.length > max ||
    (multiline ? /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/ : /[\x00-\x1f\x7f]/).test(v)
  )
    throw new Error("Enter a valid " + name + ".");
  return v.trim();
}
export function managedTodoistInput(
  input: unknown,
): Record<string, unknown> | null {
  return record(input) &&
    record(input.auth) &&
    input.auth.jarvis_managed === "todoist"
    ? input
    : null;
}
/** Paths are selected by the adapter, never supplied as URLs by a workflow. */
export async function todoistRequest(
  token: string,
  path: string,
  request: typeof fetch = fetch,
  body?: Record<string, unknown>,
  empty = false,
): Promise<any> {
  const writing = body !== undefined;
  let response: Response;
  try {
    response = await request("https://api.todoist.com/api/v1" + path, {
      method: writing ? "POST" : "GET",
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      headers: {
        Authorization: "Bearer " + token,
        Accept: "application/json",
        ...(writing ? { "Content-Type": "application/json" } : {}),
      },
      ...(writing ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new Error(
      writing
        ? "Todoist's result is uncertain. Check the task before trying again."
        : "Todoist could not be reached. Try again shortly.",
    );
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(
      response.status === 401
        ? "Todoist refused access. Reconnect Todoist."
        : response.status === 429
          ? "Todoist is rate limiting requests. Try again later."
          : "Todoist refused this request. Check access and the task before retrying.",
    );
  }
  const reader = response.body?.getReader();
  if (!reader) {
    if (empty) return null;
    throw new Error("Todoist returned an empty response.");
  }
  try {
    const parts: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 1048576) throw Error();
      parts.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const p of parts) {
      bytes.set(p, offset);
      offset += p.length;
    }
    const raw = new TextDecoder().decode(bytes).trim();
    if (!raw && empty) return null;
    const data = JSON.parse(raw);
    if (record(data) && ("error" in data || "error_code" in data))
      throw Error();
    if (
      empty &&
      data !== null &&
      data !== true &&
      (!record(data) || Object.keys(data).length)
    )
      throw Error();
    return data;
  } catch {
    throw new Error(
      "Todoist returned an invalid response. Check the task before trying again.",
    );
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
function task(v: unknown): Record<string, any> {
  try {
    if (
      !record(v) ||
      typeof v.content !== "string" ||
      typeof v.description !== "string" ||
      typeof v.checked !== "boolean" ||
      !Number.isInteger(v.priority) ||
      v.priority < 1 ||
      v.priority > 4 ||
      !Array.isArray(v.labels) ||
      !v.labels.every((x: unknown) => typeof x === "string")
    )
      throw Error();
    const id = todoistId(v.id),
      project = todoistId(v.project_id);
    const optionalId = (x: unknown) =>
      x === null || x === undefined ? null : todoistId(x);
    let due = null;
    if (v.due !== null && v.due !== undefined) {
      if (
        !record(v.due) ||
        typeof v.due.date !== "string" ||
        typeof v.due.is_recurring !== "boolean" ||
        typeof v.due.string !== "string"
      )
        throw Error();
      due = {
        date: v.due.date,
        string: v.due.string,
        is_recurring: v.due.is_recurring,
        timezone: typeof v.due.timezone === "string" ? v.due.timezone : null,
      };
    }
    return {
      id,
      content: v.content,
      description: v.description,
      project_id: project,
      section_id: optionalId(v.section_id),
      parent_id: optionalId(v.parent_id),
      labels: v.labels,
      priority: v.priority,
      checked: v.checked,
      due,
    };
  } catch {
    throw new Error("Todoist returned an invalid task.");
  }
}
export function todoistPage(v: unknown): {
  results: any[];
  next_cursor: string | null;
} {
  if (
    !record(v) ||
    !Array.isArray(v.results) ||
    v.results.length > 100 ||
    (v.next_cursor !== null &&
      (typeof v.next_cursor !== "string" ||
        !v.next_cursor ||
        v.next_cursor.length > 2048))
  )
    throw new Error("Todoist returned an invalid page.");
  return { results: v.results, next_cursor: v.next_cursor };
}
function dueFields(value: unknown): Record<string, string> {
  if (!provided(value)) return {};
  const v = text(value, "due date", 200);
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    if (
      !Number.isFinite(Date.parse(v)) ||
      new Date(v).toISOString().slice(0, 10) !== v
    )
      throw Error("Enter a valid calendar date.");
    return { due_date: v };
  }
  if (/^\d{4}-\d{2}-\d{2}T/.test(v)) {
    if (
      !/(Z|[+-]\d{2}:\d{2})$/.test(v) ||
      !Number.isFinite(Date.parse(v)) ||
      new Date(v.slice(0, 10)).toISOString().slice(0, 10) !== v.slice(0, 10)
    )
      throw Error("Use an RFC3339 date and time with a timezone.");
    return { due_datetime: v };
  }
  return { due_string: v };
}
export async function runManagedTodoistAction(
  action: string,
  input: Record<string, unknown>,
  request: typeof fetch = fetch,
): Promise<unknown> {
  if (!(MANAGED_TODOIST_ACTIONS as readonly string[]).includes(action))
    throw Error(
      "This Todoist action has not been enabled for the managed connection.",
    );
  if (
    !record(input.auth) ||
    typeof input.auth.access_token !== "string" ||
    !input.auth.access_token
  )
    throw Error("Reconnect Todoist.");
  const token = input.auth.access_token;
  const get = async (id: string) => {
    const v = task(await todoistRequest(token, "/tasks/" + id, request));
    if (v.id !== id || v.checked)
      throw Error("Todoist did not return the requested active task.");
    return v;
  };
  if (action === "find_task") {
    const name = text(input.name, "task title", 500),
      project = provided(input.project_id) ? todoistId(input.project_id) : null;
    const matches: Record<string, any>[] = [],
      seen = new Set<string>();
    let cursor: string | null = null;
    for (let pageNumber = 0; pageNumber < 5; pageNumber++) {
      const params = new URLSearchParams({ limit: "100" });
      if (project) params.set("project_id", project);
      if (cursor) params.set("cursor", cursor);
      const page = todoistPage(
        await todoistRequest(token, "/tasks?" + params, request),
      );
      for (const raw of page.results) {
        const v = task(raw);
        if (v.checked || (project && v.project_id !== project))
          throw Error("Todoist returned tasks outside the requested search.");
        if (v.content === name && !matches.some((m) => m.id === v.id))
          matches.push(v);
      }
      if (matches.length > 1)
        throw Error(
          "More than one task has this exact title. Choose a project or use a task ID from Todoist.",
        );
      if (!page.next_cursor) {
        if (matches.length === 1) return matches[0];
        throw Error("No active task matches this exact title.");
      }
      if (seen.has(page.next_cursor))
        throw Error("Todoist repeated a page cursor. Try again later.");
      seen.add(page.next_cursor);
      cursor = page.next_cursor;
    }
    throw Error(
      "This search exceeds 500 tasks. Choose a smaller project or use a task ID from Todoist.",
    );
  }
  if (action === "mark_task_completed") {
    const id = todoistId(input.task_id),
      target = await get(id);
    await todoistRequest(token, "/tasks/" + id + "/close", request, {}, true);
    const recurring = !!target.due?.is_recurring;
    return {
      success: true,
      task_id: id,
      completed: !recurring,
      recurrence_advanced: recurring,
    };
  }
  const creating = action === "create_task",
    changes: Record<string, unknown> = {};
  if (creating || provided(input.content))
    changes.content = text(input.content, "task title", 500, true);
  if (provided(input.description))
    changes.description = text(input.description, "description", 16384, true);
  if (provided(input.labels)) {
    if (!Array.isArray(input.labels) || input.labels.length > 100)
      throw Error("Use at most 100 label names.");
    if (input.labels.length)
      changes.labels = input.labels.map((v) => text(v, "label name", 100));
  }
  if (provided(input.priority)) {
    if (
      typeof input.priority !== "number" ||
      !Number.isInteger(input.priority) ||
      input.priority < 1 ||
      input.priority > 4
    )
      throw Error("Choose a priority from 1 (normal) to 4 (urgent).");
    changes.priority = input.priority;
  }
  Object.assign(changes, dueFields(input.due_date));
  let target: Record<string, any> | null = null;
  if (creating) {
    if (provided(input.project_id))
      changes.project_id = todoistId(input.project_id);
    if (provided(input.section_id)) {
      if (!changes.project_id)
        throw Error("Choose a project before choosing a section.");
      changes.section_id = todoistId(input.section_id);
      const section = await todoistRequest(
        token,
        "/sections/" + changes.section_id,
        request,
      );
      if (
        !record(section) ||
        section.id !== changes.section_id ||
        section.project_id !== changes.project_id
      )
        throw Error("The section does not belong to the selected project.");
    }
  } else {
    const id = todoistId(input.task_id);
    if (!Object.keys(changes).length)
      throw Error(
        "Choose at least one field to update. Empty fields preserve current values.",
      );
    target = await get(id);
  }
  const result = task(
    await todoistRequest(
      token,
      creating ? "/tasks" : "/tasks/" + target!.id,
      request,
      changes,
    ),
  );
  if (
    result.checked ||
    (target &&
      (result.id !== target.id || result.project_id !== target.project_id)) ||
    (changes.project_id && result.project_id !== changes.project_id) ||
    (changes.section_id && result.section_id !== changes.section_id)
  )
    throw Error(
      "Todoist did not confirm the requested task. Check it before trying again.",
    );
  return result;
}
