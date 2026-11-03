import type { JarvisConfig } from "../config/types";
import { freshTodoistConnection } from "./todoist-refresh";
import {
  todoistId,
  todoistPage,
  todoistRequest,
} from "../workflows/runtime/managed-todoist";
/** The request itself is wrong (a 400), as opposed to Todoist or the connection failing (a 502). */
export class TodoistOptionsInputError extends Error {}
/** One page of setup choices, with the same renewed grant as workflow execution. */
export async function todoistOptions(
  config: JarvisConfig,
  kind: "projects" | "sections",
  project: string | null,
  cursor: string | null,
  request: typeof fetch = fetch,
) {
  if (cursor && (cursor.length > 2048 || /[\x00-\x1f\x7f]/.test(cursor)))
    throw new TodoistOptionsInputError("Invalid Todoist cursor.");
  const params = new URLSearchParams({ limit: "100" });
  if (kind === "sections") {
    if (!project) return { options: [], next_cursor: null };
    try {
      params.set("project_id", todoistId(project));
    } catch {
      throw new TodoistOptionsInputError("Enter a valid Todoist project ID.");
    }
  }
  if (cursor) params.set("cursor", cursor);
  const c = await freshTodoistConnection(config, request);
  const page = todoistPage(
    await todoistRequest(c.access_token, "/" + kind + "?" + params, request),
  );
  const options = page.results.map((v) => {
    const id = todoistId(v?.id);
    if (
      typeof v?.name !== "string" ||
      !v.name ||
      (kind === "sections" && v.project_id !== project)
    )
      throw Error("Todoist returned invalid setup choices.");
    return { value: id, label: v.name.slice(0, 200) };
  });
  return { options, next_cursor: page.next_cursor };
}
