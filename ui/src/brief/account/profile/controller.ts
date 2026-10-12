import {
  draftPatch,
  isField,
  matchesProfilePatch,
  readProfile,
  validPatch,
  type ProfileDraft,
  type ProfileField,
  type ProfilePatch,
  type ProfilePort,
  type ProfileValue,
} from "./model";

export interface ProfileState {
  availability:
    "loading" | "ready" | "stale" | "error" | "unavailable" | "unsupported";
  base: ProfileValue | null;
  draft: ProfileDraft;
  phase:
    "clean" | "dirty" | "saving" | "saved" | "error" | "unknown" | "conflict";
  reading: boolean;
  discarding: boolean;
  message: string;
  prompt: "cancel" | "leave" | null;
}
const initial = (): ProfileState => ({
  availability: "loading",
  base: null,
  draft: {},
  phase: "clean",
  reading: false,
  discarding: false,
  message: "",
  prompt: null,
});
const UNKNOWN =
  "Save not confirmed. Retry checks current values before saving again.";
const CONFLICT =
  "Profile changed elsewhere. Cancel edits to load the current values.";
export class ProfileController {
  readonly scopeId;
  readonly source;
  readonly canWrite;
  private state = initial();
  private listeners = new Set<() => void>();
  private access = false;
  private alive = true;
  private generation = 0;
  private scopeVersion = 0;
  private abort?: AbortController;
  private attempted: ProfilePatch | null = null;
  private leave?: (allowed: boolean) => void;
  constructor(private port: ProfilePort) {
    this.scopeId = port.scopeId;
    this.source = port.source;
    this.canWrite = port.canWrite;
  }
  snapshot = () => this.state;
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  private publish(patch: Partial<ProfileState>) {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn();
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
  hasEdits = () =>
    Object.keys(this.state.draft).length > 0 ||
    ["saving", "unknown", "conflict"].includes(this.state.phase);
  editable = () =>
    this.alive &&
    this.access &&
    this.canWrite &&
    this.state.availability === "ready" &&
    !this.state.discarding &&
    !this.state.prompt &&
    !["unknown", "conflict"].includes(this.state.phase);
  value = (field: ProfileField) =>
    this.state.draft[field] ?? this.state.base?.answers[field] ?? "";
  setAccess(access: boolean) {
    if (!this.alive || this.access === access) return;
    this.access = access;
    ++this.scopeVersion;
    if (access) void this.refresh();
    else {
      ++this.generation;
      this.abort?.abort();
      this.attempted = null;
      this.leave?.(false);
      this.leave = undefined;
      this.publish({ ...initial(), availability: "unavailable" });
    }
  }
  edit(field: ProfileField, value: string) {
    if (!isField(field) || !this.editable() || !this.state.base) return;
    const draft = { ...this.state.draft, [field]: value };
    // During a save, even a return to the old base is a new edit to preserve.
    if (
      this.state.phase !== "saving" &&
      value === (this.state.base.answers[field] ?? "")
    )
      delete draft[field];
    const dirty = Object.keys(draft).length > 0;
    this.publish({
      draft,
      ...(this.state.phase === "saving"
        ? {}
        : {
            phase: dirty ? "dirty" : "clean",
            message: dirty ? "Unsaved changes" : "Current profile restored.",
          }),
    });
  }
  async refresh(discard = false) {
    if (
      !this.alive ||
      !this.access ||
      this.state.phase === "saving" ||
      this.state.reading
    )
      return;
    const op = this.operation();
    this.publish({ reading: true, discarding: discard });
    try {
      const result = await this.port.read(op.signal);
      if (!op.current()) return;
      const data = result.state === "ready" ? readProfile(result.data) : null;
      if (data) {
        if (!discard && this.hasEdits())
          this.publish({
            availability: "ready",
            message:
              this.state.phase === "unknown"
                ? UNKNOWN
                : this.state.phase === "conflict"
                  ? CONFLICT
                  : "Unsaved changes",
          });
        else {
          this.attempted = null;
          this.publish({
            base: data,
            draft: {},
            availability: "ready",
            phase: "clean",
            message: "Current profile loaded.",
          });
        }
      } else if (
        result.state === "unavailable" ||
        result.state === "unsupported"
      )
        this.unavailable(result.state);
      else this.readFailed();
    } catch {
      if (op.current()) this.readFailed();
    } finally {
      if (op.current()) this.publish({ reading: false, discarding: false });
    }
  }
  private readFailed() {
    this.publish({
      availability: this.state.base ? "stale" : "error",
      message: "Could not load the current profile. Your edits are still here.",
    });
  }
  private unavailable(availability: "unavailable" | "unsupported") {
    this.attempted = null;
    this.leave?.(false);
    this.leave = undefined;
    this.publish({ ...initial(), availability });
  }
  async save() {
    if (
      !this.alive ||
      !this.access ||
      !this.canWrite ||
      this.state.availability !== "ready" ||
      !this.state.base ||
      this.state.prompt ||
      this.state.discarding ||
      !["dirty", "error", "unknown"].includes(this.state.phase)
    )
      return;
    const submitted = { ...this.state.draft },
      patch = draftPatch(submitted),
      base = this.state.base,
      uncertain = this.state.phase === "unknown";
    if (
      Object.values(submitted).some((value) => value!.length > 4000) ||
      !validPatch(patch)
    ) {
      this.publish({
        phase: "error",
        message: "Review the highlighted fields before saving.",
      });
      return;
    }
    const op = this.operation();
    this.publish({
      phase: "saving",
      reading: false,
      message: "Saving profile…",
    });
    try {
      let revision = base.revision;
      if (uncertain) {
        const fresh = await this.port.read(op.signal);
        if (!op.current()) return;
        const data = fresh.state === "ready" ? readProfile(fresh.data) : null;
        if (fresh.state === "unavailable" || fresh.state === "unsupported") {
          this.unavailable(fresh.state);
          return;
        }
        if (!data) {
          this.publish({ phase: "unknown", message: UNKNOWN });
          return;
        }
        // F-23 is transactional and revision-bound. Only reconcile an unchanged
        // revision or the exact previously submitted values; never overwrite a correction.
        if (
          data.revision !== base.revision &&
          (!this.attempted || !matchesProfilePatch(data, this.attempted))
        ) {
          this.publish({ phase: "conflict", message: CONFLICT });
          return;
        }
        revision = data.revision;
      }
      this.attempted = patch;
      const result = await this.port.save(revision, patch, op.signal);
      if (!op.current()) return;
      const data =
        result.state === "confirmed" ? readProfile(result.data) : null;
      if (data && matchesProfilePatch(data, patch)) {
        const draft = { ...this.state.draft };
        for (const field of Object.keys(submitted) as ProfileField[])
          if (draft[field] === submitted[field]) delete draft[field];
        this.attempted = null;
        const dirty = Object.keys(draft).length > 0;
        this.publish({
          base: data,
          draft,
          phase: dirty ? "dirty" : "saved",
          message: dirty
            ? "Submitted changes saved. You have newer unsaved edits."
            : "Profile saved and checked.",
        });
      } else if (
        result.state === "unavailable" ||
        result.state === "unsupported"
      )
        this.unavailable(result.state);
      else if (result.state === "conflict")
        this.publish({ phase: "conflict", message: CONFLICT });
      else if (result.state === "invalid")
        this.publish({
          phase: "error",
          message:
            "The profile could not be saved. Check your entries and retry.",
        });
      else this.publish({ phase: "unknown", message: UNKNOWN });
    } catch {
      if (op.current()) this.publish({ phase: "unknown", message: UNKNOWN });
    }
  }
  cancel() {
    if (
      !this.alive ||
      !this.access ||
      this.state.phase === "saving" ||
      this.state.reading
    )
      return;
    if (this.hasEdits()) this.publish({ prompt: "cancel" });
    else void this.refresh();
  }
  async navigateAway(navigate: () => void) {
    const scope = this.scopeVersion;
    if (await this.requestLeave()) {
      if (this.alive && scope === this.scopeVersion) navigate();
    }
  }
  requestLeave(): Promise<boolean> {
    if (!this.alive) return Promise.resolve(false);
    if (!this.access) return Promise.resolve(true);
    if (this.state.phase === "saving") {
      this.publish({ message: "Wait for this save to finish before leaving." });
      return Promise.resolve(false);
    }
    if (!this.hasEdits()) return Promise.resolve(true);
    this.leave?.(false);
    return new Promise((resolve) => {
      this.leave = resolve;
      this.publish({ prompt: "leave" });
    });
  }
  async resolvePrompt(discard: boolean) {
    const prompt = this.state.prompt,
      leave = this.leave;
    this.leave = undefined;
    this.publish({ prompt: null });
    if (!discard) {
      leave?.(false);
      return;
    }
    if (prompt === "leave") {
      this.attempted = null;
      this.publish({
        draft: {},
        phase: "clean",
        message: "Local edits discarded.",
      });
      leave?.(this.alive && this.access);
    } else if (prompt === "cancel") await this.refresh(true);
  }
  retire() {
    this.setAccess(false);
    this.alive = false;
    this.abort?.abort();
    this.listeners.clear();
  }
}
