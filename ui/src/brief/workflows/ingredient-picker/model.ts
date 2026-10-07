/** Public F-08 wire selection. Never persist connection credentials or catalog internals. */
export type Ingredient =
  | { kind: "connection"; id: string; pieceName: string; pieceVersion: string; required: boolean }
  | { kind: "library-action"; id: string; actionName: string; pieceVersion: string; actionVersion: string; required: boolean };
export interface SelectedIngredient { selection: Ingredient; displayName: string }
export interface IngredientChoice {
  key: string; displayName: string; group: string; tab: "connection" | "library-action";
  selection?: Ingredient; status: "ready" | "uninstalled" | "missing-account" | "unavailable";
}
export interface IngredientCatalog {
  source: "live" | "fixture"; scopeId: string;
  state: "ready" | "loading" | "unavailable"; choices: readonly IngredientChoice[];
  refresh?: () => void;
}
export const ingredientKey = (i: Ingredient) => JSON.stringify([i.kind, i.id, i.kind === "library-action" ? i.actionName : null]);
const text = (s: unknown, max: number) => typeof s === "string" && s.length > 0 && s.length <= max && s.trim() === s && !/[\u0000-\u001f]/.test(s);
export function readIngredients(value: unknown): Ingredient[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 64) throw Error("Invalid ingredients");
  const seen = new Set<string>();
  return value.map(i => {
    if (!i || typeof i !== "object" || !["connection", "library-action"].includes(i.kind)
      || !text(i.id,256) || !text(i.pieceVersion,128) || typeof i.required !== "boolean") throw Error("Invalid ingredient");
    const connection = i.kind === "connection";
    const keys = connection ? ["kind","id","pieceName","pieceVersion","required"] : ["kind","id","actionName","pieceVersion","actionVersion","required"];
    if (Object.keys(i).some(k => !keys.includes(k)) || (connection ? !text(i.pieceName,256) : !text(i.actionName,256) || !/^[a-f0-9]{64}$/.test(i.actionVersion))) throw Error("Invalid ingredient");
    const result: Ingredient = connection
      ? {kind:"connection",id:i.id,pieceName:i.pieceName,pieceVersion:i.pieceVersion,required:i.required}
      : {kind:"library-action",id:i.id,actionName:i.actionName,pieceVersion:i.pieceVersion,actionVersion:i.actionVersion,required:i.required};
    const key = ingredientKey(result);
    if (seen.has(key)) throw Error("Duplicate ingredient");
    seen.add(key); return result;
  });
}
export function readSelected(value: unknown): SelectedIngredient[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw Error("Invalid selection");
  const pins = readIngredients(value.map(v => v?.selection));
  return value.map((v,i) => {
    if (!text(v.displayName,320)) throw Error("Invalid ingredient label");
    return {selection:pins[i]!,displayName:v.displayName};
  });
}
export const sameIngredients = (a: unknown, b: unknown) => JSON.stringify(readIngredients(a)) === JSON.stringify(readIngredients(b));
