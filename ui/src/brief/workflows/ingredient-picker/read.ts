import { isBriefCapabilityEnabled } from "../../../../../src/brief/capabilities";
import { ingredientKey, readIngredients, type IngredientChoice } from "./model";

const safeLabel = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 320 && !/[\u0000-\u001f]/.test(v);
// Display text is not an identity. F-08 preserves package-authored whitespace
// and may truncate a name on a space; keep pin validation independent of it.
const displayLabel = (value: unknown, fallback: string) =>
  (typeof value === "string" ? value.slice(0,320).replace(/[\u0000-\u001f\u007f]/g," ").replace(/\s+/g," ").trim() : "")
  || fallback.slice(0,320).trim();
/** Host-owned, abortable one-shot read. F-08 alone grants selectable, version-pinned entries.
 * Supplemental catalog metadata can explain uninstalled packages, never grant selection. */
export async function readIngredientCatalog(capabilities: () => unknown, signal: AbortSignal,
  request: (url: string, init?: RequestInit) => Promise<Response> = fetch): Promise<IngredientChoice[]> {
  const json = async (url: string) => {
    signal.throwIfAborted();
    if (!isBriefCapabilityEnabled(capabilities(), "compositionIngredients")) throw Error("Ingredients unavailable");
    const response = await request(url, {credentials:"same-origin",cache:"no-store",signal:AbortSignal.any([signal,AbortSignal.timeout(15_000)])});
    if (!response.ok) throw Error("Ingredients unavailable");
    const value = await response.json(); signal.throwIfAborted(); return value;
  };
  // The optional public catalog is read separately from credential-bearing APIs.
  // A catalog failure leaves discovery usable, but never invents uninstalled rows.
  const catalogRead = json("/api/workflows/pieces/library").then(value => value, () => null);
  const choices: IngredientChoice[] = [], seen = new Set<string>();
  let offset: number | null = 0;
  try {
    for (let page = 0; offset !== null && page < 100; page++) {
      const value = await json(`/api/brief/composition-ingredients?offset=${offset}`);
      if (!value || !Array.isArray(value.ingredients) || value.ingredients.length > 100
        || !(value.nextOffset === null || Number.isSafeInteger(value.nextOffset) && value.nextOffset > offset)) throw Error("Invalid ingredient page");
      // F-08 pages hold up to 100; the submitted selection bound is 64.
      for (const row of value.ingredients) {
        const selection = readIngredients([row?.selection])[0]!;
        const fallback = selection.kind === "connection" ? selection.id : `${selection.id}: ${selection.actionName}`;
        const selected = {selection,displayName:displayLabel(row.displayName,fallback)};
        const key = ingredientKey(selected.selection);
        if (seen.has(key)) throw Error("Catalog changed while reading; refresh it");
        seen.add(key);
        const piece = selected.selection.kind === "connection" ? selected.selection.pieceName : selected.selection.id;
        choices.push({key, ...selected, groupId:piece, group:piece, tab:selected.selection.kind, status:"ready"});
      }
      offset = value.nextOffset;
    }
    if (offset !== null) throw Error("Catalog is incomplete");
    const catalog = await catalogRead;
    signal.throwIfAborted();
    if (!isBriefCapabilityEnabled(capabilities(), "compositionIngredients")) throw Error("Ingredients unavailable");
    if (catalog && Array.isArray(catalog.entries) && catalog.entries.length <= 2000) {
      const names = new Map<string,string>();
      for (const e of catalog.entries) {
        if (!e || !safeLabel(e.npmPackage)) continue;
        const name = displayLabel(e.displayName,e.npmPackage);
        names.set(e.npmPackage,name);
        if (catalog.managed !== true && e.installed === null && !choices.some(c => c.groupId === e.npmPackage)) {
          choices.push({key:`package:${e.npmPackage}`,displayName:name,groupId:e.npmPackage,group:e.npmPackage,tab:"library-action",status:"uninstalled"});
        }
      }
      for (const choice of choices) choice.group = names.get(choice.groupId) ?? choice.groupId;
    }
    return choices;
  } finally { await catalogRead; }
}
