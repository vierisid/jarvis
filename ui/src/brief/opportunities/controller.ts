import {
  activeProposal,
  approvalBlock,
  matchesReceipt,
  resolvedReceipt,
  receiptMessage,
  OPPORTUNITY_MOTION,
  type ActionRequest,
  type ActionReceipt,
  type ActionRefusal,
  type Decision,
  type FinishedOpportunity,
  type OpportunitiesPort,
  type OpportunityCollection,
} from "./model";

export interface Attempt {
  request: ActionRequest;
  item: FinishedOpportunity;
  /** Prefer the next surviving identity from the queue the user acted on. */
  successors: readonly string[];
  state: "sending" | "unknown" | "receipt" | "refused";
  reason?: string;
  receipt?: ActionReceipt;
  checking?: boolean;
}
export interface OpportunitiesSnapshot {
  read: OpportunityCollection;
  rows: readonly FinishedOpportunity[];
  selectedId: string | null;
  attempts: ReadonlyMap<string, Attempt>;
  phase: "rest" | "acknowledge" | "exit" | "enter";
  message: string;
  refreshing: boolean;
}
/** One owner per authenticated scope, retained across room navigation. No backend effects here. */
export class OpportunitiesController {
  private listeners = new Set<() => void>();
  private state: OpportunitiesSnapshot = {
    read: { status: "loading" },
    rows: [],
    selectedId: null,
    attempts: new Map(),
    phase: "rest",
    message: "",
    refreshing: false,
  };
  private retired = false;
  private access = false;
  private writeAccess = false;
  private generation = 0;
  private completed = new Set<string>();
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private transitions = new Set<string>();
  private reduced = false;
  scrollTop = 0;
  listScrollTop = 0;
  listScrollLeft = 0;
  constructor(
    readonly source: "fixture" | "live",
    readonly scopeId: string,
    private port: OpportunitiesPort,
    private timings: Record<
      keyof typeof OPPORTUNITY_MOTION,
      number
    > = OPPORTUNITY_MOTION,
  ) {}
  snapshot = () => this.state;
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  private publish(patch: Partial<OpportunitiesSnapshot>) {
    if (this.retired) return;
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((f) => f());
  }
  setAccess(read: boolean, write = read) {
    const changed = this.access !== read || this.writeAccess !== write;
    this.access = read;
    this.writeAccess = write;
    if (!read) {
      this.generation++;
    }
    if (changed || (!read && this.state.refreshing))
      this.publish({ refreshing: read ? this.state.refreshing : false });
  }
  setReduced(reduced: boolean) {
    this.reduced = reduced;
  }
  private later(fn: () => void, delay: number) {
    const t = setTimeout(
      () => {
        this.timers.delete(t);
        if (!this.retired) fn();
      },
      this.reduced ? 0 : delay,
    );
    this.timers.add(t);
  }
  async refresh() {
    if (!this.access || this.retired) return;
    const generation = ++this.generation;
    this.publish({ refreshing: true });
    try {
      const read = await this.port.read();
      if (!this.access || this.retired || generation !== this.generation)
        return;
      if (read.status === "ready" || read.status === "empty") {
        const attempts = new Map(this.state.attempts);
        for (const [id, attempt] of attempts)
          if (attempt.state === "refused") attempts.delete(id);
        this.publish({ attempts });
      }
      const incoming =
        read.status === "ready" || read.status === "stale"
          ? read.data.filter(activeProposal)
          : [];
      const rows = incoming
        .filter((x) => !this.completed.has(x.proposal.proposalId))
        .filter((x) => !this.state.attempts.has(x.proposal.proposalId));
      // Reserve pending/acknowledged slots even when the read omits terminal proposals.
      // Other rows still receive the provider's fresh content and ordering.
      this.state.rows.forEach((row, index) => {
        const id = row.proposal.proposalId;
        const attempt = this.state.attempts.get(id);
        if (attempt && !this.completed.has(id))
          rows.splice(Math.min(index, rows.length), 0, attempt.item);
      });
      const selectedId = rows.some(
        (x) => x.proposal.proposalId === this.state.selectedId,
      )
        ? this.state.selectedId
        : (rows[0]?.proposal.proposalId ?? null);
      this.publish({ read, rows, selectedId, refreshing: false });
    } catch {
      if (!this.access || generation !== this.generation) return;
      const read: OpportunityCollection = this.state.rows.length
        ? {
            status: "stale",
            data: this.state.rows,
            reason: "Could not refresh proposals. Actions are paused.",
          }
        : {
            status: "unavailable",
            reason: "Opportunities could not be loaded.",
          };
      this.publish({ read, refreshing: false });
    }
  }
  select(id: string) {
    if (
      !this.access ||
      this.retired ||
      !this.state.rows.some((x) => x.proposal.proposalId === id)
    )
      return;
    this.publish({ selectedId: id, phase: "rest" });
  }
  private updateAttempt(id: string, attempt: Attempt) {
    const attempts = new Map(this.state.attempts);
    attempts.set(id, attempt);
    this.publish({ attempts });
  }
  canAct(id: string, decision: Decision) {
    const item = this.state.rows.find((x) => x.proposal.proposalId === id);
    return (
      !!item &&
      !!id &&
      !!item.proposal.revision &&
      activeProposal(item) &&
      this.access &&
      this.writeAccess &&
      !this.retired &&
      this.state.read.status === "ready" &&
      !this.state.refreshing &&
      !this.state.attempts.has(id) &&
      (decision === "dismiss" || !approvalBlock(item))
    );
  }
  async act(id: string, decision: Decision) {
    if (!this.canAct(id, decision)) return;
    const item = this.state.rows.find((x) => x.proposal.proposalId === id)!;
    const index = this.state.rows.indexOf(item);
    const attempt: Attempt = {
      item,
      successors: [
        ...this.state.rows.slice(index + 1),
        ...this.state.rows.slice(0, index).reverse(),
      ].map((row) => row.proposal.proposalId),
      request: {
        proposalId: id,
        revision: item.proposal.revision,
        decision,
        idempotencyKey: crypto.randomUUID(),
      },
      state: "sending",
    };
    this.updateAttempt(id, attempt);
    try {
      this.receive(attempt, await this.port.act(attempt.request));
    } catch {
      if (!this.retired)
        this.updateAttempt(id, { ...attempt, state: "unknown" });
    }
  }
  async recover(id: string) {
    const attempt = this.state.attempts.get(id);
    if (
      !this.access ||
      this.retired ||
      !attempt ||
      attempt.state === "sending" ||
      attempt.state === "refused" ||
      attempt.checking ||
      this.completed.has(id)
    )
      return;
    this.updateAttempt(id, { ...attempt, checking: true });
    try {
      this.receive(attempt, await this.port.recover(attempt.request));
    } catch {
      if (!this.retired)
        this.updateAttempt(id, { ...attempt, checking: false });
    }
  }
  private receive(
    attempt: Attempt,
    receipt: ActionReceipt | ActionRefusal | null,
  ) {
    if (this.retired) return;
    const id = attempt.request.proposalId;
    if (receipt && "state" in receipt) {
      const valid =
        receipt.state === "refused" &&
        receipt.proposalId === attempt.request.proposalId &&
        receipt.revision === attempt.request.revision &&
        receipt.decision === attempt.request.decision &&
        !!receipt.reason;
      this.updateAttempt(id, {
        ...attempt,
        state: valid ? "refused" : "unknown",
        reason: valid ? receipt.reason : undefined,
        checking: false,
      });
      return;
    }
    if (!matchesReceipt(attempt.request, attempt.item, receipt)) {
      this.updateAttempt(id, {
        ...attempt,
        state: attempt.receipt ? "receipt" : "unknown",
        checking: false,
      });
      return;
    }
    if (attempt.receipt && receipt.updatedAt < attempt.receipt.updatedAt) {
      this.updateAttempt(id, { ...attempt, checking: false });
      return;
    }
    this.updateAttempt(id, {
      ...attempt,
      receipt,
      state: "receipt",
      checking: false,
    });
    if (!resolvedReceipt(receipt) || this.transitions.has(id)) return;
    this.transitions.add(id);
    const selected = this.state.selectedId === id;
    this.publish({
      ...(selected ? { phase: "acknowledge" as const } : {}),
      message: receiptMessage(receipt),
    });
    this.later(
      () => {
        if (this.state.selectedId === id) this.publish({ phase: "exit" });
        this.later(() => {
          this.completed.add(id);
          const rows = this.state.rows.filter(
            (x) => x.proposal.proposalId !== id,
          );
          const advancing = this.state.selectedId === id;
          const selectedId = advancing
            ? (attempt.successors.find((candidate) =>
                rows.some((row) => row.proposal.proposalId === candidate),
              ) ??
              rows[0]?.proposal.proposalId ??
              null)
            : this.state.selectedId;
          this.publish({
            rows,
            selectedId,
            ...(advancing ? { phase: "enter" as const } : {}),
          });
          if (advancing)
            this.later(
              () => this.publish({ phase: "rest" }),
              this.timings.enter,
            );
        }, this.timings.exit);
      },
      attempt.request.decision === "approve"
        ? this.timings.acknowledge
        : this.timings.dismiss,
    );
  }
  retire() {
    this.retired = true;
    this.generation++;
    this.timers.forEach(clearTimeout);
    this.timers.clear();
    this.listeners.clear();
  }
}
