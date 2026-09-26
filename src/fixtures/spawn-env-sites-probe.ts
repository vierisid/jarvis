/**
 * Per-call-site leak probe for #512. Run as a CHILD process by
 * src/spawn-env-sites.test.ts; the same arrangement as
 * src/sites/fixtures/spawn-env-probe.ts, for the same reason: Bun spawns an
 * inheriting child from the environment snapshot taken at process start, so a
 * canary assigned to `process.env` inside `bun test` is invisible to exactly
 * the spawns that inherit. The test launches this file with the canaries
 * already in its real startup environment.
 *
 * PATH is pointed at a fake `bun` that dumps its own environment and exits 0,
 * so each `bun install` / `bun run` site is asserted against what a real
 * grandchild process received. The CODE-step sandbox is the exception: it runs
 * `process.execPath`, never PATH, so it runs the REAL bun on a code module
 * that returns its own `process.env`, and the probe writes that out.
 *
 * argv: <site> <workDir>
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { noOpCodeSandbox } from '../workflows/activepieces/packages/server/engine/src/lib/core/code/no-op-code-sandbox';
import { catalogById } from '../workflows/pieces-library/catalog';
import { installPiece, runPiecesBunInstall, writeManifest } from '../workflows/pieces-library/installer';
import { reconcilePiecesLibrary } from '../workflows/pieces-library/reconciler';
import { ENGINE_BUILD_PATHS, ensureStagingInstalled } from '../workflows/runner/engine-runtime/build';
import { ensureUiBuilt } from '../daemon/ui-autobuild';

const site = process.argv[2]!;
const workDir = process.argv[3]!;
const dumpDir = join(workDir, 'dumps');
const piecesDir = join(workDir, 'pieces');

/** A real catalog entry: installPiece refuses anything else before it spawns. */
const PIECE = catalogById().values().next().value!;

switch (site) {
  // no-op-code-sandbox.ts: the child that runs a workflow CODE step.
  case 'code-sandbox': {
    // The child inherits this cwd, and a bun child loads a `.env` from its cwd
    // whatever env it is given. The probe runs from the repo root, where a
    // developer's gitignored .env would otherwise show up as a failure that
    // production (engine cwd: the vendored tree) cannot hit.
    process.chdir(workDir);
    const codeFile = join(workDir, 'step.js');
    writeFileSync(codeFile, 'exports.code = async () => ({ ...process.env });');
    const env = await noOpCodeSandbox.runCodeModule({ codeFilePath: codeFile, inputs: {} });
    writeFileSync(join(dumpDir, 'code-sandbox.json'), JSON.stringify(env));
    break;
  }

  // installer.ts: `bun install` behind installPiece (the API install path).
  case 'pieces-install': {
    try {
      await installPiece(PIECE.id, { base: piecesDir });
    } catch (e) {
      // Expected: the fake bun installs nothing, so the read-back after the
      // spawn fails. Anything else means the spawn may not have happened.
      if (!String((e as Error).message).includes('missing from node_modules')) throw e;
    }
    break;
  }

  // reconciler.ts: the startup `bun install` for a manifest with no node_modules.
  case 'pieces-reconcile': {
    await writeManifest({
      version: 1,
      pieces: [{
        id: PIECE.id,
        npmPackage: PIECE.npmPackage,
        versionRange: '*',
        resolvedVersion: '0.0.0',
        installedAt: 0,
      }],
    }, piecesDir);
    await reconcilePiecesLibrary({ base: piecesDir, log: () => {} });
    break;
  }

  // build.ts: the engine's staging `bun install`. STAGING_DIR hangs off
  // homedir(), which the test points into workDir for this site.
  case 'engine-staging': {
    // If STAGING_DIR ever stops following HOME, the fake install would
    // overwrite the developer's real staging package.json and leave it
    // looking installed. Refuse rather than rely on it.
    if (!ENGINE_BUILD_PATHS.STAGING_DIR.startsWith(workDir + '/')) {
      throw new Error(`staging dir ${ENGINE_BUILD_PATHS.STAGING_DIR} is outside the probe's work dir`);
    }
    await ensureStagingInstalled();
    break;
  }

  // daemon/ui-autobuild.ts: `bun run build:ui` when ui/dist is missing.
  case 'ui-autobuild': {
    const repoRoot = join(workDir, 'repo');
    mkdirSync(repoRoot, { recursive: true });
    ensureUiBuilt(repoRoot, () => {});
    break;
  }

  // Both install paths against a `bun` that fails: print the errors they
  // raise. The failing fake goes first on PATH for this site only.
  case 'install-errors': {
    const failDir = join(workDir, 'failbin');
    mkdirSync(failDir, { recursive: true });
    writeFileSync(join(failDir, 'bun'), '#!/bin/sh\nexit 3\n', { mode: 0o755 });
    process.env.PATH = `${failDir}:${process.env.PATH ?? ''}`;
    if (!ENGINE_BUILD_PATHS.STAGING_DIR.startsWith(workDir + '/')) {
      throw new Error(`staging dir ${ENGINE_BUILD_PATHS.STAGING_DIR} is outside the probe's work dir`);
    }
    mkdirSync(piecesDir, { recursive: true });
    for (const run of [() => runPiecesBunInstall(piecesDir, 'pieces'), () => ensureStagingInstalled()]) {
      try {
        await run();
        console.log('ERR <none: the install did not fail>');
      } catch (e) {
        console.log(`ERR ${(e as Error).message}`);
      }
    }
    break;
  }

  // Positive control: prove the arrangement can SEE a leak, through both
  // spawn APIs the sites above use, with `env` omitted as they used to.
  case 'control': {
    await new Promise<void>((res, rej) => {
      const child = spawn('bun', ['control-node'], { cwd: workDir, stdio: 'ignore' });
      child.on('close', () => res());
      child.on('error', rej);
    });
    Bun.spawnSync(['bun', 'control-bun'], { cwd: workDir, stdout: 'ignore', stderr: 'ignore' });
    break;
  }

  // Positive control for the CODE-sandbox route, which differs from the
  // others: process.execPath rather than PATH, an IPC channel, and the env
  // read back from inside JS. Same shape as the sandbox, `env` omitted.
  case 'control-code': {
    const env = await new Promise<unknown>((res, rej) => {
      const child = spawn(process.execPath, ['--eval', 'process.send({ ...process.env }, () => process.exit(0))'], {
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      });
      child.on('message', res);
      child.on('error', rej);
    });
    writeFileSync(join(dumpDir, 'control-code.json'), JSON.stringify(env));
    break;
  }

  default:
    throw new Error(`unknown site: ${site}`);
}

process.exit(0);
