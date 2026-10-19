import { apId } from '../db/ids';
import { DEFAULT_IDS } from '../db/schema';
import type { EngineRuntime } from '../runner/engine-runtime/engine-runtime';
import { metadataToCatalogEntry, type PieceCatalog } from './piece-catalog';

/** Keep the running catalog in sync with Library installs and removals. */
export function createPieceLibraryChangeHandler(catalog: PieceCatalog, runtime: Pick<EngineRuntime, 'acquire'>) {
  const refreshes = new Map<string, symbol>();
  return async (event: {
    kind: 'installed' | 'uninstalled';
    piece: { npmPackage: string; resolvedVersion: string };
  }): Promise<void> => {
    const name = event.piece.npmPackage;
    // Disk has already changed. Never advertise the old contract while refresh
    // is pending or after acquisition/extraction fails.
    catalog.remove(name);
    const refresh = Symbol();
    refreshes.set(name, refresh);
    try {
      if (event.kind === 'uninstalled') return;
      const handle = await runtime.acquire({
        runId: `metadata-extract-runtime-install-${apId()}`,
        projectId: DEFAULT_IDS.project,
      });
      try {
        const meta = await handle.extractPieceMetadata({
          pieceName: name,
          pieceVersion: event.piece.resolvedVersion,
        });
        // Library callbacks can overlap after the disk-install mutex releases.
        // A later uninstall or refresh must supersede this asynchronous result.
        if (refreshes.get(name) === refresh) {
          catalog.upsert({ ...metadataToCatalogEntry(meta), version: event.piece.resolvedVersion });
        }
      } finally {
        await handle.release();
      }
    } finally {
      if (refreshes.get(name) === refresh) refreshes.delete(name);
    }
  };
}
