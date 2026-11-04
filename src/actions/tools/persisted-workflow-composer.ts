import { PieceCatalog } from '../../workflows/runtime/piece-catalog';
import { fingerprint, snapshotComposition } from './composition-provenance';
import { createCompositionJournal } from "../../workflows/db/repos/workflow-composition";
import { composeFlow, jobSpecification, type ComposeDeps, type ComposeRequest, type ComposeResult } from "./workflow-composer";
import { getWorkflowDb } from '../../workflows/db/index';

/** An installer for one Library entry; it refreshes the live piece registry. Never grants credentials. */
export type LibraryInstaller = (id: string, signal?: AbortSignal) => Promise<void>;
/**
 * The composer's dependencies plus the approved-preinstall installer. The
 * installer is used only here, before the composer starts; composeFlow's tool
 * loop has no install tool and never receives it (#1234).
 */
export type PersistedComposeDeps = ComposeDeps & {
  installLibraryPiece?: LibraryInstaller;
  /** Per-install bound for preinstalls (default five minutes). On expiry the
   * signal passed to installLibraryPiece is aborted and the install is
   * reported as failed, so the journal always finishes. */
  installTimeoutMs?: number;
};

/** Production entrypoint for both chat and opportunity composition. Validation
 * is structural, plus the caller's job contract when one is stated; neither
 * proves semantic fidelity to a free-text job.
 */
export async function composePersistedFlow(persistedDeps: PersistedComposeDeps, input: ComposeRequest,
  /** The project the journal is recorded in: the one the composed flow will be created in (#844). */
  projectId?: string,
  /** Synchronous attachment, in the journal's creation transaction, before any provider call. */
  onJournal?: (id: string) => void,
  /**
   * Library IDs a person approved installing for this composition. They are
   * installed, in order, before the composer starts, and the composer itself
   * is given no installer: the approval named these entries, so nothing else
   * can be installed under it.
   */
  preinstall: readonly string[] = []): Promise<ComposeResult & { compositionRecordId: string; installedPieces?: string[]; alreadyInstalledPieces?: string[]; installationErrors?: string[] }> {
  const { installLibraryPiece, installTimeoutMs, ...deps } = persistedDeps;
  // Snapshot the job (including supplemental context and selected ingredients) so caller mutations cannot change intent mid-await.
  const request = { ...jobSpecification(input), signal: input.signal };
  request.signal?.throwIfAborted();
  const snapshot = snapshotComposition(deps);
  const journal = getWorkflowDb().transaction(() => {
    const record = createCompositionJournal({ ...jobSpecification(request), provenance: snapshot.provenance }, projectId);
    onJournal?.(record.id);
    return record;
  }).immediate();
  // Install only explicitly requested Library entries into the frozen discovery
  // catalog. Unrelated concurrent refreshes must not change a repair's contracts.
  const install: LibraryInstaller | undefined = installLibraryPiece && (async (id, signal) => {
    request.signal?.throwIfAborted();
    const entry = snapshot.deps.library?.find(candidate => candidate.id === id);
    if (!entry) throw new Error('Unknown Library entry');
    await installLibraryPiece(id, signal);
    // An install that finished after its bound expired is not this
    // composition's: neither journaled nor added to its catalog.
    signal?.throwIfAborted();
    const actual = deps.pieceRegistry.get(entry.npmPackage);
    if (!actual) throw new Error('Installed piece metadata is unavailable');
    const metadata = JSON.parse(JSON.stringify(actual));
    journal.recordInstalledPiece({ id, name: actual.name, version: actual.version, sha256: fingerprint(metadata) });
    request.signal?.throwIfAborted();
    signal?.throwIfAborted();
    (snapshot.deps.pieceRegistry as PieceCatalog).upsert(metadata);
  });
  const installedPieces: string[] = [], alreadyInstalledPieces: string[] = [], installationErrors: string[] = [];
  try {
    if (preinstall.length) {
      if (!install) throw new Error('Library installation is not available in this context');
      for (const id of preinstall) {
        const entry = snapshot.deps.library?.find(candidate => candidate.id === id);
        if (entry && snapshot.deps.pieceRegistry.get(entry.npmPackage)) { alreadyInstalledPieces.push(id); continue; }
        try {
          await boundedInstall(install, id, installTimeoutMs ?? PREINSTALL_TIMEOUT_MS, request.signal);
          installedPieces.push(id);
        } catch (error) {
          request.signal?.throwIfAborted();
          installationErrors.push(`Could not install ${id}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    const result = await composeFlow({ ...snapshot.deps, onCandidate(candidate) {
      request.signal?.throwIfAborted();
      journal.checkpoint(candidate);
      deps.onCandidate?.(candidate);
    } }, request);
    request.signal?.throwIfAborted();
    journal.finish(result.ok ? "VALIDATED" : "FAILED", result.ok ? [] : result.errors);
    return { ...result, compositionRecordId: journal.id,
      ...(installedPieces.length ? { installedPieces } : {}),
      ...(alreadyInstalledPieces.length ? { alreadyInstalledPieces } : {}),
      ...(installationErrors.length ? { installationErrors } : {}) };
  } catch (error) {
    // Preserve cancellation/provider failures. If shutdown closed the captured
    // DB, its last durable checkpoint remains COMPOSING (outcome unknown).
    try { journal.finish("FAILED", [error instanceof Error ? error.message : String(error)]); } catch { /* closed DB */ }
    // Connectors installed before the failure stay installed (the journal
    // records them); the caller reports them with the error.
    if (installedPieces.length && error && typeof error === "object") {
      try { Object.assign(error, { installedPieces: [...installedPieces] }); } catch { /* frozen error */ }
    }
    throw error;
  }
}

/** Default bound on one approved preinstall, lock wait included. */
export const PREINSTALL_TIMEOUT_MS = 5 * 60_000;

/**
 * One install, bounded: on timeout or caller cancellation its signal is
 * aborted (the production installer kills its bun install child) and this
 * rejects at once, even if the installer ignores the signal. The journal is
 * live for the whole preinstall phase, so an unbounded install would hold
 * the setup chain forever.
 */
async function boundedInstall(install: LibraryInstaller, id: string, timeoutMs: number, outer?: AbortSignal): Promise<void> {
  const controller = new AbortController();
  const onAbort = () => controller.abort(outer!.reason);
  outer?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error(`installation timed out after ${Math.round(timeoutMs / 1000)}s and was stopped`)), timeoutMs);
  try {
    outer?.throwIfAborted();
    const aborted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
    });
    const running = install(id, controller.signal);
    running.catch(() => { /* reported through the race, or after it lost */ });
    await Promise.race([running, aborted]);
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener('abort', onAbort);
  }
}
