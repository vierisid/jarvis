import {
  decisionId,
  revision,
  documentError,
  matchesReceipt,
  receiptMessage,
  type DecisionCollection,
  type DecisionDocument,
  type DecisionView,
  type DecisionsPort,
  type DocumentAction,
  type DocumentRequest,
  type DocumentReceipt,
  type DocumentRefusal,
} from "./model";
export interface Attempt {
  request: DocumentRequest;
  item: DecisionView;
  successors: string[];
  state: "sending" | "unknown" | "refused" | "confirmed";
  receipt?: DocumentReceipt;
  reason?: string;
  checking?: boolean;
  settled?: boolean;
  submittedDraft?: DecisionSnapshot["draft"];
}
export interface DecisionSnapshot {
  read: DecisionCollection;
  rows: readonly DecisionView[];
  selectedId: string | null;
  draft: { id: string; revision: string; document: DecisionDocument } | null;
  attempts: ReadonlyMap<string, Attempt>;
  refreshing: boolean;
  phase: "rest" | "acknowledge";
  message: string;
}
/** Retain one controller per authenticated scope across room/layout changes. */
export class DecisionsController {
  private state: DecisionSnapshot = {
    read: { status: "loading" },
    rows: [],
    selectedId: null,
    draft: null,
    attempts: new Map(),
    refreshing: false,
    phase: "rest",
    message: "",
  };
  private listeners = new Set<() => void>();
  private access = false;
  private retired = false;
  private generation = 0;
  private selectionVersion = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private reduced = false;
  scrollTop = 0;
  listScrollTop = 0;
  listScrollLeft = 0;
  constructor(
    readonly source: "fixture" | "live",
    readonly scopeId: string,
    private port: DecisionsPort,
    private acknowledgement = 520,
  ) {}
  snapshot = () => this.state;
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  private publish(patch: Partial<DecisionSnapshot>) {
    if (this.retired) return;
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((f) => f());
  }
  setAccess(value: boolean) {
    if (this.access === value) return;
    this.access = value;
    this.generation++;
    this.publish({ refreshing: false });
  }
  setReduced(value: boolean) {
    this.reduced = value;
  }
  async refresh() {
    if (!this.access || this.retired) return false;
    const generation = ++this.generation;
    this.publish({ refreshing: true });
    try {
      const read = await this.port.read();
      if (!this.access || this.retired || generation !== this.generation)
        return false;
      const incoming =
        read.status === "ready" || read.status === "stale"
          ? [...read.data]
          : [];
      const attempts = new Map(this.state.attempts);
      if (read.status === "ready" || read.status === "empty")
        for (const [id, attempt] of attempts) {
          if (attempt.state === "refused") attempts.delete(id);
        }
      // Unknown requests and in-flight documents keep their original slot and revision.
      // A fresh queue cannot disprove an uncertain write. Only its receipt can.
      const pinned = (id: string) => {
        const a = attempts.get(id);
        return (
          this.state.draft?.id === id ||
          (a &&
            (a.state === "sending" ||
              a.state === "unknown" ||
              (a.state === "confirmed" && this.state.phase === "acknowledge")))
        );
      };
      const rows = incoming.filter((x) => !pinned(decisionId(x)));
      this.state.rows.forEach((item, index) => {
        if (pinned(decisionId(item)))
          rows.splice(Math.min(index, rows.length), 0, item);
      });
      const selectedId = rows.some(
        (x) => decisionId(x) === this.state.selectedId,
      )
        ? this.state.selectedId
        : decisionIdOrNull(rows[0]);
      this.publish({ read, rows, selectedId, attempts, refreshing: false });
      return read.status === "ready" || read.status === "empty";
    } catch {
      if (this.access && !this.retired && generation === this.generation)
        this.publish({
          read: this.state.rows.length
            ? {
                status: "stale",
                data: this.state.rows,
                reason: "Could not refresh decisions. Actions are paused.",
              }
            : {
                status: "unavailable",
                reason: "Decisions could not be loaded.",
              },
          refreshing: false,
        });
      return false;
    }
  }
  select(id: string): boolean {
    if (
      !this.access ||
      this.retired ||
      this.state.draft ||
      this.state.phase !== "rest" ||
      !this.state.rows.some((x) => decisionId(x) === id)
    )
      return false;
    if (this.state.selectedId !== id) this.selectionVersion++;
    this.publish({ selectedId: id, message: "" });
    return true;
  }
  canAct(id: string, action: DocumentAction): boolean {
    const item = this.state.rows.find((x) => decisionId(x) === id),
      attempt = this.state.attempts.get(id);
    if (
      !this.access ||
      this.retired ||
      !item ||
      !id ||
      !revision(item) ||
      this.state.read.status !== "ready" ||
      this.state.refreshing ||
      this.state.phase !== "rest" ||
      [...this.state.attempts.values()].some(
        (a) => a.state === "sending" || a.checking,
      ) ||
      !item.actions.includes(action)
    )
      return false;
    if (
      !this.state.read.data.some(
        (fresh) =>
          decisionId(fresh) === id &&
          revision(fresh) === revision(item) &&
          fresh.actions.includes(action),
      )
    )
      return false;
    // This adapter handles F-14 permission documents only, never intent or execution recovery.
    if (
      !item.paper.decision.approval ||
      item.paper.approveResult !== "permission_granted"
    )
      return false;
    if (
      attempt &&
      (attempt.state !== "confirmed" ||
        revision(item) === attempt.request.revision)
    )
      return false;
    if (action === "save")
      return (
        !!item.editable &&
        !!item.document &&
        this.state.draft?.id === id &&
        this.state.draft.revision === revision(item) &&
        !documentError(this.state.draft.document)
      );
    return !this.state.draft;
  }
  edit(id: string) {
    const item = this.state.rows.find((x) => decisionId(x) === id);
    if (!item?.document || !this.canBeginEdit(id)) return;
    this.publish({
      draft: {
        id,
        revision: revision(item),
        document: structuredClone(item.document),
      },
      message: "",
    });
  }
  canBeginEdit(id: string) {
    const item = this.state.rows.find((x) => decisionId(x) === id),
      a = this.state.attempts.get(id);
    return (
      ![...this.state.attempts.values()].some(
        (a) => a.state === "sending" || a.checking,
      ) &&
      !!item?.editable &&
      !!item.document &&
      item.actions.includes("save") &&
      !!item.paper.decision.approval &&
      item.paper.approveResult === "permission_granted" &&
      this.access &&
      !this.retired &&
      this.state.read.status === "ready" &&
      !this.state.refreshing &&
      !this.state.draft &&
      this.state.phase === "rest" &&
      (!a || (a.state === "confirmed" && revision(item) !== a.request.revision))
    );
  }
  change(document: DecisionDocument) {
    if (
      this.access &&
      !this.retired &&
      this.state.draft &&
      !this.state.attempts.get(this.state.draft.id)?.checking &&
      this.state.attempts.get(this.state.draft.id)?.state !== "sending" &&
      this.state.attempts.get(this.state.draft.id)?.state !== "unknown" &&
      this.state.phase === "rest"
    )
      this.publish({ draft: { ...this.state.draft, document } });
  }
  cancelEdit() {
    const a = this.state.draft && this.state.attempts.get(this.state.draft.id);
    if (
      !a ||
      a.state === "refused" ||
      (a.state === "confirmed" && this.state.phase === "rest")
    ) {
      this.publish({ draft: null, message: "" });
      void this.refresh();
    }
  }
  private attempt(id: string, value: Attempt) {
    const attempts = new Map(this.state.attempts);
    attempts.set(id, value);
    this.publish({ attempts });
  }
  async act(id: string, action: DocumentAction, expectedRevision?: string) {
    if (!this.canAct(id, action)) return;
    const item = this.state.rows.find((x) => decisionId(x) === id)!;
    if (expectedRevision && expectedRevision !== revision(item)) return;
    const index = this.state.rows.indexOf(item);
    const attempt: Attempt = {
      item,
      state: "sending",
      submittedDraft: action === "save" ? this.state.draft : undefined,
      successors: [
        ...this.state.rows.slice(index + 1),
        ...this.state.rows.slice(0, index),
      ].map(decisionId),
      request: {
        decisionId: id,
        revision: revision(item),
        requestId: crypto.randomUUID(),
        action,
        ...(action === "save"
          ? { document: structuredClone(this.state.draft!.document) }
          : {}),
      },
    };
    this.attempt(id, attempt);
    try {
      this.receive(attempt, await this.port.act(attempt.request));
    } catch {
      this.attempt(id, { ...attempt, state: "unknown" });
    }
  }
  async recover(id: string) {
    const attempt = this.state.attempts.get(id);
    if (
      !this.access ||
      this.retired ||
      [...this.state.attempts.values()].some(
        (a) => a.state === "sending" || a.checking,
      ) ||
      !attempt ||
      attempt.settled ||
      attempt.checking ||
      !["unknown", "confirmed"].includes(attempt.state) ||
      this.state.phase !== "rest"
    )
      return;
    this.attempt(id, { ...attempt, checking: true });
    try {
      this.receive(attempt, await this.port.recover(attempt.request));
    } catch {
      this.attempt(id, { ...attempt, checking: false });
    }
  }
  private receive(
    attempt: Attempt,
    receipt: DocumentReceipt | DocumentRefusal | null,
  ) {
    if (this.retired) return;
    const id = attempt.request.decisionId;
    const currentAttempt = this.state.attempts.get(id);
    if (
      currentAttempt?.request.requestId !== attempt.request.requestId ||
      currentAttempt.settled
    )
      return;
    if (
      receipt &&
      "state" in receipt &&
      receipt.state === "refused" &&
      receipt.requestId === attempt.request.requestId &&
      receipt.decisionId === id &&
      receipt.revision === attempt.request.revision &&
      !!receipt.reason
    ) {
      this.attempt(id, {
        ...attempt,
        state: "refused",
        reason: receipt.reason,
        checking: false,
      });
      return;
    }
    if (
      !receipt ||
      "state" in receipt ||
      !matchesReceipt(attempt.request, receipt)
    ) {
      this.attempt(id, {
        ...attempt,
        state: attempt.receipt ? "confirmed" : "unknown",
        checking: false,
      });
      return;
    }
    this.attempt(id, {
      ...attempt,
      state: "confirmed",
      receipt,
      checking: false,
    });
    this.publish({ phase: "acknowledge", message: receiptMessage(receipt) });
    clearTimeout(this.timer);
    this.timer = setTimeout(
      () => void this.settle(attempt),
      this.reduced ? 0 : this.acknowledgement,
    );
  }
  private async settle(attempt: Attempt) {
    if (this.retired) return;
    const id = attempt.request.decisionId;
    const wasSelected = this.state.selectedId === id;
    const selectionVersion = this.selectionVersion;
    this.publish({ phase: "rest" });
    if (!this.access) return;
    const fresh = await this.refresh();
    if (!fresh || !this.access || this.retired) return;
    const latestAttempt = this.state.attempts.get(id);
    if (
      latestAttempt?.request.requestId !== attempt.request.requestId ||
      latestAttempt.settled
    )
      return;
    // Visible rows may hold unsaved text. Reconcile the receipt against the
    // authoritative projection, not that deliberately retained document.
    const current =
      this.state.read.status === "ready"
        ? this.state.read.data.find((x) => decisionId(x) === id)
        : undefined;
    const receipt = latestAttempt.receipt;
    // A historical receipt never unlocks a newer document. Require the owner projection.
    if (
      current &&
      receipt &&
      (revision(current) !== receipt.revision ||
        current.generation !== receipt.generation ||
        current.paper.decision.approval?.approvalId !== receipt.approvalId)
    ) {
      this.publish({
        read: {
          status: "stale",
          data: this.state.rows,
          reason:
            "This decision changed again. Refresh to review its current state.",
        },
      });
      return;
    }
    if (attempt.submittedDraft && this.state.draft === attempt.submittedDraft) {
      // Only this request's unchanged edit can be retired. An edit created or
      // changed later remains pinned and cancellable, even if its source vanished.
      const rows = this.state.rows.flatMap((row) =>
        decisionId(row) === id ? (current ? [current] : []) : [row],
      );
      this.publish({
        draft: null,
        rows,
        selectedId: rows.some((x) => decisionId(x) === this.state.selectedId)
          ? this.state.selectedId
          : decisionIdOrNull(rows[0]),
      });
    }
    this.attempt(id, { ...latestAttempt, settled: true });
    if (
      attempt.request.action === "save" ||
      attempt.request.action === "reopen"
    )
      return;
    if (wasSelected && selectionVersion === this.selectionVersion) {
      const next = attempt.successors.find((candidate) =>
        this.state.rows.some((x) => decisionId(x) === candidate),
      );
      if (next) this.publish({ selectedId: next });
    }
  }
  retire() {
    this.retired = true;
    this.generation++;
    clearTimeout(this.timer);
    this.listeners.clear();
  }
}
function decisionIdOrNull(item?: DecisionView) {
  return item ? decisionId(item) : null;
}
