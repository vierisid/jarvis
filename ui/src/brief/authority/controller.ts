import {
  ACTION_CATEGORIES,
  changedValues,
  matchesPatch,
  readSettings,
  sameValues,
  validLevel,
  type ActionCategory,
  type AuthorityDestination,
  type AuthorityField,
  type AuthorityPort,
  type AuthoritySettings,
  type AuthorityValues,
} from "./model";

export interface AuthorityState {
  availability:
    "loading" | "ready" | "stale" | "error" | "unavailable" | "unsupported";
  saved: AuthoritySettings | null;
  draft: AuthorityValues | null;
  phase: "clean" | "dirty" | "saving" | "saved" | "unknown" | "conflict";
  reading: boolean;
  message: string;
  navigationMessage: string;
  retryFields: AuthorityField[];
}
const UNKNOWN_MESSAGE =
  "Save not confirmed. Reload current settings before making another change.";
const RETRY_MESSAGE =
  "The previous save was not confirmed. Retry save to persist these values, or discard the retry.";
const CONFLICT_MESSAGE =
  "Settings changed elsewhere. Reload current settings before editing again.";
const initial = (): AuthorityState => ({
  availability: "loading",
  saved: null,
  draft: null,
  phase: "clean",
  reading: false,
  message: "",
  navigationMessage: "",
  retryFields: [],
});
export class AuthorityController {
  readonly source;
  readonly scopeId;
  readonly destinations;
  readonly canWrite;
  private state = initial();
  private listeners = new Set<() => void>();
  private access = false;
  private alive = true;
  private interacting = false;
  private generation = 0;
  private abort?: AbortController;
  private navigationAbort?: AbortController;
  constructor(private port: AuthorityPort) {
    this.source = port.source;
    this.scopeId = port.scopeId;
    this.destinations = port.destinations;
    this.canWrite = port.canWrite;
  }
  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(patch: Partial<AuthorityState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  private operation() {
    this.abort?.abort();
    const abort = (this.abort = new AbortController()),
      generation = ++this.generation;
    return {
      signal: abort.signal,
      current: () =>
        this.alive && this.access && generation === this.generation,
    };
  }
  setAccess(access: boolean) {
    if (!this.alive || access === this.access) return;
    this.access = access;
    if (access) void this.refresh();
    else {
      this.interacting = false;
      this.generation++;
      this.abort?.abort();
      this.navigationAbort?.abort();
      this.publish({ ...initial(), availability: "unavailable" });
    }
  }
  editable() {
    return (
      this.alive &&
      this.access &&
      this.canWrite &&
      this.state.availability === "ready" &&
      !this.state.reading &&
      ["clean", "dirty", "saved"].includes(this.state.phase)
    );
  }
  beginInteraction = () => {
    if (!this.editable()) return false;
    this.interacting = true;
    return true;
  };
  endInteraction = () => {
    this.interacting = false;
  };
  private edit(draft: AuthorityValues) {
    if (!this.editable() || !this.state.saved) return;
    const dirty =
      this.state.retryFields.length > 0 || !sameValues(draft, this.state.saved);
    this.publish({
      draft,
      phase: dirty ? "dirty" : "clean",
      message: this.state.retryFields.length
        ? RETRY_MESSAGE
        : dirty
          ? "Unsaved changes"
          : "Current settings restored.",
    });
  }
  setLevel(level: number) {
    if (validLevel(level) && this.state.draft)
      this.edit({ ...this.state.draft, default_level: level });
  }
  toggle(category: ActionCategory, on: boolean) {
    if (!ACTION_CATEGORIES.includes(category) || !this.state.draft) return;
    const categories = this.state.draft.governed_categories;
    this.edit({
      ...this.state.draft,
      governed_categories: on
        ? [...new Set([...categories, category])]
        : categories.filter((c) => c !== category),
    });
  }
  async refresh(discard = false) {
    if (
      !this.alive ||
      !this.access ||
      this.interacting ||
      this.state.phase === "saving" ||
      this.state.reading
    )
      return;
    const previous = this.state,
      preserveEdits =
        !discard && ["dirty", "unknown", "conflict"].includes(previous.phase),
      op = this.operation();
    this.publish({ reading: true });
    try {
      const result = await this.port.read(op.signal);
      if (!op.current()) return;
      const data = result.state === "ready" ? readSettings(result.data) : null;
      if (data && preserveEdits && previous.saved)
        this.publish({
          // Poll live emergency status without rebasing or discarding policy edits.
          saved: { ...previous.saved, emergency_state: data.emergency_state },
          availability: "ready",
          message:
            previous.phase === "unknown"
              ? UNKNOWN_MESSAGE
              : previous.phase === "conflict"
                ? CONFLICT_MESSAGE
                : previous.retryFields.length
                  ? RETRY_MESSAGE
                  : "Unsaved changes",
        });
      else if (
        data &&
        previous.phase === "unknown" &&
        previous.draft &&
        previous.retryFields.length
      )
        this.publish({
          saved: data,
          draft: {
            ...data,
            ...changedValues(
              previous.draft,
              previous.draft,
              previous.retryFields,
            ),
          },
          availability: "ready",
          phase: "dirty",
          message: RETRY_MESSAGE,
        });
      else if (data)
        this.publish({
          saved: data,
          draft: structuredClone(data),
          availability: "ready",
          phase: "clean",
          retryFields: [],
          message: previous.retryFields.length
            ? "Retry discarded. Current settings loaded; the previous save was not confirmed."
            : "Current settings loaded.",
        });
      else if (result.state === "unavailable" || result.state === "unsupported")
        this.publish({ ...initial(), availability: result.state });
      else
        this.publish({
          availability: this.state.saved ? "stale" : "error",
          message: "Could not load current settings. Refresh before editing.",
        });
    } catch {
      if (op.current())
        this.publish({
          availability: this.state.saved ? "stale" : "error",
          message: "Could not load current settings. Refresh before editing.",
        });
    } finally {
      if (op.current()) this.publish({ reading: false });
    }
  }
  async save() {
    if (
      this.interacting ||
      !this.editable() ||
      this.state.phase !== "dirty" ||
      !this.state.saved ||
      !this.state.draft
    )
      return;
    const base = structuredClone(this.state.saved),
      draft = structuredClone(this.state.draft),
      retryFields = [...this.state.retryFields],
      patch = changedValues(base, draft, retryFields),
      attemptedFields = Object.keys(patch) as AuthorityField[],
      op = this.operation();
    this.publish({ phase: "saving", message: "Saving changes…" });
    try {
      const result = await this.port.save(base, draft, op.signal, retryFields);
      if (!op.current()) return;
      const data = "data" in result ? readSettings(result.data) : null;
      if (result.state === "confirmed" && data && matchesPatch(data, patch)) {
        this.publish({
          saved: data,
          draft: structuredClone(data),
          phase: "saved",
          retryFields: [],
          message: "Changes saved and checked.",
        });
      } else if (result.state === "conflict" && data) {
        this.publish({
          phase: "conflict",
          message: CONFLICT_MESSAGE,
        });
      } else if (
        result.state === "unavailable" ||
        result.state === "unsupported"
      ) {
        this.publish({ ...initial(), availability: result.state });
      } else this.unknown(attemptedFields);
    } catch {
      if (op.current()) this.unknown(attemptedFields);
    }
  }
  private unknown(retryFields: AuthorityField[]) {
    this.publish({
      phase: "unknown",
      retryFields,
      message: UNKNOWN_MESSAGE,
    });
  }
  async navigate(destination: AuthorityDestination) {
    if (!this.alive || !this.access || !this.destinations[destination]) return;
    this.navigationAbort?.abort();
    const abort = (this.navigationAbort = new AbortController());
    try {
      const result = await this.port.navigate(destination, abort.signal);
      if (!abort.signal.aborted && this.access && this.alive)
        this.publish({
          navigationMessage:
            result.state === "opened"
              ? "Continue in the existing controls."
              : "These controls could not be opened. Try again.",
        });
    } catch {
      if (!abort.signal.aborted && this.access && this.alive)
        this.publish({
          navigationMessage: "These controls could not be opened. Try again.",
        });
    }
  }
  retire() {
    this.setAccess(false);
    this.alive = false;
    this.abort?.abort();
    this.navigationAbort?.abort();
    this.listeners.clear();
  }
}
