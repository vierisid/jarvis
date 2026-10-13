import {
  readSettings,
  type SettingsValue,
  type SettingsPort,
  type SettingsDestination,
  type Application,
} from "./model";
export interface SettingsState {
  availability:
    "loading" | "ready" | "stale" | "error" | "unsupported" | "unavailable";
  base: SettingsValue | null;
  draft: string | null;
  phase: "clean" | "saving" | "saved" | "unknown" | "conflict" | "error";
  reading: boolean;
  discarding: boolean;
  message: string;
  replay:
    "idle" | "confirm" | "pending" | "replayed" | "unknown" | "unavailable";
  actionMessage: string;
}
const initial = (): SettingsState => ({
  availability: "loading",
  base: null,
  draft: null,
  phase: "clean",
  reading: false,
  discarding: false,
  message: "",
  replay: "idle",
  actionMessage: "",
});
const UNKNOWN =
  "Save not confirmed. Retry checks the current voice before saving again.";
const CONFLICT =
  "Voice settings changed elsewhere. Discard your change to reload.";
const savedMessage = (application: Application) =>
  application === "applied"
    ? "Voice saved and applied."
    : application === "restart_required"
      ? "Voice saved. Restart Jarvis to apply it."
      : application === "failed"
        ? "Voice saved, but could not be applied. Open voice settings."
        : "Selected voice is saved. Live application is unconfirmed.";
export class SettingsController {
  readonly scopeId;
  readonly source;
  readonly canWrite;
  readonly destinations;
  readonly canReplayTutorial;
  private state = initial();
  private access = false;
  private alive = true;
  private generation = 0;
  private scope = 0;
  private abort?: AbortController;
  private attempted: string | null = null;
  private savedNotice: { revision: string; message: string } | null = null;
  private listeners = new Set<() => void>();
  constructor(private port: SettingsPort) {
    this.scopeId = port.scopeId;
    this.source = port.source;
    this.canWrite = port.canWrite;
    this.destinations = port.destinations;
    this.canReplayTutorial = port.canReplayTutorial;
  }
  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(patch: Partial<SettingsState>) {
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
  setAccess(access: boolean) {
    if (!this.alive || this.access === access) return;
    this.access = access;
    this.scope++;
    if (access) void this.refresh();
    else {
      this.abort?.abort();
      this.generation++;
      this.attempted = null;
      this.savedNotice = null;
      this.publish({ ...initial(), availability: "unavailable" });
    }
  }
  private unavailable(availability: "unavailable" | "unsupported") {
    this.scope++;
    this.attempted = null;
    this.savedNotice = null;
    this.publish({ ...initial(), availability });
  }
  editable = () =>
    this.alive &&
    this.access &&
    this.canWrite &&
    this.state.availability === "ready" &&
    this.state.base?.voice.state === "editable" &&
    !this.state.discarding &&
    !["saving", "conflict"].includes(this.state.phase) &&
    !["confirm", "pending", "unknown"].includes(this.state.replay);
  value = () => this.state.draft ?? this.state.base?.voice.voice ?? "";
  async refresh(discard = false) {
    if (
      !this.alive ||
      !this.access ||
      this.state.phase === "saving" ||
      this.state.replay === "pending" ||
      (this.state.reading && !discard)
    )
      return;
    const op = this.operation();
    this.publish({ reading: true, discarding: discard });
    try {
      const result = await this.port.read(op.signal);
      if (!op.current()) return;
      const data =
        result.state === "ready"
          ? readSettings({ contractVersion: 1, ...result.data })
          : null;
      if (data) {
        if (discard || this.state.draft === null) {
          this.attempted = null;
          if (discard || this.savedNotice?.revision !== data.voice.revision)
            this.savedNotice = null;
          this.publish({
            base: data,
            draft: null,
            availability: "ready",
            phase: this.savedNotice ? "saved" : "clean",
            message: this.savedNotice?.message ?? "",
          });
        } else this.publish({ availability: "ready" });
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
      message: "Could not load current settings. Your selection is still here.",
    });
  }
  private saved(data: SettingsValue, application: Application) {
    this.attempted = null;
    const message = savedMessage(application);
    this.savedNotice = { revision: data.voice.revision, message };
    this.publish({ base: data, draft: null, phase: "saved", message });
  }
  async selectVoice(voice: string) {
    if (
      !this.editable() ||
      !this.state.base?.voice.choices.some((c) => c.id === voice)
    )
      return;
    if (this.state.draft === null && voice === this.state.base.voice.voice)
      return;
    this.publish({ draft: voice });
    await this.save();
  }
  async save() {
    const base = this.state.base,
      selected = this.state.draft;
    if (
      !this.editable() ||
      !base ||
      selected === null ||
      !base.voice.choices.some((c) => c.id === selected)
    )
      return;
    const uncertain = this.state.phase === "unknown",
      previous = this.attempted,
      op = this.operation();
    this.publish({ phase: "saving", message: "Saving voice…", reading: false });
    try {
      let revision = base.voice.revision;
      if (uncertain) {
        const fresh = await this.port.read(op.signal);
        if (!op.current()) return;
        if (fresh.state === "unavailable" || fresh.state === "unsupported") {
          this.unavailable(fresh.state);
          return;
        }
        const current =
          fresh.state === "ready"
            ? readSettings({ contractVersion: 1, ...fresh.data })
            : null;
        if (!current) {
          this.publish({ phase: "unknown", message: UNKNOWN });
          return;
        }
        if (
          current.setup.deployment !== base.setup.deployment ||
          current.voice.provider !== base.voice.provider ||
          current.voice.state !== "editable" ||
          !current.voice.choices.some((c) => c.id === selected) ||
          (current.voice.revision !== base.voice.revision &&
            current.voice.voice !== previous)
        ) {
          this.publish({ phase: "conflict", message: CONFLICT });
          return;
        }
        if (current.voice.voice === selected && selected === previous) {
          this.saved(current, "unknown");
          return;
        }
        revision = current.voice.revision;
      }
      this.attempted = selected;
      const result = await this.port.saveVoice(revision, selected, op.signal);
      if (!op.current()) return;
      const data =
        result.state === "confirmed"
          ? readSettings({ contractVersion: 1, ...result.data })
          : null;
      if (
        data &&
        data.voice.voice === selected &&
        data.voice.provider === base.voice.provider &&
        result.state === "confirmed"
      ) {
        this.saved(data, result.application);
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
            "Voice could not be saved. Choose a supported voice or retry.",
        });
      else this.publish({ phase: "unknown", message: UNKNOWN });
    } catch {
      if (op.current()) this.publish({ phase: "unknown", message: UNKNOWN });
    }
  }
  async navigate(destination: SettingsDestination) {
    if (
      !this.alive ||
      !this.access ||
      !this.destinations[destination] ||
      this.state.replay === "pending"
    )
      return;
    const scope = this.scope;
    try {
      const result = await this.port.navigate(destination);
      if (
        this.alive &&
        this.access &&
        scope === this.scope &&
        result.state !== "opened"
      )
        this.publish({
          actionMessage: "This destination is unavailable. Try again later.",
        });
    } catch {
      if (this.alive && this.access && scope === this.scope)
        this.publish({
          actionMessage: "This destination is unavailable. Try again later.",
        });
    }
  }
  requestReplay() {
    if (
      !this.alive ||
      !this.access ||
      !this.canWrite ||
      !this.canReplayTutorial ||
      this.state.availability !== "ready" ||
      !this.state.base?.replay.includes("tutorial") ||
      this.state.draft !== null ||
      this.state.phase === "saving" ||
      ["pending", "unknown", "replayed"].includes(this.state.replay)
    )
      return;
    this.publish({ replay: "confirm", actionMessage: "" });
  }
  async confirmReplay(confirmed: boolean) {
    if (!this.alive || !this.access || this.state.replay !== "confirm") return;
    if (!confirmed) {
      this.publish({ replay: "idle" });
      return;
    }
    const scope = this.scope;
    this.publish({ replay: "pending", actionMessage: "Opening tutorial…" });
    try {
      const result = await this.port.replayTutorial();
      if (!this.alive || !this.access || scope !== this.scope) return;
      this.publish({
        replay: result.state,
        actionMessage:
          result.state === "replayed"
            ? "Tutorial reopened."
            : result.state === "unavailable"
              ? "Tutorial replay is unavailable here."
              : "Tutorial replay could not be confirmed. Reload before trying again.",
      });
    } catch {
      if (this.alive && this.access && scope === this.scope)
        this.publish({
          replay: "unknown",
          actionMessage:
            "Tutorial replay could not be confirmed. Reload before trying again.",
        });
    }
  }
  retire() {
    this.setAccess(false);
    this.alive = false;
    this.abort?.abort();
    this.listeners.clear();
  }
}
