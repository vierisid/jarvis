import type { BriefReadState } from "../../contracts";
import type { RunScope } from "../runs/model";
import {
  queryKey,
  validateContext,
  type ContextDocument,
  type ContextQuery,
  type WorkflowContextPort,
} from "./model";
const LOADING: BriefReadState<ContextDocument> = { status: "loading" };
const RETIRED: BriefReadState<ContextDocument> = {
  status: "unavailable",
  reason: "Context owner changed.",
};
/** Host retains this owner/version-scoped controller through room/shell returns. */
export class WorkflowContextController {
  readonly scope: Readonly<RunScope>;
  private state = { mode: "configured" as ContextQuery["basis"], revision: 0 };
  private results = new Map<string, BriefReadState<ContextDocument>>();
  private pending = new Map<
    string,
    { abort: AbortController; promise: Promise<void> }
  >();
  private positions = new Map<string, number>();
  private listeners = new Set<() => void>();
  private retired = false;
  constructor(
    scope: RunScope,
    readonly port: WorkflowContextPort,
  ) {
    this.scope = Object.freeze({ ...scope });
  }
  get active() {
    return !this.retired;
  }
  getSnapshot = () => this.state;
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  private emit() {
    if (!this.retired) {
      this.state = { ...this.state, revision: this.state.revision + 1 };
      this.listeners.forEach((fn) => fn());
    }
  }
  setMode = (mode: ContextQuery["basis"]) => {
    if (!this.retired && mode !== this.state.mode) {
      this.state = { ...this.state, mode };
      this.emit();
    }
  };
  get = (q: ContextQuery) =>
    this.retired ? RETIRED : (this.results.get(queryKey(q)) ?? LOADING);
  position(q: ContextQuery) {
    return this.positions.get(queryKey(q)) ?? 0;
  }
  rememberPosition(q: ContextQuery, top: number) {
    this.positions.set(queryKey(q), top);
  }
  load(q: ContextQuery) {
    return this.results.has(queryKey(q)) ? Promise.resolve() : this.refresh(q);
  }
  refresh(q: ContextQuery): Promise<void> {
    if (this.retired) return Promise.resolve();
    const query = { ...q },
      key = queryKey(query),
      running = this.pending.get(key);
    if (running) return running.promise;
    const abort = new AbortController();
    const promise = Promise.resolve().then(async () => {
      const prior = this.results.get(key);
      try {
        const result = await this.port.read(this.scope, query, abort.signal);
        if (this.retired || abort.signal.aborted) return;
        let safe: BriefReadState<ContextDocument>;
        if (result.status === "ready" || result.status === "stale") {
          const data = validateContext(result.data, this.scope, query);
          safe =
            result.status === "ready"
              ? { status: "ready", data }
              : {
                  status: "stale",
                  data,
                  reason: "Context may be out of date.",
                };
        } else if (result.status === "empty" || result.status === "loading")
          safe = { status: result.status };
        else if (
          result.status === "unavailable" ||
          result.status === "unsupported"
        )
          safe = {
            status: result.status,
            reason: "Context could not be loaded.",
          };
        else throw Error("Invalid context response");
        this.results.set(key, safe);
      } catch {
        if (this.retired || abort.signal.aborted) return;
        this.results.set(
          key,
          prior && (prior.status === "ready" || prior.status === "stale")
            ? {
                status: "stale",
                data: prior.data,
                reason: "Context could not be refreshed.",
              }
            : { status: "unavailable", reason: "Context could not be loaded." },
        );
      } finally {
        this.pending.delete(key);
        this.emit();
      }
    });
    this.pending.set(key, { abort, promise });
    return promise;
  }
  retire() {
    this.retired = true;
    for (const work of this.pending.values()) work.abort.abort();
    this.results.clear();
    this.positions.clear();
    this.listeners.clear();
  }
}
