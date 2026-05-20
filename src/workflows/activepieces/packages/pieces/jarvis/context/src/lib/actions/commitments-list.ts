import { createAction, Property } from "@activepieces/pieces-framework";
import { postContext } from "../shared";

const COMMITMENT_STATUSES = ["pending", "in_progress", "completed", "failed"] as const;

interface CommitmentSnapshot {
  id: string;
  description: string;
  status: string;
  dueAt: number | null;
  priority: string;
  createdAt: number;
}

export const commitmentsListAction = createAction({
  name: "commitments_list",
  displayName: "Commitments: list",
  description: "List commitments, optionally filtered by status.",
  // Bare array of CommitmentSnapshot. `status` is one of
  // pending|in_progress|completed|failed; `priority` is the user's
  // tier (low/normal/high); `dueAt` is null when the commitment is
  // open-ended.
  outputSample: [
    {
      id: "com_01HX...",
      description: "Reply to Bob about the proposal",
      status: "pending",
      dueAt: 1716286400000,
      priority: "normal",
      createdAt: 1716200000000,
    },
  ],
  props: {
    status: Property.StaticDropdown({
      displayName: "Status",
      required: false,
      options: {
        disabled: false,
        options: [
          { value: "pending", label: "Pending" },
          { value: "in_progress", label: "In progress" },
          { value: "completed", label: "Completed" },
          { value: "failed", label: "Failed" },
        ],
      },
    }),
    limit: Property.Number({
      displayName: "Limit",
      required: false,
      defaultValue: 25,
    }),
  },
  async run(context) {
    const body: Record<string, unknown> = {};
    const s = context.propsValue["status"];
    const l = context.propsValue["limit"];
    if (typeof s === "string" && (COMMITMENT_STATUSES as readonly string[]).includes(s)) {
      body["status"] = s;
    }
    if (typeof l === "number" && Number.isFinite(l) && l >= 0) body["limit"] = Math.floor(l);

    return await postContext<CommitmentSnapshot[]>(
      context.server.apiUrl,
      context.server.token,
      "/v1/jarvis/context/commitments-list",
      body,
    );
  },
});
