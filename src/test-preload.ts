/**
 * Run-level setup for `bun test`, wired in by `bunfig.toml`'s `[test] preload`.
 *
 * Hooks registered here are registered ONCE for the whole run, not per file,
 * so this is the only place a "did the suite leave anything behind?" check can
 * live. Keep it small: everything in here runs for every single `bun test`
 * invocation, including a one-file run.
 *
 * Today it holds exactly one thing.
 *
 * ENGINE LEAK GUARD (#491)
 *
 * An engine subprocess from a test run was once found still alive 82 minutes
 * later, reparented to init, holding timers, socket pairs and ~118MB while
 * doing work for nobody. Nothing failed; nothing even printed. The hazard was
 * invisible, which is why it lasted.
 *
 * So: at the end of the run, any engine this process spawned and has not seen
 * exit is reclaimed and the run FAILS with the pids, sandbox ids and bundles
 * it had to clean up. Same trade as the `NODE_ENV=test` pin guard on the
 * workflow encryption key -- a noisy failure now beats a silent hazard later.
 *
 * Note this only sees engines spawned by THIS process. An engine orphaned by a
 * test runner that was itself SIGKILLed is out of reach from here by
 * definition; that is what the engine's own orphan watchdog and the
 * daemon-start reaper are for.
 */

import { afterAll } from "bun:test";
import { assertNoLeakedEngines } from "./workflows/runner/engine-runtime/spawn";

afterAll(async () => {
  await assertNoLeakedEngines();
});
