# Shared runtime integrity (hosting)

`scripts/build-shared-runtime.ts` builds the per-version artifacts that every
hosted tenant runs: the engine bundle (`<out>/engine/<hash>/main.js` and its
`main.js.sha256`), the pieces catalog (`<out>/pieces`) and the piece metadata
cache (`<out>/piece-metadata.json`). To build the metadata it runs every
catalog piece, about 656 third-party packages, at the builder's uid (#862).

This page says what the builder guarantees, what the host must do on top of
it, and what to do about the transpiler cache.

## What the builder guarantees (#862)

`publishSharedEngine` (`src/workflows/runner/engine-runtime/shared-engine-publish.ts`)
wraps the piece-running part of the build:

1. It copies into `<out>/engine/<hash>/` exactly the files `buildEngineBundle`
   just wrote (`main.js`, its sourcemap and metafile), each checked against the
   sha256 the build computed in memory from the bytes it wrote. Anything else
   in the build's directory, stale or planted, is not copied.
2. It hands the `main.js` digest out on `--digest-fd` and closes that fd.
   No catalog piece has run yet.
3. It runs the catalog install and the metadata extraction.
4. It hashes every file again. Any change, addition (including a planted
   `main.js.sha256`) or removal fails the build with exit 1.
5. Only then does it create `main.js.sha256`, exclusively, from the in-memory
   digest. The same digest goes into the `--summary` JSON as `engineDigest`,
   for the record.

Proven against the real builder with `--pieces 2` and a hostile jarvis test
piece that, when imported, rewrites `main.js` and writes a matching
`main.js.sha256`:

- before the fix: exit 0. The published `main.js` started with `/* pwned */`
  and `main.js.sha256` matched it, so every tenant's digest pin would have
  passed.
- after the fix: exit 1 with `shared engine REFUSED: the engine artifact
  changed while pieces ran (main.js changed, main.js.sha256 added)`, and no
  summary.

### What it cannot guarantee

The builder cannot see anything written AFTER its final check by a piece
process that outlived the extraction (a detached grandchild). Such a process
runs at the builder's uid. It can rewrite `main.js`, `main.js.sha256` and the
summary file together.

The builder's output channels are not safe either, once pieces have run:

- Same-uid processes can open `/proc/<builder pid>/fd/*`. That needs read
  access, not attach, so Yama does not stop it. A piece can write into the
  builder's stdout, or into any fd the builder still holds.
- Engine output is forwarded to the builder's stdout with a prefix only at the
  start of each chunk. A piece can therefore print whole unprefixed lines,
  including a forged summary.
- A piece can also corrupt the genuine summary line, for example by leaving a
  partial line just before it.

So neither stdout nor the `--summary` file is a source for the digest. Only
`--digest-fd` is. The builder writes the digest there and closes the fd
before any catalog piece runs. After that, no process can reach the pipe
through the builder. Nor through the children it spawned before then (the
staging install, esbuild's service): Bun does not pass an inherited extra fd
to the children it spawns. That is measured on 1.3.8 and 1.4.2 and pinned by
a test in `shared-engine-publish.test.ts`, so a Bun upgrade that changed it
fails CI.

The in-memory digest itself is out of reach. Pieces run in engine child
processes, and with the Yama ptrace scope at 1 or more (Ubuntu's default;
other distributions differ) a child cannot attach to its parent. Check
`/proc/sys/kernel/yama/ptrace_scope` on the build host. At 0, a same-uid
process can attach to the builder and nothing it computes can be trusted.

The digest is only as good as the build's INPUTS. The engine is compiled from
the installed brain tree and the staging `node_modules` under the builder's
HOME (`~/.jarvis/cache/engine-build`), which is reused when its package.json,
lockfile and marker match; its contents are not re-verified. A piece from an
earlier build that wrote there would be compiled into the next engine, and
pinned correctly. The same holds for the Bun install cache.

### The license gate and the notices (#971)

The license gate (step 3b in the script) scans `<out>/pieces` after `bun
install` and before any piece runs, so it judges the tree npm delivered. The
pieces then run at the builder's uid and can write into that tree, so the
gate does not vouch for the tree as it stands after extraction; a piece that
wanted to could add or rewrite packages. The notices are rendered in memory
before step 4 and written afterwards with an exclusive create (`wx`), after
checking `<out>/pieces` is still a real directory: a file or link a piece
planted at `THIRD_PARTY_NOTICES.md` fails the build instead of being followed
(for example onto `main.js`). Like the summary, the notices file is not a
source for anything the host pins.

## What install-version must do (hosting repo, not this one)

The host already runs the builder as `jarvis-build`, quiesces that account,
and publishes as root. On top of that:

1. Give every build fresh inputs: an empty HOME, an empty
   `BUN_INSTALL_CACHE_DIR` (or one the build uid cannot write), and a brain
   tree the build uid cannot write. That includes what Bun reads when the
   builder itself starts, before it computes the digest:
   - `BUN_RUNTIME_TRANSPILER_CACHE_PATH` unset, or a fresh empty directory
     made for this build only. A reused one can hold entries a previous
     build's pieces planted for the builder's own modules.
   - the builder run as `bun --config=<empty file> --no-env-file
     scripts/build-shared-runtime.ts ...`, from a root-owned or fresh cwd, so
     no `bunfig.toml` preload or `.env` acts on it (#863). Quiesce the build account BEFORE the
   build as well as after, and clear anything that can restart its processes
   (crontab, `at`, systemd user units with linger).
2. Pass a pipe as `--digest-fd 3` and read it. Accept only exactly one line
   of 64 lowercase hex characters followed by end of file. Anything else, a
   missing line or a non-zero builder exit refuses the version. The digest is
   handed out BEFORE the pieces run, so a build that is refused later has
   already written a valid-looking line: act on it only after the builder has
   exited 0.
   Ignore `engineDigest` in stdout and in the summary file.

   The builder must be the ONLY process running as the build uid that holds
   the pipe's write end. Root's process keeps only the read end and closes
   its own copy of the write end once the builder child has it; the child
   gets only the write end, as fd 3. Open the pipe in root's process, then
   exec the builder
   (setpriv-style, with no wrapper in between). A wrapper running as the build
   uid that keeps fd 3 open, such as `timeout`, is a second way into the pipe.
   This was measured with a hostile test piece that wrote through
   `/proc/<pid>/fd/3` of every ancestor:
   - run under `timeout`: it overwrote the digest through `timeout`'s fd 3;
   - with the builder as the only holder: every attempt failed, and the
     digest arrived intact;
   - in both runs, it wrote a line into the caller's terminal through an
     ancestor's fd 1.
3. After quiescing the build account, copy `<out>/engine/<hash>/` into a fresh
   root-owned directory. Then check the COPY: `sha256(main.js)` must equal the
   digest from step 2, and every file must be a regular file with one link.
   Write `main.js.sha256` as root from that digest, rather than publishing the
   one found in the build tree, and publish the checked copy.
4. Stop treating the ownership check on `$out` and `$work/transpiler`
   (`install-version:478`) as an integrity check. It is a sanity check only.
5. The transpiler cache: see below.

The pieces catalog and `piece-metadata.json` in `<out>` get no such
protection. A piece can rewrite another piece's files, or the metadata, while
extraction runs. That is a separate, open problem.

## The transpiler cache

Bun runs a large file from a transpiled copy in
`$BUN_RUNTIME_TRANSPILER_CACHE_PATH`. That copy is not `main.js`, and the
digest pin never sees it (#835).

Today `install-version` sets `BUN_RUNTIME_TRANSPILER_CACHE_PATH=$work/transpiler`
for the builder, so the cache tenants trust is written by the process that
imports every catalog piece. Each cache entry is named by a hash of the
source file's CONTENT, not its path (measured). So a piece can plant an entry
under the name `main.js` will look up.

### Measurements

All measurements are on Bun 1.4.2 (the pinned CI and Docker version), on a
32-core WSL2 machine with tmpfs scratch, using a real
`build-shared-runtime --pieces 30` build. Each figure is a median over fresh
processes. A VPS disk is slower, so read the figures as relative.

| What | Cache off (`0`) | Warm cache | Saving |
|---|---|---|---|
| Engine boot to exit, n=15 | 176.7 ms | 125.1 ms | 52 ms per engine spawn |
| Same, re-measured on a second build | 170.7 ms | 120.6 ms | 50 ms |
| Same, Bun 1.3.8 | 246.8 ms | 160.2 ms | 87 ms |
| Require one catalog piece, 30 pieces, n=10 each | 2866 ms total | 2209 ms total | median 14.6 ms per piece, mean 21.9 ms |
| Daemon module subtree (engine-bootstrap + sandbox server), n=12 | 83.6 ms | 81.3 ms | within noise |

Examples per piece (cache off / warm):

- gmail: 195 / 127 ms
- claude: 116 / 76 ms
- slack: 99 / 75 ms
- github: 337 / 290 ms

Other measured facts:

- **The engine entry is one 3.19 MB file.** Booting `main.js` with no
  `SANDBOX_ID` into an empty cache directory writes only that file. Two
  independent warm-ups produce byte-identical files, and the result is
  identical to the file the piece-running build wrote for the same bundle.
- **No piece runs during that warm-up.** The engine exits before it loads
  anything.
- **A piece entry cannot be written without running the piece.** Catalog
  pieces are CommonJS (`dist/src/index.js`). For a CJS file on Bun 1.4.2,
  every way that wrote a cache entry also executed the file. This covers the
  ESM link-failure trick and a `Module.prototype._compile` override. The
  methods that did not execute it (`Bun.Transpiler`, `Bun.build`,
  `bun build --no-bundle`, `require.resolve`) wrote no cache entry.
- **Bun caches any parsable file of 4096 bytes or more.** A 4095-byte file
  is not cached. The often-quoted 50 KB threshold is wrong.
- **Tenant daemon boot is unaffected.** Piece metadata at boot comes from
  the prebuilt `piece-metadata.json`, which imports no piece.

What a tenant's cold start actually pays without piece entries:

- Engine spawns happen on a pool miss, not on every run.
- Each engine process transpiles a piece the first time it imports it.
- So for a flow using five pieces, the first run on a cold engine costs
  about 5 x 22 ms, roughly 0.1 s more than with a shipped piece cache.

### Options

- **A. Status quo.** The cache is warmed while all pieces run, and shipped.
  - Fastest.
  - Every entry is written by a process running 656 third-party packages,
    including the entry for `main.js`.
  - Cache keys are content hashes, so a piece can plant an entry for any file
    it can read.
- **B. No shared cache.**
  - Each engine spawn costs about 50 ms more on 1.4.2 (87 ms on 1.3.8).
  - Each first-used piece costs about 15-22 ms more per engine process.
- **C. Engine-only cache built at version install time, with no piece
  running. Pieces are not cached.**
  - Cost: about 0.2 s of install time per version, one cold engine boot.
  - Keeps the whole per-spawn engine saving (125 ms instead of 177 ms).
  - Pieces cost the same as in B, about 0.1 s per cold engine for a typical
    flow.
  - Needs no change in this repo. A root-owned read-only directory of
    root-owned files is what `isHostOwnedReadOnly` already accepts.
- **D. Warm each piece in its own throwaway sandbox.** Only limits the blast
  radius: each sandbox still runs its piece and can write any key.
  Per-tenant piece caches are not possible either. There is one cache path,
  and #835 disables it for any tenant-writable directory under a pinned
  bundle.

### Recommendation: C

C is within about 0.1 s of A on a typical cold engine spawn. It keeps the
part of the cache that matters most, the engine, which is paid on every
spawn. It is the only option besides B in which no piece writes a file that
tenants trust.

How the host builds it:

1. Stop setting `BUN_RUNTIME_TRANSPILER_CACHE_PATH` for the builder. Its
   warm-up then lands under its scratch HOME and is discarded with it.
2. After root has published `main.js` and checked it against the digest read
   from `--digest-fd` (install-version steps 2 and 3; never the summary's
   `engineDigest`, which a piece can forge),
   boot the engine once to fill an empty cache directory. Run it as a
   dedicated uid that runs nothing else (not `jarvis-build`):

   ```
   BUN_RUNTIME_TRANSPILER_CACHE_PATH=<empty dir> bun --config=<empty file> --no-env-file --smol --no-install <published main.js>
   ```

   - The `=` in `--config=<path>` is required. `--config <path>` and `-c`
     silently fall back to the cwd `bunfig.toml` (#863).
   - `--no-env-file` keeps a `.env` in the cwd out of it. It is ignored
     before Bun 1.3.3 (measured), so warm with 1.3.3 or later.
   - Leave `SANDBOX_ID` unset, so the engine exits after boot.
3. Optionally boot it twice into two empty directories and `cmp` the two
   files. The entry is deterministic.
4. chown the directory and its file to root, make them read-only, and point
   tenants' `BUN_RUNTIME_TRANSPILER_CACHE_PATH` at it.

If the per-piece cost ever matters, the next step is not a shared piece
cache. It is keeping engines warm longer (`poolIdleTtlMs`). An engine that
stays alive keeps the pieces it has already loaded in memory.
