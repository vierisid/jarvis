import type { JarvisConfig } from "../config/types";
import { freshLinearConnection } from "./linear-refresh";
import { linearGraphql } from "../workflows/runtime/managed-linear";
/** One bounded page, using the same renewed grant as workflow execution. */
export async function linearTeamOptions(
  config: JarvisConfig,
  cursor: string | null,
  request: typeof fetch = fetch,
) {
  if (cursor && (cursor.length > 2048 || /[\x00-\x1f\x7f]/.test(cursor)))
    throw new Error("Invalid Linear page cursor.");
  const c = await freshLinearConnection(config, request);
  const data = await linearGraphql(
    c.access_token,
    "query JarvisTeams($after: String) { teams(first: 100, after: $after) { nodes { id name key } pageInfo { hasNextPage endCursor } } }",
    { after: cursor },
    request,
  );
  const page = data.teams;
  if (
    !page ||
    !Array.isArray(page.nodes) ||
    page.nodes.length > 100 ||
    typeof page.pageInfo?.hasNextPage !== "boolean" ||
    (page.pageInfo.endCursor !== null &&
      (typeof page.pageInfo.endCursor !== "string" ||
        page.pageInfo.endCursor.length > 2048)) ||
    (page.pageInfo.hasNextPage && !page.pageInfo.endCursor)
  )
    throw new Error(
      "Could not load Linear teams. Try again or enter a team ID.",
    );
  const options = page.nodes.map((v: any) => {
    if (
      !v ||
      typeof v.id !== "string" ||
      !/^[a-f0-9-]{36}$/i.test(v.id) ||
      typeof v.name !== "string" ||
      typeof v.key !== "string"
    )
      throw new Error("Linear returned an invalid team.");
    return { value: v.id, label: (v.name + " (" + v.key + ")").slice(0, 200) };
  });
  return {
    options,
    next_cursor: page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null,
  };
}
