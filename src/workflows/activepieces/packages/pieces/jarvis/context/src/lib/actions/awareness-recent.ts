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
  // Bare array of AwarenessActivitySnapshot, ordered most-recent first.
  // Per-entry fields are all nullable (the observer may not have a
  // window title, or the activity may still be in progress); the
  // sample shows the typical "browser window with summary" case.
  outputSample: [
    {
      id: "act_01HX...",
      appName: "Firefox",
      windowTitle: "GitHub - pull request #42",
      url: "https://github.com/org/repo/pull/42",
      startTime: 1716200000000,
      endTime: 1716200120000,
      summary: "Reviewed PR #42 (auth refactor)",
    },
  ],
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
