/**
 * Settings hot reload: applies DB-backed settings to the running daemon
 * without a restart.
 *
 * A per-section registry of async appliers with one serialized apply queue.
 * Change events fire at the write choke point (user-settings.ts calls the
 * listener installed via setSectionSavedListener), so every writer — HTTP
 * routes, voice intents, pebble toggles — triggers the appliers with zero
 * per-callsite wiring. Routes that want to report the apply outcome call
 * applyNow(section), which cancels the scheduled run so nothing runs twice.
 *
 * reloadAll() re-runs the exact boot hydration (mergeLLMSettingsIntoConfig →
 * mergeUserSettingsIntoConfig → applyEnvOverrides, same order as
 * daemon/index.ts, so env still wins), diffs JSON snapshots per section, and
 * runs appliers for changed sections only. It backs POST /api/config/reload
 * and SIGHUP, covering settings edited outside the daemon process.
 *
 * This is deliberately NOT the workflow event bus: appliers must be
 * awaitable, must not become workflow trigger types, and must never mirror
 * into the /v1/jarvis/events/poll buffer.
 *
 * Rules for appliers:
 * - Idempotent: the choke-point hook can fire after a route already applied
 *   the same change by hand; a double apply must be harmless.
 * - Never write their own section (saveUserSection from inside an applier
 *   for that section would loop; coalescing bounds it, but don't).
 * - Read the live config passed in — events carry section names only, never
 *   values, so tokens/keys stay out of the event path.
 *
 * Sections whose config is re-hydrated but that have no component applier
 * yet (cron schedules, heartbeat aggressiveness, goals, sites, desktop,
 * workflows, ...) keep today's behavior: new values are visible to live
 * config readers, construction-time snapshots stay until restart.
 *
 * Known limitation: reloadAll() detects changes to CONFIG SECTIONS only.
 * State living outside the settings table — e.g. the Google tokens file —
 * doesn't show up in the diff, so deleting google-tokens.json externally
 * and sending SIGHUP won't deactivate observers (the in-daemon disconnect
 * route handles that case via applyNow('google')).
 */

import { applyEnvOverrides } from '../config/loader.ts';
import { USER_OWNED_SECTIONS, type JarvisConfig, type UserOwnedSection } from '../config/types.ts';
import { mergeLLMSettingsIntoConfig } from './llm-settings.ts';
import { mergeUserSettingsIntoConfig } from './user-settings.ts';

export type ReloadSection = UserOwnedSection | 'llm' | 'google';
export type SectionApplier = (config: JarvisConfig) => void | Promise<void>;

export interface ApplyError {
  section: ReloadSection;
  error: string;
}

export interface ReloadResult {
  /** Sections whose config value changed during re-hydration. */
  changed: ReloadSection[];
  /** Changed sections that had appliers registered (and were run). */
  applied: ReloadSection[];
  errors: ApplyError[];
}

export interface SettingsAppliedPayload {
  sections: string[];
  ok: boolean;
  errors: ApplyError[];
}

const RELOAD_SECTIONS: readonly ReloadSection[] = [...USER_OWNED_SECTIONS, 'llm', 'google'];

interface RegisteredApplier {
  fn: SectionApplier;
  debounceMs: number;
}

interface PendingApply {
  timer: ReturnType<typeof setTimeout>;
}

export class SettingsReloadCoordinator {
  private readonly config: JarvisConfig;
  private readonly appliers = new Map<ReloadSection, RegisteredApplier[]>();
  private readonly pending = new Map<ReloadSection, PendingApply>();
  /** Single-flight chain: no two appliers ever run concurrently. */
  private queue: Promise<unknown> = Promise.resolve();
  private broadcast: ((payload: SettingsAppliedPayload) => void) | null = null;

  constructor(config: JarvisConfig) {
    this.config = config;
  }

  /**
   * Register an applier for a section. Multiple appliers per section
   * accumulate and run in registration order. debounceMs delays the
   * scheduled run after sectionChanged (repeat changes restart the timer);
   * applyNow bypasses it.
   */
  registerApplier(
    section: ReloadSection,
    applier: SectionApplier,
    opts?: { debounceMs?: number },
  ): void {
    const list = this.appliers.get(section) ?? [];
    list.push({ fn: applier, debounceMs: Math.max(0, opts?.debounceMs ?? 0) });
    this.appliers.set(section, list);
  }

  /** Called after every apply batch (single-section or reloadAll). */
  setBroadcast(fn: ((payload: SettingsAppliedPayload) => void) | null): void {
    this.broadcast = fn;
  }

  /**
   * Fire-and-forget: schedule a coalesced apply for the section. No-op when
   * the section has no appliers. A repeat call while one is pending restarts
   * the debounce timer — appliers read live config, so latest state wins.
   */
  sectionChanged(section: ReloadSection): void {
    const list = this.appliers.get(section);
    if (!list || list.length === 0) return;

    const delay = Math.max(...list.map((a) => a.debounceMs));
    const existing = this.pending.get(section);
    if (existing) clearTimeout(existing.timer);
    this.pending.set(section, {
      timer: setTimeout(() => void this.flush(section), delay),
    });
  }

  /**
   * Cancel any pending debounce for the section and run its appliers now
   * (still serialized behind in-flight applies). Resolves null on success,
   * the first ApplyError otherwise. No-op (null) when no appliers exist.
   */
  applyNow(section: ReloadSection): Promise<ApplyError | null> {
    const list = this.appliers.get(section);
    if (!list || list.length === 0) return Promise.resolve(null);
    return this.flush(section);
  }

  /**
   * Full re-hydrate from DB + env, diff per-section JSON snapshots, run
   * appliers for changed sections only. Serialized behind other applies.
   */
  reloadAll(): Promise<ReloadResult> {
    return this.enqueue(async () => {
      const before = new Map<ReloadSection, string>();
      for (const section of RELOAD_SECTIONS) {
        before.set(section, this.snapshot(section));
      }

      // Exact boot hydration order (daemon/index.ts): LLM, then user
      // sections, then env overrides so a JARVIS_* pin still wins.
      mergeLLMSettingsIntoConfig(this.config);
      mergeUserSettingsIntoConfig(this.config);
      applyEnvOverrides(this.config);

      const changed = RELOAD_SECTIONS.filter((s) => this.snapshot(s) !== before.get(s));
      const applied: ReloadSection[] = [];
      const errors: ApplyError[] = [];
      for (const section of changed) {
        // A scheduled apply for this section is now redundant (appliers are
        // idempotent, but no point running twice).
        this.cancelPending(section);
        if (!this.appliers.get(section)?.length) continue;
        applied.push(section);
        errors.push(...(await this.runAppliers(section)));
      }

      if (changed.length > 0) {
        this.emitBroadcast({ sections: [...changed], ok: errors.length === 0, errors });
      }
      return { changed, applied, errors };
    });
  }

  /** Resolves once every pending debounce has flushed and the queue drained. */
  async whenIdle(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.all([...this.pending.keys()].map((s) => this.flush(s)));
    }
    await this.queue;
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private snapshot(section: ReloadSection): string {
    return JSON.stringify((this.config as Record<string, unknown>)[section] ?? null);
  }

  /** Drop a scheduled apply (reloadAll runs the section's appliers itself). */
  private cancelPending(section: ReloadSection): void {
    const entry = this.pending.get(section);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(section);
  }

  private flush(section: ReloadSection): Promise<ApplyError | null> {
    this.cancelPending(section);

    return this.enqueue(async () => {
      const errors = await this.runAppliers(section);
      this.emitBroadcast({ sections: [section], ok: errors.length === 0, errors });
      return errors[0] ?? null;
    });
  }

  private async runAppliers(section: ReloadSection): Promise<ApplyError[]> {
    const errors: ApplyError[] = [];
    for (const { fn } of this.appliers.get(section) ?? []) {
      try {
        await fn(this.config);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[SettingsReload] Applier for '${section}' failed: ${message}`);
        errors.push({ section, error: message });
      }
    }
    return errors;
  }

  /** Chain a job onto the single-flight queue; failures never break the chain. */
  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.queue.then(job);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private emitBroadcast(payload: SettingsAppliedPayload): void {
    try {
      this.broadcast?.(payload);
    } catch (err) {
      console.error('[SettingsReload] Broadcast failed:', err);
    }
  }
}
