# Shared runtime integrity (hosting)

`scripts/build-shared-runtime.ts` builds the per-version artifacts that every
hosted tenant runs: the engine bundle (`<out>/engine/<hash>/main.js` and its
`main.js.sha256`), the pieces catalog (`<out>/pieces`) and the piece metadata
cache (`<out>/piece-metadata.json`). To build the metadata it runs every
catalog piece, about 656 third-party packages (#862).

This page says how the build is split so that no piece can change what
tenants run, what the builder guarantees in each mode, what the host does
on top of it, and what to do about the transpiler cache.

## Two runs with a seal between them (#862)

Run in one pass, the builder imports every catalog piece at the uid that
owns everything the build wrote. A piece can then rewrite the engine (caught,
see below), any other piece in the tree, the tree the license gate judged,
and the metadata. So the host runs it in two runs, as three accounts:

1. `--install-only`, as the build account: the engine bundle and the catalog
   install. No piece runs: the install uses `--ignore-scripts`, and nothing
   imports a piece. Writes `<out>/engine` and `<out>/pieces` only. The engine
   digest goes out on `--digest-fd` as in the one pass.
2. The host, as root: copies the output into a root-owned, read-only tree,
   checks `main.js` against the digest and writes `main.js.sha256` itself.
3. `--extract-only --from <that tree>`, as an extraction account: the license
   gate, then the metadata extraction, with the engine at
   `<from>/engine/<hash>/` verified against root's manifest
   (`verifiedSharedBundle`; it never builds one). It writes
   `<out>/piece-metadata.json` and `<out>/THIRD_PARTY_NOTICES.md`, in a fresh
   `--out` of its own, and the host copies those two into the published tree.
   It never warms a transpiler cache.

Before anything else, `--extract-only` refuses to run unless the tree it is
given is sealed against it (`sealViolations` in
`src/workflows/runner/engine-runtime/shared-build-phases.ts`): not running
as root; every entry of `<from>/engine`, `<from>/pieces` and the brain's
vendored pieces owned by root and not writable by this process; every
ancestor root's, and not writable unless sticky. So the guarantee does not
rest on the host having done step 2: a piece the extraction runs cannot
change the engine, another piece, or the tree the license gate passed.

What it still can change: the metadata file and the notices, which it writes
in this run's own dir, and anything else its account can write. The metadata
is what pieces report about themselves, so a piece could always make its own
entry say anything; it can now also rewrite another piece's entry. That is
data the daemon shows and validates, never code it runs.

Measured end to end with the real builder and Bun 1.4.2, in an Ubuntu 24.04
container with three accounts and `--pieces 3`: the install run wrote only
`engine/` and `pieces/` and handed out a digest equal to the sha256 of the
copied `main.js`; `--extract-only` against the build account's own tree
refused with the owner of each unsealed path; against root's copy it
extracted 40 entries with no failures; the warm-up below wrote one 3.9 MB
cache file.

The one pass (no phase flag) is unchanged, for development and for hosts
that build older versions.

## What the builder guarantees about the engine (#862)

In the one pass and in `--install-only`, `publishSharedEngine` (`src/workflows/runner/engine-runtime/shared-engine-publish.ts`)
wraps the piece-running part of the build:

1. It copies into `<out>/engine/<hash>/` exactly the files `buildEngineBundle`
   just wrote (`main.js`, its sourcemap and metafile), each checked against the
   sha256 the build computed in memory from the bytes it wrote. Anything else
   in the build's directory, stale or planted, is not copied.
2. It hands the `main.js` digest out on `--digest-fd` and closes that fd.
   No catalog piece has run yet.
3. It runs the catalog install and, in the one pass, the metadata
   extraction.
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

In the one pass, the builder cannot see anything written AFTER its final
check by a piece process that outlived the extraction (a detached
grandchild). Such a process
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

The license gate (step 3b in the script) scans the pieces tree after `bun
install` and before any piece runs, so it judges the tree npm delivered.

- In the one pass, the pieces then run at the builder's uid and can write
  into that tree, so the gate does not vouch for the tree as it stands after
  extraction; a piece that wanted to could add or rewrite packages.
- Under `--extract-only` it judges the sealed tree, which no piece can
  change, so what it passes is what tenants get.

The notices are rendered in memory before extraction and written afterwards
with an exclusive create (`wx`): into `<out>/pieces` in the one pass, after
checking it is still a real directory, and into the run's own `--out` under
`--extract-only`. A file or link a piece planted at `THIRD_PARTY_NOTICES.md`
fails the build instead of being followed (for example onto `main.js`). Like
the summary, the notices file is not a source for anything the host pins.

## What install-version does (hosting, scripts VERSION 51)

The hosting repo's `install-version` reads which flags the version's builder
has from the verified package. A builder with `--extract-only` is run in the
two runs above; one with only `--digest-fd` in one pass, with the engine
pinned; anything older in one pass, as before, so a rollback still installs.

The accounts, each used for nothing else and created by bootstrap:
`jarvis-build` (the install run, or the one pass), `jarvis-extract` (the
extraction run) and `jarvis-warm` (the transpiler warm-up below). Every
stage:

- runs exec'd straight into its account by `setpriv` with `--no-new-privs`,
  under `setsid`, with `env -i` and only the variables it needs: no wrapper of
  the account's own, so the builder is the only process of the build uid that
  holds the pipe's write end. The deadline is enforced by root, which TERMs
  and then KILLs the stage's process group, rather than by `timeout` on the
  fd path. Measured with a hostile test piece that wrote through
  `/proc/<pid>/fd/3` of every ancestor:
  - run under `timeout`: it overwrote the digest through `timeout`'s fd 3;
  - with the builder as the only holder: every attempt failed, and the
    digest arrived intact;
  - in both runs, it wrote a line into the caller's terminal through an
    ancestor's fd 1.
- runs bun as `bun --config=<empty file> --no-env-file`, from the account's
  own fresh dir, so no `bunfig.toml` preload or `.env` acts on it (#863).
  The `=` in `--config=<path>` is required: `--config <path>` and `-c`
  silently fall back to the cwd `bunfig.toml`.
- gets no `BUN_RUNTIME_TRANSPILER_CACHE_PATH`. Its HOME is in the scratch and
  goes with it.
- is followed by sealing the scratch dir and killing every process of the
  account before root reads anything it wrote.

Before a build starts, every build account's processes are killed and their
crontab and `at` jobs removed, so nothing left by an earlier build, or
scheduled by a piece, acts inside this one.

The digest pipe is a root-only FIFO whose name is removed once both ends are
open; root keeps only the read end (fd 8) and closes the read-write end it
opened it with, so it sees end of file once the builder closes its fd 3.
Root reads it only after the builder exited 0 and its account is quiesced,
and accepts exactly one line of 64 lowercase hex characters followed by end
of file. `engineDigest` in stdout and in the summary file are ignored.

Root then copies the output, checks the copy's engine (one bundle directory
of regular, single-link files, `sha256(main.js)` equal to the digest) and
writes `main.js.sha256` from the digest, replacing the build's. Only then,
with a phased builder, does `jarvis-extract` run against that copy.

What is still the host's to know:

- Yama `ptrace_scope` must be 1 or more on the build host (Ubuntu's default),
  or a process of the build uid can attach to the builder and nothing it
  computes can be trusted. Check `/proc/sys/kernel/yama/ptrace_scope`.
- The digest is only as good as the build's INPUTS. The engine is compiled
  from the brain tree (root's) and a staging install under the scratch HOME
  (fresh per build), out of the host's persistent Bun install cache, which
  `jarvis-build` owns and reuses across versions. In a phased build no
  third-party code runs as `jarvis-build`, so nothing in that build can write
  the cache; but a one-pass build of an older version runs every piece as
  `jarvis-build`, and could leave a poisoned package in it for later builds.

## The transpiler cache

Bun runs a large file from a transpiled copy in
`$BUN_RUNTIME_TRANSPILER_CACHE_PATH`. That copy is not `main.js`, and the
digest pin never sees it (#835).

`install-version` used to set
`BUN_RUNTIME_TRANSPILER_CACHE_PATH=$work/transpiler` for the builder and
publish that directory, so the cache tenants trusted was written by the
process that imports every catalog piece. Each cache entry is named by a hash
of the source file's CONTENT, not its path (measured). So a piece could plant
an entry under the name `main.js` will look up. Scripts VERSION 51 builds
option C below instead.

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

### Chosen: C

C is within about 0.1 s of A on a typical cold engine spawn. It keeps the
part of the cache that matters most, the engine, which is paid on every
spawn. It is the only option besides B in which no piece writes a file that
tenants trust.

How the host builds it (scripts VERSION 51):

1. The builder gets no `BUN_RUNTIME_TRANSPILER_CACHE_PATH`. Whatever it warms
   lands under its scratch HOME and is discarded with it.
2. After root has published `main.js` and checked it against the digest read
   from `--digest-fd` (never the summary's `engineDigest`, which a piece can
   forge), `jarvis-warm`, which runs nothing else, boots the engine once to
   fill an empty cache directory:

   ```
   BUN_RUNTIME_TRANSPILER_CACHE_PATH=<empty dir> bun --config=<empty file> --no-env-file --smol --no-install <published main.js>
   ```

   - The `=` in `--config=<path>` is required. `--config <path>` and `-c`
     silently fall back to the cwd `bunfig.toml` (#863).
   - `--no-env-file` keeps a `.env` in the cwd out of it. It is ignored
     before Bun 1.3.3 (measured), so warm with 1.3.3 or later.
   - Leave `SANDBOX_ID` unset, so the engine exits after boot.
3. Root accepts the result only if it is a flat directory of regular,
   single-link files of `jarvis-warm`'s, and publishes a root-owned copy
   (directory 0755, files 0644) as `/opt/jarvis-cache/<version>/transpiler`,
   which `update-instance` points tenants' `BUN_RUNTIME_TRANSPILER_CACHE_PATH`
   at. A warm-up that fails or times out publishes no cache and does not fail
   the install: the cache is optional.

Booting it twice into two empty directories and comparing the files would
also work (the entry is deterministic); the host does not.

If the per-piece cost ever matters, the next step is not a shared piece
cache. It is keeping engines warm longer (`poolIdleTtlMs`). An engine that
stays alive keeps the pieces it has already loaded in memory.
