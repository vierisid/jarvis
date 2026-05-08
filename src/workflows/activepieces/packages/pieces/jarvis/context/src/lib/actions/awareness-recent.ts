import { createAction, Property } from "@activepieces/pieces-framework";
import { postContext } from "../shared";

interface AwarenessActivitySnapshot {
  id: string;
  appName: string | null;
  windowTitle: string | null;
  url: string | null;
  startTime: number;
  endTime: number | null;
  summary: string | null;
}

export const awarenessRecentAction = createAction({
  name: "awareness_recent",
  displayName: "Awareness: recent activity",
  description:
    "Return recent awareness activities (foreground app, window title, URL, optional summary), most recent first.",
  props: {
    limit: Property.Number({
      displayName: "Limit",
      required: false,
      defaultValue: 25,
    }),
    since: Property.Number({
      displayName: "Since (epoch ms)",
      description: "Optional cutoff. Only items after this timestamp are returned.",
      required: false,
    }),
  },
  async run(context) {
    const body: Record<string, unknown> = {};
    const l = context.propsValue["limit"];
    const s = context.propsValue["since"];
    if (typeof l === "number" && Number.isFinite(l) && l >= 0) body["limit"] = Math.floor(l);
    if (typeof s === "number" && Number.isFinite(s) && s >= 0) body["since"] = Math.floor(s);

    return await postContext<AwarenessActivitySnapshot[]>(
      context.server.apiUrl,
      context.server.token,
      "/v1/jarvis/context/awareness-recent",
      body,
    );
  },
});
