/**
 * The engine subprocess's own lifecycle contract: the marker env vars every
 * spawned engine carries, and the JS shim that is prepended to the bundle so
 * the engine dies when it is told to, or when nobody is left to tell it.
 *
 * WHY A SHIM AND NOT A VENDORED PATCH
 *
 * The engine ignores SIGTERM today, and it is not an accident of upstream's
 * design so much as a side effect of one line:
 *
 *   packages/server/engine/src/lib/handler/run-progress.ts
 *     process.on('SIGTERM', () => void runProgressService.shutdown())
 *     process.on('SIGINT',  () => void runProgressService.shutdown())
 *
 * Registering ANY listener for SIGTERM removes the runtime's default
 * "terminate on SIGTERM" behaviour. Upstream's listener only flushes run
 * progress; nothing ever exits. So the process flushes and keeps running
 * forever, which is exactly what #491 observed: `kill -TERM` did nothing and
 * the orphan had to be SIGKILLed by hand.
 *
 * The fix lives in the esbuild BANNER (see ENGINE_ESBUILD_CONFIG in build.ts)
 * rather than in the vendored file for three reasons:
 *
 *   1. The banner is our own code. A vendored edit has to be re-applied by
 *      every upstream sync and registered in PATCHED_VENDOR_SOURCES; the
 *      banner survives a sync untouched.
 *   2. The banner runs before ANY module is imported, so the handler is
 *      installed before upstream's, and listeners fire in registration
 *      order, which means upstream's flush still runs, it just now runs
 *      inside a bounded window that ends in an exit.
 *   3. The banner is already inside `bundleHash()` (the config object is
 *      JSON-stringified into the key, and `banner` is a getter), so editing
 *      this shim invalidates cached bundles instead of leaving old engines
 *      running the old behaviour.
 *
 * THE ORPHAN WATCHDOG
 *
 * A polite killer is no use when the killer is dead. The leak in #491 was a
 * test-runner process that was SIGKILLed (the pre-commit hook's
 * `timeout --kill-after`), which runs no teardown at all; the engine was
 * reparented to init and stayed up for 82 minutes. So the engine also checks
 * whether its spawner is still alive, and leaves when it is not. This is the
 * only mitigation that works when the owner dies without warning, and it
 * needs no external reaper.
 *
 * It probes the owner's pid with signal 0 rather than watching its own
 * `process.ppid`. Two reasons, one of them fatal:
 *
 *   - Bun captures `process.ppid` once at startup as a plain data property,
 *     so a reparented engine keeps reporting its original parent forever. A
 *     ppid-based watchdog is simply inert on the runtime the engine actually
 *     runs on (measured; under Node the same code would work, which is how a
 *     watchdog like that passes a test and still never fires in production).
 *   - Testing `ppid === 1` is wrong anyway: in a container the daemon itself
 *     can be pid 1, and its engines would look orphaned from birth.
 *
 * Pid reuse is the one hole in a pid probe, so the owner's process start time
 * travels with the pid (`/proc/<pid>/stat` field 22, Linux) and a mismatch
 * counts as "owner gone". Where procfs is unavailable the probe degrades to
 * the pid alone.
 *
 * Note the shim treats an EPERM from that probe as "owner alive" while
 * `engine-reaper.ts` treats it as "pid recycled". Both err toward doing
 * nothing in their own context -- here, staying up; there, not signalling on
 * that basis alone -- so they are deliberately different, not inconsistent.
 */

/** Env var marking a process as an engine WE spawned. Value is versioned so a
 * future format change can't be misread by an older reaper. */
export const ENGINE_MARKER_ENV = "JARVIS_ENGINE_MARKER";
export const ENGINE_MARKER_VALUE = "jarvis-engine-v1";
/** Pid of the process that spawned this engine (the owner). */
export const ENGINE_OWNER_PID_ENV = "JARVIS_ENGINE_OWNER_PID";
/**
 * The owner's process start time (`/proc/<pid>/stat` field 22, in clock
 * ticks since boot). Pids are reused; this makes "is my owner still alive?"
 * mean the same process rather than merely the same number. Absent on
 * platforms without procfs.
 */
export const ENGINE_OWNER_START_ENV = "JARVIS_ENGINE_OWNER_START";
/** Absolute path of the bundle the engine is running. */
export const ENGINE_BUNDLE_ENV = "JARVIS_ENGINE_BUNDLE";
/** Epoch ms at spawn: lets a reaper report the age of what it reclaimed. */
export const ENGINE_STARTED_AT_ENV = "JARVIS_ENGINE_STARTED_AT";
/**
 * How long the engine keeps running after SIGTERM so upstream's own
 * (asynchronous) run-progress flush can finish, before it exits anyway.
 *
 * Normally NOT set by hand: `spawnEngine` derives it from the owner's own
 * SIGKILL deadline so the two cannot drift apart (a flush window that
 * outlives the deadline behind it means being killed mid-flush every time).
 * Set explicitly, it wins, and a value at or above that deadline is warned
 * about at spawn. The constant below applies only to an engine started with
 * no owner deadline at all.
 */
export const ENGINE_SHUTDOWN_GRACE_ENV = "JARVIS_ENGINE_SHUTDOWN_GRACE_MS";
/** Orphan-watchdog poll interval. Default 5000ms; 0 disables the watchdog. */
export const ENGINE_ORPHAN_POLL_ENV = "JARVIS_ENGINE_ORPHAN_POLL_MS";

export const ENGINE_SHUTDOWN_GRACE_DEFAULT_MS = 1_000;
export const ENGINE_ORPHAN_POLL_DEFAULT_MS = 5_000;

/**
 * Prepended to the engine bundle ahead of everything else.
 *
 * Deliberately ES5-flavoured, dependency-free and wrapped in a try/catch-free
 * IIFE of its own: it runs before any module of the engine exists, so it
 * cannot reach for a logger, and a throw here would take the engine down at
 * boot. Every observable effect is guarded.
 *
 * Note the two unref()s. Neither the grace timer nor the watchdog interval may
 * hold the event loop open by itself: an engine whose work is done should
 * still be allowed to exit naturally.
 */
export const ENGINE_LIFECYCLE_SHIM = `(() => {
  var env = process.env;
  var num = function (raw, fallback) {
    var n = Number.parseInt(String(raw == null ? "" : raw), 10);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  var graceMs = num(env[${JSON.stringify(ENGINE_SHUTDOWN_GRACE_ENV)}], ${ENGINE_SHUTDOWN_GRACE_DEFAULT_MS});
  var pollMs = num(env[${JSON.stringify(ENGINE_ORPHAN_POLL_ENV)}], ${ENGINE_ORPHAN_POLL_DEFAULT_MS});
  var ownerPid = num(env[${JSON.stringify(ENGINE_OWNER_PID_ENV)}], 0);
  var ownerStart = String(env[${JSON.stringify(ENGINE_OWNER_START_ENV)}] || "");
  var shuttingDown = false;
  // Leave the way a process is conventionally expected to when it was
  // signalled: restore the default disposition and re-raise, so whoever is
  // waiting on us sees "terminated by SIGTERM" instead of a clean exit 0 that
  // reads like we finished on our own. The unref'd fallback covers a runtime
  // that swallows the re-raise; the orphan path has no signal to re-raise and
  // just exits.
  var finish = function (signal) {
    if (signal) {
      try {
        process.removeAllListeners(signal);
        process.kill(process.pid, signal);
      } catch (_e) { /* fall through to the fallback below */ }
      var fallback = setTimeout(function () {
        try { process.exit(0); } catch (_e2) { /* already exiting */ }
      }, 200);
      if (fallback && typeof fallback.unref === "function") fallback.unref();
      return;
    }
    try { process.exit(0); } catch (_e3) { /* already exiting */ }
  };
  // First signal: let the listeners registered after this one (upstream's
  // run-progress flush) do their work, then leave regardless. A second signal
  // means the sender is out of patience, so go immediately.
  var beginShutdown = function (signal) {
    if (shuttingDown) { finish(signal); return; }
    shuttingDown = true;
    var timer = setTimeout(function () { finish(signal); }, graceMs);
    if (timer && typeof timer.unref === "function") timer.unref();
  };
  process.on("SIGTERM", function () { beginShutdown("SIGTERM"); });
  process.on("SIGINT", function () { beginShutdown("SIGINT"); });
  // Is the process that spawned us still there? Signal 0 delivers nothing and
  // only reports whether the pid exists; the start-time comparison rules out
  // a recycled pid wearing our owner's number.
  var ownerGone = function () {
    try {
      process.kill(ownerPid, 0);
    } catch (e) {
      return !!(e && (e.code === "ESRCH" || e.errno === -3));
    }
    if (!ownerStart) return false;
    try {
      var stat = require("node:fs").readFileSync("/proc/" + ownerPid + "/stat", "utf8");
      // Field 2 (comm) can contain spaces and parens, so fields are counted
      // from after the LAST ')': the first token there is field 3, making
      // field 22 (starttime) index 19.
      var fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      var startedAt = fields[19];
      if (startedAt && startedAt !== ownerStart) return true;
    } catch (_e) { /* no procfs, or the owner exited mid-read: pid probe stands */ }
    return false;
  };
  // Orphan watchdog: our owner is the only thing that can drive or reclaim
  // us. Once it is gone we are doing work for nobody -- exit rather than sit
  // on timers, sockets and ~100MB until the machine reboots. No grace window
  // on this path: there is nobody left to flush anything to.
  if (ownerPid > 0 && pollMs === 0) {
    // Say so: the var is inherited from the owner's environment, so one stray
    // export disables the watchdog for every engine on the machine, and the
    // symptom (an orphan that lingers) looks exactly like the bug it fixes.
    try {
      process.stderr.write("[engine] orphan watchdog disabled (" + ${JSON.stringify(ENGINE_ORPHAN_POLL_ENV)} + "=0)\\n");
    } catch (_e) { /* no stderr: nothing to do about it */ }
  }
  if (ownerPid > 0 && pollMs > 0) {
    var watchdog = setInterval(function () {
      if (ownerGone()) {
        clearInterval(watchdog);
        finish(null);
      }
    }, pollMs);
    if (watchdog && typeof watchdog.unref === "function") watchdog.unref();
  }
})();`;
