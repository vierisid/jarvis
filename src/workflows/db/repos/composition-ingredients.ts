import type { Database } from 'bun:sqlite';
import { DEFAULT_IDS, getWorkflowDb } from '../index';
import type { PieceLookup } from '../../runtime/piece-catalog';
import { actionContractVersion, ingredientLabel, ingredientPiece, ingredientUsageIssues,
  type CompositionIngredient, type ResolvedCompositionIngredient } from '../../runtime/composition-ingredients';

interface ConnectionMetadata {
  id: string; external_id: string; piece_name: string; type: string; status: string;
  project_id: string; owner_id: string | null;
}
// Explicit columns: this path never selects, decrypts, refreshes or serializes value/metadata.
const CONNECTION_COLUMNS = 'id, external_id, piece_name, type, status, project_id, owner_id';
const validExternalId = (id: string) => /^[\w:-]{1,256}$/.test(id) && !id.startsWith('jarvis:');
const authMatches = (declared: string, stored: string) => declared === stored ||
  (['OAUTH2', 'PLATFORM_OAUTH2', 'CLOUD_OAUTH2'].includes(declared) && ['OAUTH2', 'PLATFORM_OAUTH2', 'CLOUD_OAUTH2'].includes(stored));

/** Scoped adapter over the existing installed catalog and connection repository. */
export class CompositionIngredients {
  constructor(private readonly db: Database, private readonly pieces: PieceLookup,
    private readonly projectId: string = DEFAULT_IDS.project, private readonly ownerId: string = DEFAULT_IDS.user) {}

  resolve(selections: readonly CompositionIngredient[]): { ingredients: ResolvedCompositionIngredient[]; issues: string[] } {
    const ingredients: ResolvedCompositionIngredient[] = [], issues: string[] = [];
    for (const selection of selections) {
      const fail = (message: string) => issues.push(`Selected ingredient ${ingredientLabel(selection)}: ${message}`);
      const piece = this.pieces.get(ingredientPiece(selection));
      if (!piece || !piece.version) { fail('installed version is unavailable.'); continue; }
      if (piece.version !== selection.pieceVersion) { fail('installed piece version changed; select its current version explicitly.'); continue; }
      if (selection.kind === 'library-action') {
        const action = Object.hasOwn(piece.actions, selection.actionName) ? piece.actions[selection.actionName] : undefined;
        if (!action) { fail('action is not available in the installed piece.'); continue; }
        if (actionContractVersion(piece, selection.actionName) !== selection.actionVersion) { fail('action contract changed; select it again explicitly.'); continue; }
        if (piece.auth && action.requireAuth !== false && !selections.some(s => s.kind === 'connection' && s.pieceName === piece.name)) {
          fail('select an active connection for this authenticated action.'); continue;
        }
        ingredients.push({ ...selection, authRequired: !!piece.auth && action.requireAuth !== false });
      } else {
        const row = this.db.query<ConnectionMetadata, [string]>(`SELECT ${CONNECTION_COLUMNS} FROM app_connection WHERE id = ?`).get(selection.id);
        if (!row || row.project_id !== this.projectId || (row.owner_id !== null && row.owner_id !== this.ownerId)) { fail('connection is unavailable in this account.'); continue; }
        if (row.status !== 'ACTIVE' || row.piece_name !== piece.name) { fail('connection is inactive or belongs to a different piece.'); continue; }
        if (!piece.auth || !authMatches(piece.auth.type, row.type)) { fail('connection auth is incompatible with this piece.'); continue; }
        if (!validExternalId(row.external_id)) { fail('connection binding is unsupported; select another connection.'); continue; }
        const count = this.db.query<{ n: number }, [string, string]>('SELECT COUNT(*) AS n FROM app_connection WHERE project_id = ? AND external_id = ?').get(this.projectId, row.external_id)!.n;
        if (count !== 1) { fail('connection binding is ambiguous in this account.'); continue; }
        ingredients.push({ ...selection, externalId: row.external_id });
      }
    }
    return { ingredients, issues };
  }

  revalidate(saved: readonly ResolvedCompositionIngredient[], trigger: unknown): string[] {
    const current = this.resolve(saved), issues = [...current.issues];
    for (const selection of saved) if (selection.kind === 'connection' && current.ingredients.some(c => c.kind === 'connection' && c.id === selection.id && c.externalId !== selection.externalId)) {
      issues.push(`Selected ingredient connection ${selection.id}: account binding changed; compose a new request explicitly.`);
    }
    return [...issues, ...ingredientUsageIssues(trigger, saved, this.pieces)];
  }

  /** Safe discovery for a future selector. Only installed/versioned actions are selectable. */
  list(offset = 0, query = '') {
    const choices: Array<{ selection: CompositionIngredient; displayName: string }> = [];
    for (const piece of this.pieces.list()) {
      if (!piece.version) continue;
      for (const [actionName, action] of Object.entries(piece.actions)) choices.push({
        selection: { kind: 'library-action', id: piece.name, actionName, pieceVersion: piece.version, actionVersion: actionContractVersion(piece, actionName), required: true },
        displayName: `${piece.displayName}: ${action.displayName}`.slice(0, 320),
      });
    }
    const rows = this.db.query<ConnectionMetadata, [string, string]>(`SELECT ${CONNECTION_COLUMNS} FROM app_connection WHERE project_id = ? AND (owner_id IS NULL OR owner_id = ?) AND status = 'ACTIVE'`).all(this.projectId, this.ownerId);
    for (const row of rows) {
      const piece = this.pieces.get(row.piece_name);
      if (!piece?.version) continue;
      const selection: CompositionIngredient = { kind: 'connection', id: row.id, pieceName: piece.name, pieceVersion: piece.version, required: true };
      if (!this.resolve([selection]).issues.length) choices.push({ selection, displayName: row.external_id });
    }
    const filtered = choices.filter(c => `${c.displayName} ${c.selection.id}`.toLowerCase().includes(query.toLowerCase()))
      .sort((a, b) => JSON.stringify(a.selection).localeCompare(JSON.stringify(b.selection)));
    return { ingredients: filtered.slice(offset, offset + 100), nextOffset: offset + 100 < filtered.length ? offset + 100 : null };
  }
}

export function saveFlowIngredients(flowId: string, ingredients: readonly ResolvedCompositionIngredient[]): void {
  if (ingredients.length) getWorkflowDb().run('INSERT INTO workflow_composition_ingredients(flow_id, ingredients) VALUES (?, ?)', [flowId, JSON.stringify(ingredients)]);
}

/** Always enforced for saved selections, including when the authoring flag is disabled. */
export function flowIngredientIssues(flowId: string, trigger: unknown, pieces?: PieceLookup): string[] {
  const db = getWorkflowDb();
  const row = db.query<{ ingredients: string; project_id: string; owner_id: string | null }, [string]>(
    'SELECT i.ingredients, f.project_id, f.owner_id FROM workflow_composition_ingredients i JOIN flow f ON f.id = i.flow_id WHERE f.id = ?',
  ).get(flowId);
  if (!row) return [];
  if (!pieces) return ['Selected ingredient catalog is unavailable.'];
  try {
    const saved: ResolvedCompositionIngredient[] = JSON.parse(row.ingredients);
    return new CompositionIngredients(db, pieces, row.project_id, row.owner_id ?? DEFAULT_IDS.user).revalidate(saved, trigger);
  } catch { return ['Selected ingredient requirements are unreadable.']; }
}
