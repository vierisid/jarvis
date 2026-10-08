import type { BriefReadState } from "../contracts";
import {
  validCollection,
  visibleGoals,
  type GoalCollection,
  type GoalFilter,
  type GoalsPort,
  type GoalTab,
} from "./model";

export interface GoalsState {
  read: BriefReadState<GoalCollection>;
  tab: GoalTab;
  filter: GoalFilter;
  selectedId: string | null;
}
/** One authenticated owner. Retain it across room mounts; retire it on scope change. */
export class GoalsController {
  readonly source;
  readonly scopeId;
  private state: GoalsState = {
    read: { status: "loading" },
    tab: "active",
    filter: "active",
    selectedId: null,
  };
  private listeners = new Set<() => void>();
  private selected = new Map<string, string>();
  private generation = 0;
  private alive = true;
  private access = false;
  readonly positions = new Map<string, number>();
  constructor(private port: GoalsPort) {
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
  private publish(patch: Partial<GoalsState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  private key = () => `${this.state.tab}:${this.state.filter}`;
  rows = () => ("data" in this.state.read ? this.state.read.data : []);
  visible = () => visibleGoals(this.rows(), this.state.tab, this.state.filter);
  private restore() {
    const rows = this.visible();
    const remembered = this.selected.get(this.key());
    const id = rows.some((row) => row.goal.goalId === remembered)
      ? remembered!
      : (rows[0]?.goal.goalId ?? null);
    if (id) this.selected.set(this.key(), id);
    this.publish({ selectedId: id });
  }
  setAccess(allowed: boolean) {
    if (!this.alive || this.access === allowed) return;
    this.access = allowed;
    if (allowed) void this.refresh();
    else {
      this.generation++;
      this.selected.clear();
      this.positions.clear();
      this.publish({
        read: { status: "unavailable", reason: "Goals are unavailable here." },
        selectedId: null,
      });
    }
  }
  async refresh() {
    if (!this.alive || !this.access) return;
    const generation = ++this.generation;
    this.publish({
      read:
        "data" in this.state.read
          ? {
              status: "stale",
              data: this.state.read.data,
              reason: "Refreshing goals…",
            }
          : { status: "loading" },
    });
    try {
      const read = await this.port.read();
      if (!this.alive || !this.access || this.generation !== generation) return;
      if ("data" in read && !validCollection(read.data))
        throw new Error("Invalid goal projection");
      this.publish({ read });
      this.restore();
    } catch {
      if (!this.alive || !this.access || this.generation !== generation) return;
      this.publish({
        read:
          "data" in this.state.read
            ? {
                status: "stale",
                data: this.state.read.data,
                reason: "Could not refresh goals. Showing the last read.",
              }
            : { status: "unavailable", reason: "Goals could not be loaded." },
      });
    }
  }
  setTab(tab: GoalTab) {
    if (this.state.tab !== tab) {
      this.publish({ tab });
      this.restore();
    }
  }
  setFilter(filter: GoalFilter) {
    if (this.state.filter !== filter) {
      this.publish({ filter });
      this.restore();
    }
  }
  select(id: string) {
    if (!this.visible().some((row) => row.goal.goalId === id)) return false;
    this.selected.set(this.key(), id);
    this.publish({ selectedId: id });
    return true;
  }
  open(id: string) {
    const row = this.rows().find((row) => row.goal.goalId === id);
    if (!row) return false;
    this.publish({
      tab: row.goal.status === "completed" ? "completed" : "active",
      filter:
        row.goal.status === "completed" || this.state.filter === "all"
          ? this.state.filter
          : row.goal.status,
    });
    return this.select(id);
  }
  retire() {
    this.alive = false;
    this.access = false;
    this.generation++;
    this.listeners.clear();
    this.selected.clear();
    this.positions.clear();
    this.state = {
      ...this.state,
      read: { status: "unavailable", reason: "Session ended." },
      selectedId: null,
    };
  }
}
