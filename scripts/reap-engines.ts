#!/usr/bin/env bun
/**
 * Reclaim engine subprocesses whose owner is gone, and report what was found.
 *
 * Used by the pre-commit hook after the test step, where it replaces a
 * `pkill -f "engine-bundle"` that could never have worked: the engine's
 * command line is `bun --smol ~/.jarvis/cache/engine/<hash>/main.js`, so that
 * pattern matched nothing at all. The next pattern someone reached for would
 * have had the opposite problem -- `pkill -f main.js` on a machine running
 * several checkouts kills other people's work.
 *
 * This reaps by identity instead: our versioned marker in the process
 * environment, our uid, an argv naming its own recorded bundle, and an owner
 * that is provably gone. A pooled engine belonging to a running daemon is
 * left alone, which is the whole point -- the engine is pooled across runs by
 * design (#491).
 *
 *   bun run scripts/reap-engines.ts              # reap, exit 0
 *   bun run scripts/reap-engines.ts --dry-run    # report only
 *   bun run scripts/reap-engines.ts --fail-on-leak  # exit 1 if any was found
 */

import {
  findEngineProcesses,
  reapOrphanedEngines,
} from "../src/workflows/runner/engine-runtime/engine-reaper";

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const failOnLeak = args.has("--fail-on-leak");

const all = findEngineProcesses();
const orphans = all.filter((e) => e.orphaned);
const live = all.filter((e) => !e.orphaned);

for (const e of live) {
  console.log(
    `[reap-engines] engine pid ${e.pid} is owned by live pid ${e.ownerPid}; leaving it alone`,
  );
}

if (orphans.length === 0) {
  console.log("[reap-engines] no orphaned engine subprocesses");
  process.exit(0);
}

for (const e of orphans) {
  const age = e.startedAt
    ? `${Math.round((Date.now() - e.startedAt) / 60_000)}min old`
    : "age unknown";
  console.log(
    `[reap-engines] ORPHAN pid ${e.pid} (owner ${e.ownerPid} gone, ${age}, bundle ${e.bundlePath})`,
  );
}

if (dryRun) {
  console.log(`[reap-engines] --dry-run: left ${orphans.length} orphan(s) alone`);
  process.exit(failOnLeak ? 1 : 0);
}

const { reaped } = await reapOrphanedEngines({
  log: (line) => console.log(`[reap-engines] ${line}`),
});
console.log(`[reap-engines] reclaimed ${reaped.length} orphaned engine subprocess(es)`);
process.exit(failOnLeak && reaped.length > 0 ? 1 : 0);
