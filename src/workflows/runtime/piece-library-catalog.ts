import { apId } from '../db/ids';
import { DEFAULT_IDS } from '../db/schema';
import type { EngineRuntime } from '../runner/engine-runtime/engine-runtime';
import { metadataToCatalogEntry, type PieceCatalog } from './piece-catalog';

/** Keep the running catalog in sync with Library installs and removals. */
export function createPieceLibraryChangeHandler(catalog: PieceCatalog, runtime: Pick<EngineRuntime, 'acquire'>) {
  return async (event: {
    kind: 'installed' | 'uninstalled';
    piece: { npmPackage: string; resolvedVersion: string };
  }): Promise<void> => {
    // Only ever reached on a SELF-MANAGED install: the Library
    // mutations that fire this are refused when a host owns the
    // catalog, and a host owning the catalog is exactly what having a
    // shared tree means. So an uninstall here has no shared copy to
    // fall back to. The piece is simply gone.
    if (event.kind === "uninstalled") {
      catalog.remove(event.piece.npmPackage);
      return;
    }
    // Unique runId per acquire so any future parallel installs
    // (today serialized by the API's library mutex) don't collide on
    // the engine's runId-keyed state.
    const handle = await runtime.acquire({
      runId: `metadata-extract-runtime-install-${apId()}`,
      projectId: DEFAULT_IDS.project,
    });
    try {
      const meta = await handle.extractPieceMetadata({
        pieceName: event.piece.npmPackage,
        pieceVersion: event.piece.resolvedVersion,
      });
      // Installation metadata does not carry the package version. Keep the
      // resolved installed version, just as startup/cache catalog loading does.
      catalog.upsert({ ...metadataToCatalogEntry(meta), version: event.piece.resolvedVersion });
    } finally {
      await handle.release();
    }
  };
}
