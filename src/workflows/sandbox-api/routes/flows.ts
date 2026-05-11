/**
 * `GET /v1/engine/populated-flows?externalIds=` -- backs the engine's
 * `context.flows.list({externalIds})` call. The engine deserializes the body
 * as `SeekPage<PopulatedFlow>` from `@activepieces/shared`.
 *
 * Today we ship a minimal but upstream-compatible response: the published
 * version is materialized into the `version` field directly. Step E (the
 * FlowVersion shape adapter) tightens the version field's exact field-by-field
 * alignment with upstream; this route just trusts whatever shape we have stored
 * for `flow_version.trigger` etc.
 *
 * Filter semantics: when no externalIds query param is present, return every
 * flow in the default project (pages of up to 50 -- single-tenant, in practice
 * far below the cap).
 */

import { listFlows, parseFlowMetadata } from "../../db/repos/flow";
import { getFlowVersion } from "../../db/repos/flow-version";
import { json, err, type RouteContext, type RouteHandler } from "./shared";

export const populatedFlowsRoute: RouteHandler = async (ctx: RouteContext) => {
  const url = new URL(ctx.req.url);
  const externalIdsRaw = url.searchParams.get("externalIds");
  const externalIds = externalIdsRaw
    ? externalIdsRaw.split(",").map((s) => s.trim()).filter(Boolean)
    : null;

  const projectId = ctx.claims.projectId;
  const allFlows = listFlows(projectId);
  const filtered = externalIds
    ? allFlows.filter((f) => externalIds.includes(f.external_id))
    : allFlows;

  const data = filtered
    .map((flow) => {
      const versionId = flow.published_version_id;
      if (!versionId) return null;
      const version = getFlowVersion(versionId);
      if (!version) return null;
      return {
        id: flow.id,
        externalId: flow.external_id,
        projectId: flow.project_id,
        ownerId: flow.owner_id,
        folderId: flow.folder_id,
        status: flow.status,
        publishedVersionId: flow.published_version_id,
        metadata: parseFlowMetadata(flow),
        operationStatus: flow.operation_status,
        timeSavedPerRun: flow.time_saved_per_run,
        templateId: flow.template_id,
        // schemaVersion is part of the version (matches upstream FlowVersion.schemaVersion).
        version,
        created: new Date(flow.created).toISOString(),
        updated: new Date(flow.updated).toISOString(),
      };
    })
    .filter((p): p is NonNullable<typeof p> => p !== null);

  return json({ data, next: undefined });
};

export const _unused = err; // keep import shape consistent across route files
