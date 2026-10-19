import {
  EMPTY_FILTERS,
  ordered,
  queryFor,
  validPage,
  type MemoryFilters,
  type MemoryPage,
  type MemoryPort,
  type MemoryQuery,
  type MemoryRead,
} from "./model";
export interface MemoryState {
  filters: MemoryFilters;
  read: MemoryRead | { state: "loading" };
  loadingMore: boolean;
}
/** One authenticated scope; retain across room mounts, retire on logout/scope replacement. */
export class MemoryController {
  readonly source;
  readonly scopeId;
  private state: MemoryState = {
    filters: { ...EMPTY_FILTERS },
    read: { state: "loading" },
    loadingMore: false,
  };
  private listeners = new Set<() => void>();
  private generation = 0;
  private alive = true;
  private access = false;
  private abort?: AbortController;
  private timer?: ReturnType<typeof setTimeout>;
  private query?: MemoryQuery;
  constructor(
    private port: MemoryPort,
    private now = Date.now,
  ) {
    this.source = port.source;
    this.scopeId = port.scopeId;
  }
  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(patch: Partial<MemoryState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  private cancel() {
    this.generation++;
    this.abort?.abort();
    clearTimeout(this.timer);
    this.timer = undefined;
  }
  setAccess(allowed: boolean) {
    if (!this.alive || allowed === this.access) return;
    this.access = allowed;
    if (allowed) void this.refresh();
    else {
      this.cancel();
      this.query = undefined;
      this.publish({
        filters: { ...EMPTY_FILTERS },
        read: { state: "unavailable", reason: "Memory access ended." },
        loadingMore: false,
      });
    }
  }
  setFilters(patch: Partial<MemoryFilters>, delay = 200) {
    if (!this.alive || !this.access) return;
    this.cancel();
    this.query = undefined;
    // Clear old content immediately, including while the next query is debouncing.
    this.publish({
      filters: { ...this.state.filters, ...patch },
      read: { state: "loading" },
      loadingMore: false,
    });
    this.timer = setTimeout(() => {
      void this.refresh();
    }, delay);
  }
  clear() {
    this.setFilters({ ...EMPTY_FILTERS }, 0);
  }
  /** A canonical decision may have taken effect; keep filters but remove cached text immediately. */
  invalidate() {
    if (!this.alive || !this.access) return;
    this.cancel();
    this.query = undefined;
    this.publish({ read: { state: "loading" }, loadingMore: false });
  }
  async refresh() {
    if (!this.alive || !this.access) return;
    this.cancel();
    try {
      this.query = queryFor(this.state.filters, this.now());
    } catch (error) {
      this.publish({
        read: { state: "error", reason: (error as Error).message },
        loadingMore: false,
      });
      return;
    }
    this.publish({ read: { state: "loading" }, loadingMore: false });
    await this.request(this.query);
  }
  async loadMore() {
    if (
      !this.alive ||
      !this.access ||
      this.state.loadingMore ||
      !this.query ||
      !("data" in this.state.read) ||
      !this.state.read.data.nextCursor
    )
      return;
    const previous = this.state.read.data;
    this.cancel();
    this.publish({ loadingMore: true });
    await this.request(
      { ...this.query, cursor: previous.nextCursor! },
      previous,
    );
  }
  private async request(query: MemoryQuery, previous?: MemoryPage) {
    const generation = this.generation;
    this.abort = new AbortController();
    try {
      const read = await this.port.read(
        Object.freeze({ ...query }),
        this.abort.signal,
      );
      if (!this.alive || !this.access || generation !== this.generation) return;
      if ("data" in read) {
        if (
          !validPage(read.data, query) ||
          (read.state === "empty") !== (read.data.count.matched === 0)
        )
          throw new Error("Invalid memory page");
        const page = read.data;
        const loaded = (previous?.items.length ?? 0) + page.items.length;
        if (
          loaded > page.count.matched ||
          (page.nextCursor === null
            ? loaded !== page.count.matched
            : loaded >= page.count.matched)
        )
          throw new Error("Incomplete memory page");
        if (previous) {
          const known = new Set(previous.items.map((row) => row.factId));
          if (
            page.count.total !== previous.count.total ||
            page.count.matched !== previous.count.matched ||
            page.nextCursor === query.cursor ||
            page.items.some((row) => known.has(row.factId)) ||
            (page.items.length &&
              previous.items.length &&
              !ordered(previous.items.at(-1)!, page.items[0]!))
          )
            throw new Error("Changed memory snapshot");
          this.publish({
            read: {
              ...read,
              data: { ...page, items: [...previous.items, ...page.items] },
            },
            loadingMore: false,
          });
          return;
        }
      }
      // F17 stale deliberately carries no cached text (a fact may have been forgotten).
      this.publish({ read, loadingMore: false });
    } catch {
      if (!this.alive || !this.access || generation !== this.generation) return;
      this.publish({
        read: {
          state: "error",
          reason: "Memory could not be loaded. Refresh to read current facts.",
        },
        loadingMore: false,
      });
    }
  }
  retire() {
    this.cancel();
    this.alive = false;
    this.access = false;
    this.query = undefined;
    this.publish({
      filters: { ...EMPTY_FILTERS },
      read: { state: "unavailable", reason: "Session ended." },
      loadingMore: false,
    });
    this.listeners.clear();
  }
}
