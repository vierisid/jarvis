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
 * reloadAll() otherwise detects changes to CONFIG SECTIONS only, so state
 * living outside the settings table does not show up in the diff. The one
 * exception is the Google TOKENS FILE, which is folded into the `google`
 * snapshot (see googleTokensFingerprint): it is written and deleted from
 * outside this process — by hand when self-hosted, by the control plane's
 * deliver/revoke ops when hosted — and without that, SIGHUP would compare
 * identical client creds and leave the observers running on a token that is
 * gone, or inert while a fresh one sits on disk.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { applyEnvOverrides } from '../config/loader.ts';
import { googleTokensPath } from '../integrations/google-auth.ts';
import { USER_OWNED_SECTIONS, type JarvisConfig, type UserOwnedSection } from '../config/types.ts';
import { mergeLLMSettingsIntoConfig } from './llm-settings.ts';
import { clearRealtimeGateCache } from './realtime-gate.ts';
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

/**
 * Content hash of the Google tokens file, or 'absent'.
 *
 * A CONTENT hash rather than size+mtime on purpose: a re-delivery replaces one
 * access token with another of the same length, and two writes inside the same
 * millisecond are entirely possible on the hosted path (deliver then revoke, or
 * a retried delivery). Size+mtime would compare equal and the reload would be
 * skipped — a missed change here means the observers never pick the new token
 * up, which is the exact failure this fingerprint exists to prevent. Hashing a
 * ~500-byte file on a reload is not worth optimising.
 *
 * Only the hash is kept, never the contents: snapshots are held in memory and
 * compared, and a token must not sit in a diff string.
 */
function googleTokensFingerprint(file: string): string {
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 32);
  } catch {
    // Unreadable and absent are the same thing for the observers: no usable
    // credential. Distinguishing them would only add a state nothing acts on.
    return 'absent';
  }
}

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
  private readonly googleTokensFile: string;
  /** Fingerprint of the tokens file as of the last look; see googleTokensChanged. */
  private lastGoogleTokens: string;
  /** Optional pre-hydration hook that re-reads file-authoritative SYSTEM
   * sections (e.g. the usejarvis_ai block) before the DB merge. Injected by
   * the daemon so tests stay hermetic (no config.yaml reads). */
  private readonly reloadSystemSections: ((config: JarvisConfig) => Promise<void>) | null;

  /**
   * `googleTokensPath` is injectable for the same reason GoogleAuth's is: the
   * default resolves through os.homedir(), which Bun fixes at process start and
   * does NOT re-read from $HOME, so a test cannot redirect it any other way.
   */
  constructor(
    config: JarvisConfig,
    opts?: {
      googleTokensPath?: string;
      reloadSystemSections?: (config: JarvisConfig) => Promise<void>;
    },
  ) {
    this.config = config;
    this.googleTokensFile = opts?.googleTokensPath ?? googleTokensPath();
    // Baseline at construction, which is boot: whatever is on disk now is what
    // the daemon's own GoogleAuth was just built from, so the first reload must
    // not report a change and pointlessly restart the observers.
    this.lastGoogleTokens = googleTokensFingerprint(this.googleTokensFile);
    this.reloadSystemSections = opts?.reloadSystemSections ?? null;
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
   * Runs at the end of every reloadAll — SIGHUP and POST /api/config/reload
   * take the same path, so cross-cutting refreshes that are NOT per-section
   * appliers (the pebble realtime re-advertisement, whose trigger is the
   * SYSTEM-owned usejarvis_ai block that no section applier watches) fire on
   * both. Errors are logged, never allowed to fail the reload itself.
   */
  setPostReloadAll(fn: (() => Promise<void>) | null): void {
    this.postReloadAll = fn;
  }

  private postReloadAll: (() => Promise<void>) | null = null;

  /**
   * Re-warm the realtime plan verdict right after the cache is cleared.
   *
   * Separate from postReloadAll on purpose: that hook runs AFTER every section
   * applier, and the appliers take real time. The window this closes is the one
   * between clearing the cache and the dashboard's next poll, so it has to fire
   * at the clear, not at the end.
   */
  setWarmRealtime(fn: (() => void) | null): void {
    this.warmRealtime = fn;
  }

  private warmRealtime: (() => void) | null = null;

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

      // SYSTEM sections are file-authoritative: re-read them first so a
      // provisioner key rotation (or removal of the usejarvis_ai block)
      // lands on SIGHUP / POST /api/config/reload without a daemon restart.
      if (this.reloadSystemSections) {
        try {
          await this.reloadSystemSections(this.config);
        } catch (err) {
          console.warn('[SettingsReload] System-section re-read failed:', err);
        }
      }

      // Exact boot hydration order (daemon/index.ts): LLM, then user
      // sections, then env overrides so a JARVIS_* pin still wins.
      mergeLLMSettingsIntoConfig(this.config);
      mergeUserSettingsIntoConfig(this.config);
      applyEnvOverrides(this.config);

      // A reload is the moment a re-provisioned usejarvis_ai block lands, so
      // any cached realtime plan verdict is now suspect. Cheap to drop: the
      // next voice_start re-asks the catalog once and re-caches.
      clearRealtimeGateCache();
      // ...but re-warm at once rather than waiting for that voice_start. With
      // realtime default-on for hosted tenants, an empty cache reads as
      // "available", which puts the browser into raw-PCM capture — and a
      // refused PCM utterance is DROPPED. Hosted ops SIGHUP us routinely
      // (Google deliver/revoke, and the key rotation that carries a plan
      // change), so without this the lost utterance recurs on every one of
      // them for any tenant with no pebble sidecar to re-advertise.
      if (this.warmRealtime) this.warmRealtime();

      const changed = RELOAD_SECTIONS.filter((s) => this.snapshot(s) !== before.get(s));
      // The hosted deliver/revoke ops write the tokens file and SIGHUP us; the
      // creds in config are untouched, so the section diff above sees nothing.
      if (this.googleTokensChanged() && !changed.includes('google')) changed.push('google');
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
      try {
        await this.postReloadAll?.();
      } catch (err) {
        console.warn('[SettingsReload] post-reload hook failed:', err);
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

  /**
   * Has the Google tokens FILE changed since we last looked?
   *
   * Deliberately not folded into snapshot(): reloadAll's per-section diff
   * compares before/after WITHIN one call, so it answers "did re-hydration
   * change this?" — and the tokens file changes BETWEEN calls, which such a
   * diff can never see. This keeps the last-seen fingerprint on the instance
   * instead, which is the only way to notice an external write.
   *
   * Stateful on purpose, and it updates on read: a change must be reported
   * exactly once, or every subsequent reload would restart the observers.
   */
  private googleTokensChanged(): boolean {
    const fp = googleTokensFingerprint(this.googleTokensFile);
    if (fp === this.lastGoogleTokens) return false;
    this.lastGoogleTokens = fp;
    return true;
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
      // Re-baseline the tokens fingerprint whenever the google appliers run,
      // whatever triggered them. The in-daemon disconnect route deletes the file
      // and calls applyNow('google') itself; without this the fingerprint would
      // still hold the deleted token's hash, and the next SIGHUP would report a
      // change and restart the observers for a disconnect already applied.
      if (section === 'google') this.lastGoogleTokens = googleTokensFingerprint(this.googleTokensFile);
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
