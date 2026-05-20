import { createAction, Property } from "@activepieces/pieces-framework";
import { postContext } from "../shared";

const VAULT_TYPES = ["person", "project", "tool", "place", "concept", "event"] as const;

interface VaultEntitySnapshot {
  id: string;
  type: string;
  name: string;
  properties: Record<string, unknown> | null;
  createdAt: number;
  updatedAt: number;
}

export const vaultSearchAction = createAction({
  name: "vault_search",
  displayName: "Vault: search entities",
  description:
    "Find vault entities by name fragment and/or type. Returns up to `limit` entities ordered by recency.",
  // Bare array of VaultEntitySnapshot, ordered most-recent first.
  // Declared so a LOOP_ON_ITEMS step downstream can pick this step's
  // output as its iteration source -- the picker reads array-ness and
  // emits a single "(N items)" row that inserts `{{step}}`. Each
  // entity carries `id`, `type`, `name`, an entity-specific `properties`
  // bag, and timestamps.
  outputSample: [
    {
      id: "ent_01HX...",
      type: "person",
      name: "Alice Smith",
      properties: { email: "alice@example.com" },
      createdAt: 1716200000000,
      updatedAt: 1716200000000,
    },
  ],
  props: {
    query: Property.ShortText({
      displayName: "Name contains",
      description: "Fragment to match against entity name (case-insensitive).",
      required: false,
    }),
    type: Property.StaticDropdown({
      displayName: "Entity type",
      required: false,
      options: {
        disabled: false,
        options: VAULT_TYPES.map((v) => ({ value: v, label: capitalize(v) })),
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
    const q = context.propsValue["query"];
    const t = context.propsValue["type"];
    const l = context.propsValue["limit"];
    if (typeof q === "string" && q.length > 0) body["query"] = q;
    if (typeof t === "string" && (VAULT_TYPES as readonly string[]).includes(t)) body["type"] = t;
    if (typeof l === "number" && Number.isFinite(l) && l >= 0) body["limit"] = Math.floor(l);

    return await postContext<VaultEntitySnapshot[]>(
      context.server.apiUrl,
      context.server.token,
      "/v1/jarvis/context/vault-search",
      body,
    );
  },
});

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}
