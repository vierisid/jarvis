import type { BriefReadState } from "../../contracts";
import {
  validateDetail,
  validatePage,
  validSummary,
  type ManualRunRequest,
  type RunDetail,
  type RunPage,
  type RunScope,
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
  async refresh() {
    await this.readHistory(false);
    if (this.state.selectedId)
      await this.readDetail(this.state.selectedId, true);
  }
  more = () => this.readHistory(true);
  private async readHistory(append: boolean) {
    if (this.retired || (append && this.state.loadingMore)) return;
    const previous = this.page();
    if (append && !previous?.nextCursor) return;
    const epoch = ++this.historyRequest;
    this.historyAbort?.abort();
    const abort = (this.historyAbort = new AbortController());
    this.emit({ loadingMore: append });
    try {
      let result = await this.port.list(
        append ? previous!.nextCursor : null,
        abort.signal,
      );
      if (this.retired || epoch !== this.historyRequest) return;
      if (result.status === "ready" || result.status === "stale") {
        const page = validatePage(result.data, this.scope);
        // Retain loaded history when a new head page arrives. The provider must
        // use stable opaque cursors; run IDs, never row numbers, are identities.
        const old = previous?.items ?? [];
        const items = append
          ? [
              ...old,
              ...page.items.filter(
                (r) => !old.some((p) => p.runId === r.runId),
              ),
            ]
          : [
              ...page.items,
              ...old.filter(
                (r) => !page.items.some((p) => p.runId === r.runId),
              ),
            ];
        result = {
          ...result,
          data: {
            ...page,
            items,
            nextCursor:
              !append && old.length > page.items.length
                ? previous!.nextCursor
                : page.nextCursor,
          },
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
                data: previous,
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
  private async readDetail(id: string, preserve: boolean) {
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
