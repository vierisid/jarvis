import type { BriefReadState } from "../../contracts";
import {
  validateDetail,
  validatePage,
  validSummary,
  type ManualRunRequest,
  type RunDetail,
  type RunPage,
  type RunScope,
  type RunSummary,
  type WorkflowRunsPort,
} from "./model";
export interface RunsSnapshot {
  history: BriefReadState<RunPage>;
  selectedId: string | null;
  detail: BriefReadState<RunDetail>;
  loadingMore: boolean;
  submission: "idle" | "pending" | "accepted" | "uncertain";
  request: ManualRunRequest | null;
  message: string;
}
/** One owner/flow/version lifetime. Host retains this store across room returns,
 * and retires it on owner changes. A pending/uncertain command is never replayed. */
export class WorkflowRunsController {
  readonly scope: RunScope;
  private state: RunsSnapshot = {
    history: { status: "loading" },
    selectedId: null,
    detail: { status: "empty" },
    loadingMore: false,
    submission: "idle",
    request: null,
    message: "",
  };
  private listeners = new Set<() => void>();
  private historyRequest = 0;
  private detailRequest = 0;
  private historyAbort?: AbortController;
  private detailAbort?: AbortController;
  private retired = false;
  private refreshWork?: Promise<void>;
  private moreWork?: Promise<void>;
  private historyWork?: Promise<void>;
  private detailWork?: { id: string; promise: Promise<void> };
  private summaryRevision = 0;
  private detailSummaries = new Map<
    string,
    { revision: number; summary: RunSummary }
  >();
  // A durable receipt may precede its appearance in the history projection.
  private acknowledged = new Map<string, RunSummary>();
  private preferredId: string | null = null;
  private positions = new Map<string, number>();
  constructor(
    scope: RunScope,
    readonly port: WorkflowRunsPort,
  ) {
    this.scope = { ...scope };
  }
  getSnapshot = () => this.state;
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  private emit(patch: Partial<RunsSnapshot>) {
    if (!this.retired) {
      this.state = { ...this.state, ...patch };
      this.listeners.forEach((fn) => fn());
    }
  }
  rememberPosition(key: string, top: number) {
    this.positions.set(key, top);
  }
  position(key: string) {
    return this.positions.get(key) ?? 0;
  }
  private page() {
    const h = this.state.history;
    return h.status === "ready" || h.status === "stale" ? h.data : null;
  }
  async load(selectedId?: string) {
    if (selectedId) {
      this.preferredId = selectedId;
      this.select(selectedId);
    }
    await this.refresh();
  }
  refresh = (): Promise<void> => {
    if (this.retired) return Promise.resolve();
    if (this.refreshWork) return this.refreshWork;
    const work = Promise.resolve().then(async () => {
      await this.readHistory(false);
      if (this.state.selectedId)
        await this.readDetail(this.state.selectedId, true);
    });
    this.refreshWork = work;
    void work.then(() => {
      if (this.refreshWork === work) this.refreshWork = undefined;
    });
    return work;
  };
  more = (): Promise<void> => {
    if (this.retired) return Promise.resolve();
    if (this.moreWork) return this.moreWork;
    const work = this.readHistory(true);
    this.moreWork = work;
    void work.then(() => {
      if (this.moreWork === work) this.moreWork = undefined;
    });
    return work;
  };
  private async readHistory(append: boolean) {
    // Paging and refresh share one read lane. Polling must never abort a slow
    // successful read or an older page the person explicitly requested.
    while (this.historyWork) await this.historyWork;
    if (this.retired) return;
    const work = Promise.resolve().then(() => this.performHistoryRead(append));
    this.historyWork = work;
    try {
      await work;
    } finally {
      if (this.historyWork === work) this.historyWork = undefined;
    }
  }
  private async performHistoryRead(append: boolean) {
    if (this.retired) return;
    const previous = this.page();
    if (append && !previous?.nextCursor) return;
    const epoch = ++this.historyRequest;
    const revision = this.summaryRevision;
    const abort = (this.historyAbort = new AbortController());
    this.emit({ loadingMore: append });
    try {
      let result = await this.port.list(
        append ? previous!.nextCursor : null,
        abort.signal,
      );
      if (this.retired || epoch !== this.historyRequest) return;
      if (result.status === "ready" || result.status === "stale") {
        let page = validatePage(result.data, this.scope);
        const rows = new Map<string, RunSummary>();
        const observed = new Set<string>();
        if (append) for (const row of previous!.items) rows.set(row.runId, row);
        for (const row of page.items) {
          rows.set(row.runId, row);
          observed.add(row.runId);
        }
        const total = page.total;
        // Rebuild the contiguous prefix through the last loaded identity, not
        // merely the old row count. New pages can sit between head and cache.
        const tail = previous?.items
          .filter((row) => !this.acknowledged.has(row.runId))
          .at(-1)?.runId;
        const cursors = new Set<string>();
        let pages = 1;
        while (
          !append &&
          result.status === "ready" &&
          page.nextCursor &&
          tail &&
          !rows.has(tail) &&
          pages < 20
        ) {
          const cursor = page.nextCursor;
          if (cursors.has(cursor)) throw Error("Repeated history cursor");
          cursors.add(cursor);
          const next = await this.port.list(cursor, abort.signal);
          if (this.retired || epoch !== this.historyRequest) return;
          if (next.status !== "ready")
            throw Error("Incomplete history refresh");
          page = validatePage(next.data, this.scope);
          for (const row of page.items) {
            rows.set(row.runId, row);
            observed.add(row.runId);
          }
          pages++;
        }
        if (page.nextCursor && cursors.has(page.nextCursor))
          throw Error("Repeated history cursor");
        if (result.status === "ready")
          for (const id of observed) this.acknowledged.delete(id);
        // A detail that completed during this history read is newer evidence.
        // Do not let the older list snapshot undo that status reconciliation.
        for (const [id, value] of this.detailSummaries) {
          if (value.revision > revision && rows.has(id))
            rows.set(id, value.summary);
        }
        const items = [
          ...this.acknowledged.values(),
          ...[...rows.values()].filter(
            (row) => !this.acknowledged.has(row.runId),
          ),
        ];
        const data = {
          items,
          total:
            total === null || total < items.length || this.acknowledged.size > 0
              ? null
              : total,
          nextCursor: page.nextCursor,
        };
        const bounded =
          !append && !!tail && !rows.has(tail) && !!page.nextCursor;
        result =
          result.status === "stale" || bounded
            ? {
                status: "stale",
                data,
                reason:
                  "History refresh is partial. Load earlier runs to continue.",
              }
            : { status: "ready", data };
      } else if (
        result.status === "empty" &&
        (append || this.acknowledged.size)
      ) {
        const items = append
          ? previous!.items
          : [...this.acknowledged.values()];
        result = {
          status: "ready",
          data: { items, total: null, nextCursor: null },
        };
      }
      this.emit({ history: result });
      if (!this.state.selectedId) {
        const first = this.preferredId ?? this.page()?.items[0]?.runId;
        if (first) this.select(first);
      }
    } catch {
      if (epoch === this.historyRequest && !abort.signal.aborted)
        this.emit({
          history: previous
            ? {
                status: "stale",
                data: this.page() ?? previous,
                reason: "History could not be refreshed.",
              }
            : { status: "unavailable", reason: "Run history is unavailable." },
        });
    } finally {
      if (epoch === this.historyRequest) this.emit({ loadingMore: false });
    }
  }
  select = (id: string) => {
    if (this.retired || !id || this.state.selectedId === id) return;
    this.preferredId = id;
    this.emit({ selectedId: id, detail: { status: "loading" } });
    void this.readDetail(id, false);
  };
  private readDetail(id: string, preserve: boolean): Promise<void> {
    if (this.retired) return Promise.resolve();
    if (this.detailWork?.id === id) return this.detailWork.promise;
    const promise = this.performDetailRead(id, preserve);
    this.detailWork = { id, promise };
    void promise.then(() => {
      if (this.detailWork?.promise === promise) this.detailWork = undefined;
    });
    return promise;
  }
  private async performDetailRead(id: string, preserve: boolean) {
    if (this.retired) return;
    const epoch = ++this.detailRequest;
    this.detailAbort?.abort();
    const abort = (this.detailAbort = new AbortController());
    const prior = this.state.detail;
    const previous =
      preserve &&
      (prior.status === "ready" || prior.status === "stale") &&
      prior.data.runId === id
        ? prior.data
        : null;
    try {
      let result = await this.port.detail(id, abort.signal);
      if (
        this.retired ||
        epoch !== this.detailRequest ||
        this.state.selectedId !== id
      )
        return;
      if (result.status === "ready" || result.status === "stale") {
        const known = this.page()?.items.find((r) => r.runId === id);
        validateDetail(result.data, this.scope, id, known?.versionId);
      }
      if (result.status === "ready") {
        const {
          scopeId,
          flowId,
          runId,
          versionId,
          label,
          status,
          startedAt,
          createdAt,
        } = result.data;
        const summary = {
          scopeId,
          flowId,
          runId,
          versionId,
          label,
          status,
          startedAt,
          createdAt,
        };
        this.detailSummaries.set(id, {
          revision: ++this.summaryRevision,
          summary,
        });
        if (this.acknowledged.has(id)) this.acknowledged.set(id, summary);
        const history = this.state.history;
        if (history.status === "ready" || history.status === "stale") {
          this.emit({
            detail: result,
            history: {
              ...history,
              data: {
                ...history.data,
                items: history.data.items.map((row) =>
                  row.runId === id ? summary : row,
                ),
              },
            },
          });
          return;
        }
      }
      this.emit({ detail: result });
    } catch {
      if (
        epoch === this.detailRequest &&
        !abort.signal.aborted &&
        this.state.selectedId === id
      )
        this.emit({
          detail: previous
            ? {
                status: "stale",
                data: previous,
                reason: "This inspection could not be refreshed.",
              }
            : {
                status: "unavailable",
                reason: "The selected run could not be loaded.",
              },
        });
    }
  }
  get canRun() {
    return (
      !this.retired &&
      !!this.port.start &&
      this.state.submission !== "pending" &&
      this.state.submission !== "uncertain"
    );
  }
  start = async () => {
    if (!this.canRun) return;
    const request = { ...this.scope, requestId: crypto.randomUUID() };
    this.emit({ submission: "pending", request, message: "Requesting run…" });
    try {
      const result = await this.port.start!(request);
      if (this.retired) return;
      if (result.requestId !== request.requestId)
        throw Error("Mismatched request");
      if (result.status === "not_submitted") {
        this.emit({
          submission: "idle",
          request: null,
          message: "Run was not submitted.",
        });
        return;
      }
      if (
        result.status !== "accepted" ||
        !validSummary(result.run, this.scope) ||
        result.run.versionId !== this.scope.versionId
      )
        throw Error("Unconfirmed run");
      // A pre-command history read may omit the accepted run. Retire that read
      // before inserting its receipt; later refreshes merge against this state.
      ++this.historyRequest;
      this.historyAbort?.abort();
      this.acknowledged.set(result.run.runId, result.run);
      const page = this.page();
      const isNew = !page?.items.some((r) => r.runId === result.run.runId);
      this.emit({
        submission: "accepted",
        loadingMore: false,
        message: "Run requested.",
        history: {
          status: "ready",
          data: {
            items: [
              result.run,
              ...(page?.items ?? []).filter(
                (r) => r.runId !== result.run.runId,
              ),
            ],
            total: page?.total == null ? null : page.total + (isNew ? 1 : 0),
            nextCursor: page?.nextCursor ?? null,
          },
        },
      });
      this.select(result.run.runId);
    } catch {
      this.emit({
        submission: "uncertain",
        message:
          "Run request could not be confirmed. Check history before starting another run.",
      });
    }
  };
  /** Explicit owner teardown, never called merely because Pebble or a room closes. */
  retire() {
    this.retired = true;
    this.historyAbort?.abort();
    this.detailAbort?.abort();
    this.listeners.clear();
  }
}
