/**
 * More than one way to the same thing, tried in order.
 *
 * Jarvis can reach a person's calendar, files or mail in more than one way: a
 * connection they set up, or its own browser, where they are signed in to the
 * same account. A missing connection is not a reason to say "I can't": the
 * next way is tried, and only when every way has been tried does Jarvis say
 * what it could not get, and what it tried.
 *
 * The order is the caller's: the cheapest and most exact way first (a
 * connection answers in one call and in a fixed form), the browser after it.
 */

export interface Way<T> {
  /** What this way is called when Jarvis says how it got something: "connection", "browser". */
  name: string;
  /** The thing, or null when this way does not exist here (nothing connected, no browser). A throw is a way that exists and failed. */
  get(): Promise<T | null>;
}

export type Reached<T> =
  | { value: T; through: string; tried: WayTried[] }
  | { value: null; through: null; tried: WayTried[] };

export interface WayTried { name: string; why: 'not-here' | 'failed'; reason?: string }

/** The first way that answers. Every way before it is in `tried`, with why it did not. */
export async function firstWay<T>(ways: Way<T>[]): Promise<Reached<T>> {
  const tried: WayTried[] = [];
  for (const way of ways) {
    try {
      const value = await way.get();
      if (value !== null) return { value, through: way.name, tried };
      tried.push({ name: way.name, why: 'not-here' });
    } catch (error) {
      tried.push({ name: way.name, why: 'failed', reason: (error instanceof Error ? error.message : String(error)).slice(0, 200) });
    }
  }
  return { value: null, through: null, tried };
}
