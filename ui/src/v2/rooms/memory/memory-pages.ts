/** Never publish a partial page set as the complete vault. Polling owns the deadline. */
export async function readMemoryPages<T>(kind: 'entities' | 'facts' | 'relationships', signal: AbortSignal): Promise<T[]> {
  const items: T[] = [];
  let cursor = '';
  do {
    signal.throwIfAborted();
    const response = await fetch(`/api/vault/page?kind=${kind}&cursor=${encodeURIComponent(cursor)}`, { signal });
    if (!response.ok) throw new Error(`Memory refresh failed (HTTP ${response.status}); showing the previous snapshot.`);
    const page = await response.json() as { items: T[]; nextCursor: string | null };
    if (!Array.isArray(page.items) || page.items.length > 100 || (page.nextCursor !== null && (typeof page.nextCursor !== 'string' || page.nextCursor <= cursor))) {
      throw new Error('Invalid memory page; showing the previous snapshot.');
    }
    items.push(...page.items);
    if (page.nextCursor === null) return items;
    cursor = page.nextCursor;
    // Let browser input/visibility/cancellation run between pages.
    await new Promise(resolve => setTimeout(resolve, 0));
  } while (true);
}
