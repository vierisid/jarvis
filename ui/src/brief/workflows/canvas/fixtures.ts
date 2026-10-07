import type {
  FlowStepNode,
  FlowVersion,
  PieceCatalogEntry,
} from "../../../v2/rooms/workflows/useWorkflowEditor";
import type { WorkflowRequest } from "../../../v2/rooms/workflows/WorkflowEditorEnvironment";
const piece = (
  name: string,
  title: string,
  input: Record<string, unknown> = {},
): FlowStepNode => ({
  name,
  type: "PIECE",
  displayName: title,
  settings: { pieceName: "fixture-tools", actionName: "prepare", input },
});
export const CANVAS_CATALOG: PieceCatalogEntry[] = [
  {
    name: "fixture-tools",
    displayName: "Preview tools",
    description: "Fixture catalog, never executed",
    actions: [
      {
        name: "prepare",
        displayName: "Prepare output",
        description: "Isolated preview action",
        inputSchema: {
          fields: [
            {
              name: "instructions",
              type: "long_text",
              label: "Instructions",
              required: true,
            },
            {
              name: "priority",
              type: "enum",
              label: "Priority",
              required: false,
              options: [
                { label: "Normal", value: "normal" },
                { label: "High", value: "high" },
              ],
            },
            {
              name: "payload",
              type: "json",
              label: "Payload",
              required: false,
            },
          ],
        },
        sampleData: { content: "Illustrative prepared output" },
      },
    ],
    triggers: [],
  },
];
export function makeCanvasFixture(advanced = false) {
  const trigger: FlowStepNode = {
    name: "trigger",
    type: "EMPTY",
    displayName: "Meeting ends",
    nextAction: piece("notes", "Read meeting notes", {
      instructions: "Read notes from the latest meeting with Alex.",
    }),
  };
  const draft = piece("draft", "Draft the follow-up", {
    instructions:
      "Write a concise follow-up from the meeting notes. Summarise the agreed next step. Flag an unconfirmed date instead of inventing one.",
    priority: "normal",
    payload: { source: "{{notes.content}}" },
  });
  trigger.nextAction!.nextAction = draft;
  draft.nextAction = piece("review", "Review before sending", {
    instructions: "Ask for review of the pilot date.",
  });
  draft.nextAction.nextAction = piece("send", "Send through Gmail", {
    instructions: "Use the reviewed follow-up.",
  });
  if (advanced)
    draft.nextAction = {
      name: "router",
      displayName: "Choose a follow-up path",
      type: "ROUTER",
      settings: {
        executionType: "EXECUTE_FIRST_MATCH",
        branches: [
          {
            branchName: "Interested",
            branchType: "CONDITION",
            conditions: [
              [
                {
                  firstValue: "{{draft.interested}}",
                  operator: "BOOLEAN_IS_TRUE",
                },
              ],
            ],
          },
          { branchName: "Other", branchType: "FALLBACK" },
        ],
      },
      children: [
        {
          name: "loop",
          type: "LOOP_ON_ITEMS",
          displayName: "Each meeting attendee",
          settings: { items: "{{notes.attendees}}" },
          firstLoopAction: piece("nested", "Prepare attendee summary", {
            instructions: "Keep each summary concise.",
          }),
        },
        piece("alternative", "Keep a draft", {
          instructions: "Keep for later.",
        }),
      ],
      nextAction: piece("unconfigured", "Unconfigured action"),
    };
  if (advanced)
    trigger.nextAction!.nextAction!.nextAction!.nextAction!.settings = {};
  let version: FlowVersion = {
    id: advanced ? "advanced-v1" : "meeting-v3",
    flowId: "meeting",
    displayName: advanced
      ? "Meeting follow-ups · branches and loops"
      : "Meeting follow-ups",
    trigger,
    state: "DRAFT",
    valid: true,
    schemaVersion: "1",
    agentIds: [],
    connectionIds: [],
    notes: [],
    backupFiles: {},
    sampleData: {
      notes: { content: "Alex wants to begin a pilot." },
      draft: { content: "Our pilot: next steps" },
    },
    sampleInput: null,
    created: 1791363600000,
    updated: 1791363600000,
  };
  let uiMeta = {
    schema: 1,
    positions: {},
    orphans: advanced
      ? [
          {
            node: {
              ...piece("orphan", "Disconnected preparation", {
                instructions: "Draft without a connected predecessor.",
              }),
              nextAction: piece("orphan_child", "Disconnected second step", {
                instructions: "Keep the whole detached chain editable.",
              }),
            },
            x: 1020,
            y: 140,
          },
        ]
      : [],
  };
  const requests: { path: string; method: string; body: unknown }[] = [];
  const response = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  const request: WorkflowRequest = async (input, init) => {
    const path = String(input),
      method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    requests.push({ path, method, body });
    if (method === "GET" && path === "/api/workflows/pieces")
      return response(CANVAS_CATALOG);
    if (method === "GET" && path === "/api/workflows/pieces/library")
      return response({ managed: true, entries: [] });
    if (method === "GET" && path === "/api/workflows/connections")
      return response({ connections: [] });
    if (method === "GET" && path === "/api/workflows")
      return response([{ id: "meeting", displayName: version.displayName }]);
    if (method === "GET" && path.includes("/runs?")) return response([]);
    if (method === "GET" && path === "/api/workflows/meeting")
      return response({
        flow: { id: "meeting" },
        latestDraft: version,
        published: null,
        uiMeta,
      });
    if (
      method === "PATCH" &&
      path === `/api/workflows/meeting/versions/${version.id}`
    ) {
      version = {
        ...version,
        displayName: body.displayName,
        trigger: body.trigger,
      };
      uiMeta = body.uiMeta;
      return response(version);
    }
    for (const [url, field, value] of [
      ["sample-input", "sampleInput", "input"],
      ["sample-data", "sampleData", "output"],
    ] as const) {
      const prefix = `/api/workflows/meeting/versions/${version.id}/${url}/`;
      if (method === "PATCH" && path.startsWith(prefix)) {
        const name = decodeURIComponent(path.slice(prefix.length));
        const values = { ...version[field] };
        if (body[value] === null) delete values[name];
        else values[name] = body[value];
        version = { ...version, [field]: values };
        return response({ [field]: values });
      }
    }
    // No network fallback, package install, credentials or execution even for
    // advanced controls using the real editor. These are local examples only.
    return response(
      { error: "This isolated preview cannot execute or install anything." },
      403,
    );
  };
  return {
    request,
    requests,
    versionId: version.id,
    snapshot: () => structuredClone({ version, uiMeta }),
  };
}
