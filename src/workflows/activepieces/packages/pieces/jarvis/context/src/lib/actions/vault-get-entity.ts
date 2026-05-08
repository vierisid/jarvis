import { createAction, Property } from "@activepieces/pieces-framework";
import { postContext } from "../shared";

interface VaultEntitySnapshot {
  id: string;
  type: string;
  name: string;
  properties: Record<string, unknown> | null;
  createdAt: number;
  updatedAt: number;
}

export const vaultGetEntityAction = createAction({
  name: "vault_get_entity",
  displayName: "Vault: get entity by id",
  description: "Fetch a single vault entity by id. Returns null if not found.",
  props: {
    id: Property.ShortText({
      displayName: "Entity id",
      required: true,
    }),
  },
  async run(context) {
    const id = context.propsValue["id"];
    if (typeof id !== "string" || id.length === 0) {
      throw new Error("jarvis-context.vault_get_entity: id is required");
    }
    return await postContext<VaultEntitySnapshot | null>(
      context.server.apiUrl,
      context.server.token,
      "/v1/jarvis/context/vault-get-entity",
      { id },
    );
  },
});
