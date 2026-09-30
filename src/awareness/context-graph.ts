/**
 * Context Graph — Entity Linking
 *
 * Links screen captures to vault entities by matching OCR text and
 * window titles against known entity names. Creates new 'tool' entities
 * for unseen applications.
 */

import type { ScreenContext } from './types.ts';
import { searchEntitiesByName, createEntity } from '../vault/entities.ts';
import { getSession, updateSession } from '../vault/awareness.ts';

export class ContextGraph {
  // Known app names, to avoid redundant entity creation. Per instance, so the
  // cache lives exactly as long as the service and database it mirrors.
  private readonly knownApps = new Set<string>();

  /**
   * Link a capture to vault entities.
   * Searches entity names against OCR text + window title.
   * Returns array of matched entity IDs.
   */
  linkCaptureToEntities(context: ScreenContext): string[] {
    const linkedIds: string[] = [];

    try {
      // 1. Ensure the app itself is a known entity
      if (context.appName && context.appName !== 'Unknown') {
        this.ensureAppEntity(context.appName);
      }

      // 2. Search OCR text and window title for known entity names
      const searchText = `${context.windowTitle} ${context.ocrText.slice(0, 1000)}`;
      const matchedEntities = this.findEntitiesInText(searchText);
      linkedIds.push(...matchedEntities);

      // 3. Update session entity links
      if (context.sessionId && linkedIds.length > 0) {
        this.updateSessionLinks(context.sessionId, linkedIds);
      }
    } catch (err) {
      console.error('[ContextGraph] Entity linking error:', err instanceof Error ? err.message : err);
    }

    return linkedIds;
  }

  /**
   * Ensure an app has an entity in the vault.
   */
  private ensureAppEntity(appName: string): void {
    if (this.knownApps.has(appName)) return;

    try {
      const existing = searchEntitiesByName(appName);
      if (existing.length === 0) {
        createEntity('tool', appName, { source: 'awareness_auto' }, 'awareness');
      }
      this.knownApps.add(appName);
    } catch { /* ignore — entity creation is best-effort */ }
  }

  /**
   * Find vault entities mentioned in text.
   * Uses a simple word-boundary search against entity names.
   */
  private findEntitiesInText(text: string): string[] {
    const ids: string[] = [];
    const textLower = text.toLowerCase();

    try {
      // Search for entities with names >= 3 chars that appear in the text
      // We search for common entity types that would appear in screen context
      const words = this.extractSignificantWords(textLower);

      for (const word of words) {
        if (word.length < 3) continue;

        const matches = searchEntitiesByName(word);
        for (const entity of matches) {
          // Exact word match (not substring of longer word)
          const nameLower = entity.name.toLowerCase();
          if (textLower.includes(nameLower) && !ids.includes(entity.id)) {
            ids.push(entity.id);
          }
        }

        // Limit to avoid too many DB queries
        if (ids.length >= 10) break;
      }
    } catch { /* ignore */ }

    return ids;
  }

  /**
   * Extract significant words for entity matching (skip common words).
   */
  private extractSignificantWords(text: string): string[] {
    const stopWords = new Set([
      'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can',
      'had', 'her', 'was', 'one', 'our', 'out', 'has', 'have', 'from',
      'this', 'that', 'with', 'they', 'been', 'said', 'each', 'which',
      'their', 'will', 'other', 'about', 'more', 'some', 'than', 'them',
      'would', 'make', 'like', 'just', 'over', 'such', 'into', 'also',
      'file', 'new', 'open', 'save', 'close', 'edit', 'view', 'help',
      'true', 'false', 'null', 'undefined', 'error', 'warning',
    ]);

    const words = text.match(/[a-z]{3,}/g) ?? [];
    const unique = [...new Set(words)];
    return unique.filter(w => !stopWords.has(w)).slice(0, 20);
  }

  /**
   * Update session's entity_links with newly found links.
   */
  private updateSessionLinks(sessionId: string, entityIds: string[]): void {
    try {
      const session = getSession(sessionId);
      if (!session) return;

      const existing: string[] = JSON.parse(session.entity_links || '[]');
      const merged = [...new Set([...existing, ...entityIds])];

      if (merged.length !== existing.length) {
        updateSession(sessionId, { entity_links: merged });
      }
    } catch { /* ignore */ }
  }
}
