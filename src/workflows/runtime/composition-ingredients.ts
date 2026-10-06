import { createHash } from 'node:crypto';
import { walkFlowNodes } from '../db/flow-graph';
import type { FlowTriggerNode } from '../db/repos/flow-version';
import type { PieceCatalogEntry, PieceLookup } from './piece-catalog';

/** Selection identities are distinct from names and free-form user prose. */
export type CompositionIngredient =
  | { kind: 'connection'; id: string; pieceName: string; pieceVersion: string; required: boolean }
  | { kind: 'library-action'; id: string; actionName: string; pieceVersion: string; actionVersion: string; required: boolean };
/** Only the server may add a connection binding. No credential values or metadata. */
export type ResolvedCompositionIngredient = CompositionIngredient & { externalId?: string; authRequired?: boolean };
export const INGREDIENT_LIMITS = { count: 64, idChars: 256, versionChars: 128 } as const;

export function parseCompositionIngredients(value: unknown): CompositionIngredient[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > INGREDIENT_LIMITS.count) throw new Error('Select at most 64 composition ingredients');
  const seen = new Set<string>();
  return value.map(raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid ingredient');
    const keys = raw.kind === 'connection' ? ['kind', 'id', 'pieceName', 'pieceVersion', 'required']
      : raw.kind === 'library-action' ? ['kind', 'id', 'actionName', 'pieceVersion', 'actionVersion', 'required'] : [];
    if (!keys.length || Object.keys(raw).some(k => !keys.includes(k)) || keys.some(k => !Object.hasOwn(raw, k))) throw new Error('Invalid ingredient fields');
    if (typeof raw.required !== 'boolean') throw new Error('Ingredient required must be a boolean');
    for (const key of keys.filter(k => !['kind', 'required'].includes(k))) {
      const limit = key.endsWith('Version') ? INGREDIENT_LIMITS.versionChars : INGREDIENT_LIMITS.idChars;
      if (typeof raw[key] !== 'string' || !raw[key].trim() || raw[key].length > limit || /[\u0000-\u001f]/.test(raw[key])) throw new Error('Invalid ingredient identity or version');
    }
    if (raw.kind === 'library-action' && !/^[a-f0-9]{64}$/.test(raw.actionVersion)) throw new Error('Invalid action contract version');
    const identity = JSON.stringify([raw.kind, raw.id, raw.actionName]);
    if (seen.has(identity)) throw new Error('Duplicate ingredient');
    seen.add(identity);
    // Canonical key order makes JSON replay comparisons independent of wire key order.
    return raw.kind === 'connection'
      ? { kind: raw.kind, id: raw.id, pieceName: raw.pieceName, pieceVersion: raw.pieceVersion, required: raw.required }
      : { kind: raw.kind, id: raw.id, actionName: raw.actionName, pieceVersion: raw.pieceVersion, actionVersion: raw.actionVersion, required: raw.required };
  });
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, canonical(v)]));
  return value;
}
/** Actions have no independent semver. Pin the action contract plus its package version. */
export function actionContractVersion(piece: PieceCatalogEntry, actionName: string): string {
  return createHash('sha256').update(JSON.stringify(canonical({ auth: piece.auth, action: piece.actions[actionName] }))).digest('hex');
}
export const ingredientPiece = (selection: CompositionIngredient) => selection.kind === 'connection' ? selection.pieceName : selection.id;
export const ingredientLabel = (selection: CompositionIngredient) => selection.kind === 'connection' ? `connection ${selection.id}` : `library action ${selection.id}/${selection.actionName}`;

/** Apply after structural validation, including all loop bodies and router branches. */
export function ingredientUsageIssues(trigger: unknown, selections: readonly ResolvedCompositionIngredient[], pieces: PieceLookup): string[] {
  const nodes = walkFlowNodes(trigger as FlowTriggerNode).filter(n => n.type === 'PIECE' || n.type === 'PIECE_TRIGGER');
  const issues: string[] = [];
  for (const selection of selections) {
    const matching = nodes.filter(n => n.settings?.pieceName === ingredientPiece(selection));
    const used = selection.kind === 'library-action'
      ? matching.some(n => n.type === 'PIECE' && n.settings?.actionName === selection.actionName)
      : matching.some(n => {
        const piece = pieces.get(ingredientPiece(selection));
        const operation = n.type === 'PIECE' ? piece?.actions[n.settings?.actionName ?? ''] : piece?.triggers?.[n.settings?.triggerName ?? ''];
        if (!piece?.auth || !operation || operation.requireAuth === false) return false;
        const auth = n.settings?.input?.auth;
        return typeof auth === 'string' && !!selection.externalId &&
          [ `{{connections.${selection.externalId}}}`, `{{connections['${selection.externalId}']}}` ].includes(auth);
      });
    if (selection.kind === 'library-action' && selection.authRequired) {
      const bindings = selections.filter(s => s.kind === 'connection' && s.pieceName === selection.id && s.externalId)
        .flatMap(s => [`{{connections.${s.externalId}}}`, `{{connections['${s.externalId}']}}`]);
      if (matching.some(n => n.type === 'PIECE' && n.settings?.actionName === selection.actionName && !bindings.includes(String(n.settings?.input?.auth)))) {
        issues.push(`Selected ingredient ${ingredientLabel(selection)} requires a selected, compatible connection as its auth binding.`);
      }
    }
    if (selection.required && !used) issues.push(`Selected ingredient ${ingredientLabel(selection)} must be used${selection.kind === 'connection' ? ' as the matching piece auth binding' : ''}, or report why the request is blocked.`);
    // A wrong version in the graph must not claim a different pin, even though
    // the current engine resolves one installed version per piece.
    if (matching.some(n => n.settings?.pieceVersion !== undefined && n.settings.pieceVersion !== selection.pieceVersion)) issues.push(`Selected ingredient ${ingredientLabel(selection)} has a conflicting piece version in the graph.`);
  }
  return issues;
}
