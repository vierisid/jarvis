/** What saving a new key on a connection would do to the workflows that run on it (GET .../rotation-impact). */
export async function fetchRotationNotice(connectionId: string): Promise<string | null> {
  try {
    const res = await fetch(`/api/workflows/connections/${encodeURIComponent(connectionId)}/rotation-impact`);
    if (!res.ok) return null;
    const body = (await res.json()) as { message?: unknown };
    return typeof body.message === "string" && body.message ? body.message : null;
  } catch {
    return null;
  }
}
