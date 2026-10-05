import type { Database } from 'bun:sqlite';
import type { BriefPageQuery } from './contracts.ts';
import type { BriefReadProviders } from './providers.ts';
import { getDb } from '../vault/schema.ts';
import { ConversationRepository } from '../vault/conversation-lifecycle.ts';

/** Bound to this authenticated daemon's workspace; no workspace comes from client input. */
export class BriefConversationProvider implements NonNullable<BriefReadProviders['conversations']> {
  readonly repository: ConversationRepository;
  constructor(private readonly db: Database = getDb(), workspaceId?: string) {
    this.repository = new ConversationRepository(db, workspaceId);
  }
  readiness(): 'ready' | 'unavailable' {
    // Pointer identity only: no I/O during capability discovery. A replaced/closed
    // vault must not keep serving a stale provider after a daemon lifecycle change.
    try { return getDb() === this.db ? 'ready' : 'unavailable'; }
    catch { return 'unavailable'; }
  }
  async read(query: BriefPageQuery) {
    const data = this.repository.list(query);
    return data.items.length
      ? { state: 'ready' as const, data, asOf: Date.now() }
      : { state: 'empty' as const, asOf: Date.now() };
  }
}
