import { afterEach, beforeEach, expect, test } from "bun:test";
import { closeWorkflowDb, getWorkflowDb, initWorkflowDb } from "../db";
import { CompositionIngredients } from "../db/repos/composition-ingredients";
import { PieceCatalog, userPieces, type PieceCatalogEntry } from "../runtime/piece-catalog";
import { createWorkflowRoutes } from "./routes";

beforeEach(() => initWorkflowDb(":memory:"));
afterEach(() => closeWorkflowDb());

const entry = (name: string): PieceCatalogEntry => ({ name, displayName: name, description: "", actions: {}, triggers: {} }) as unknown as PieceCatalogEntry;
const catalog = new PieceCatalog([
  entry("@activepieces/piece-slack"),
  entry("@jarvispieces/piece-jarvis-test"),
  entry("@jarvispieces/piece-jarvis-validate"),
  entry("@jarvispieces/piece-jarvis-ask"),
]);

test("the piece picker does not offer the engine's test fixtures, but the engine still has them", async () => {
  const routes = createWorkflowRoutes({ pieceRegistry: catalog });
  const res = await routes["/api/workflows/pieces"]!.GET!(new Request("http://x/api/workflows/pieces"));
  const names = ((await res.json()) as Array<{ name: string }>).map((p) => p.name);
  expect(names).toEqual(["@activepieces/piece-slack", "@jarvispieces/piece-jarvis-ask"]);
  // Saved workflows that name a fixture keep resolving it.
  expect(catalog.get("@jarvispieces/piece-jarvis-validate")).not.toBeNull();
  expect(userPieces(catalog.list()).map((p) => p.name)).toEqual(names);
});

test("the Brief ingredient list does not offer a test fixture's actions", () => {
  const withAction = (name: string) => ({ ...entry(name), version: "0.0.1",
    actions: { go: { name: "go", displayName: "Go", description: "" } } }) as unknown as PieceCatalogEntry;
  const pieces = new PieceCatalog([withAction("@activepieces/piece-slack"), withAction("@jarvispieces/piece-jarvis-validate"), withAction("@jarvispieces/piece-jarvis-test")]);
  const listed = new CompositionIngredients(getWorkflowDb(), pieces).list().ingredients.map((i) => i.selection.id);
  expect(listed).toEqual(["@activepieces/piece-slack"]);
});
