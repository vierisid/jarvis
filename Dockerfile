# ─── J.A.R.V.I.S. Docker Image ──────────────────────────────────────
#
# Multi-stage build for the JARVIS daemon.
# Uses the Debian-based Bun images (`oven/bun:<version>` and its `-slim`)
# rather than the Alpine variants. Nothing in the tree needs glibc today — there
# are no native addons left after sharp was dropped — so this is just the
# default, not a constraint; Alpine is a fair option if an image-size push
# wants it.
#
# Base images are pinned by tag AND digest (#783). They used to float on `1`
# and `1-slim`, so every release shipped whatever Bun those resolved to that
# day, with no record of it, while CI tested 1.3.14. On 2026-10-07 `1` was
# 1.4.2 (these exact digests), so the shipped runtime is pinned where it
# already was and CI moved up to it. The version here is the one CI pins
# (BUN_VERSION in release-exec.yml), so the image runs the runtime the test
# suite ran; workflow-hardening.test.sh fails
# if they drift apart or if a FROM loses its digest. Dependabot does not
# watch this file, so bump by hand, all four FROM lines together with every
# other Bun pin (BUN_VERSION in release-exec.yml and sync-pieces-catalog.yml,
# its inspect-job image, test.yml, release.yml, .github/actions/bun-setup);
# the same test checks they all agree. Resolve a
# digest from the registry, never by guessing:
#   docker buildx imagetools inspect oven/bun:<version>       (the index digest)
#   docker buildx imagetools inspect oven/bun:<version>-slim
#
# Build:   docker build --build-arg VERSION=0.3.1 -t jarvis .
#          VERSION is REQUIRED and has no default; see the stamp step below for
#          why. For a throwaway local image, any semver will do: 0.0.0-dev.
# Run:     docker run -p 3142:3142 -v jarvis-data:/data -e JARVIS_API_KEY=sk-... jarvis
#
# ─────────────────────────────────────────────────────────────────────

# Build arg: the release version (e.g. 0.3.1) stamped into package.json.
# Deliberately NO default -- see the stamp step in the build stage.
ARG VERSION

# ─── Stage 0: A version-neutral package.json ───────────────────────
#
# #647. Every release commit changes exactly one thing in package.json: its
# `version` (release.yml bumps it, and the tag's VERSION is stamped in at the
# end of the build stage anyway). Copied straight from the context, that one
# field invalidated `bun install`, every build-stage step after it and the
# workflow prebuild on every release, so a release could reuse none of the
# cache PR and main builds leave behind. Measured on a simulated release
# (tracked tree, package.json bumped, VERSION matching): `bun install` re-ran
# (20.1s), so did build:ui, the model copy and build:workflows (9.0s).
#
# So the stages that only need package.json's OTHER fields take this copy,
# with the version pinned to 0.0.0. COPY --from is keyed on content, so a
# version bump produces the same bytes and everything downstream stays a
# cache hit; only this RUN and the stamp re-execute. Nothing upstream of the
# stamp reads the version (bun.lock does not record the root package's
# version, `bun install --frozen-lockfile` passes against this copy, and the
# piece/engine content hashes do not cover it -- the production stage's
# assertion below would fail the build if they did).
#
# Pinned to BUILDPLATFORM like the `workflows` stage, which copies from it: a
# target-platform stage here would make that stage per-architecture again.
FROM --platform=$BUILDPLATFORM oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895 AS manifest

WORKDIR /app
COPY package.json ./
RUN bun -e 'const p = await Bun.file("package.json").json(); p.version = "0.0.0"; await Bun.write("package.json", JSON.stringify(p, null, 2) + String.fromCharCode(10))'

# ─── Stage 1: Install dependencies ─────────────────────────────────
FROM oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895 AS deps

WORKDIR /app

# Copy only dependency manifests for layer caching. package.json comes from
# the `manifest` stage, version-neutral, so a release's version bump does not
# re-run the install.
COPY --from=manifest /app/package.json ./
COPY bun.lock ./
# scripts/ holds the postinstall helper (ensure-bun.cjs) referenced by package.json
COPY scripts/ scripts/

# Install all dependencies (includes devDependencies needed for UI build)
RUN bun install --frozen-lockfile

# ─── Stage 2: Build UI and copy models ─────────────────────────────
FROM deps AS build

WORKDIR /app

# Copy source files needed for the build
COPY src/ src/
COPY ui/ ui/
COPY bin/ bin/
COPY roles/ roles/
COPY scripts/ scripts/
COPY tsconfig.json ./

# Copy ONNX wake-word models and WASM runtime from node_modules into ui/public/
RUN mkdir -p ui/public/openwakeword/models ui/public/ort && \
    cp node_modules/openwakeword-wasm-browser/models/melspectrogram.onnx \
       node_modules/openwakeword-wasm-browser/models/embedding_model.onnx \
       node_modules/openwakeword-wasm-browser/models/silero_vad.onnx \
       node_modules/openwakeword-wasm-browser/models/hey_jarvis_v0.1.onnx \
       ui/public/openwakeword/models/ && \
    cp node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm \
       node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm \
       node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs \
       node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs \
       ui/public/ort/

# Build the dashboard UI bundle.
#
# `bun run build:ui`, not a second copy of the command (#622). The hand-rolled
# `bun build ui/index.html --outdir ui/dist` that used to be here omitted
# ui/pebble.html, which package.json's build:ui has built since #249, so from
# #249 onward the image shipped without ui/dist/pebble.html while the npm
# tarball (prepublishOnly, which calls build:ui) had it. ui-autobuild.ts could
# not repair the gap either: it only fires when ui/dist/index.html is MISSING,
# and this step had already written that. Same shape as #613: a package script
# duplicated in the Dockerfile drifts silently, and the drift is the defect.
#
# Note `bun run build:ui` also runs `prebuild:ui` -> `copy:models`, bun's
# pre-script hook, which is a byte-identical duplicate of the explicit model
# copy above -- same eight files, same order. So that RUN no longer provides the
# fail-fast it was keeping: a vanished model now fails HERE instead, with cp's
# own message naming the file, because `bun run` propagates a pre-hook's
# non-zero exit and `set -eu` is on.
#
# It is kept for one narrower reason: it is the only thing that asserts those
# models are present if `prebuild:ui` is ever dropped from package.json, in
# which case the image would otherwise ship a model-less ui/public silently.
# The cost is a second ~41 MB layer in this stage (the production stage re-COPYs
# the directory, so nothing is duplicated in the shipped image). Deleting it in
# favour of an explicit presence assertion would be a fair follow-up; it is not
# done here because this Dockerfile cannot be built in the environment this
# change was made in.
#
# The assertion derives what it demands from the build:ui script itself rather
# than naming the documents again: a second list here would re-create exactly
# the drift this change removes, and a new entrypoint added to build:ui is
# required in ui/dist automatically. It fails closed three ways: build:ui naming
# no .html at all, build:ui naming an entrypoint this cannot map to a ui/dist
# document (a nested one, say ui/pages/x.html, whose output path it cannot
# predict), and a document the bundler did not emit.
#
# No backslash anywhere in the bun expression, on purpose: `\` is the
# Dockerfile escape character, so a regex written with \/ or \. would be
# mangled before sh ever saw it. Character classes do the same job.
RUN set -eu; \
    bun run build:ui; \
    docs=$(bun -e 'const p = await Bun.file("package.json").json(); const s = (p.scripts || {})["build:ui"] || ""; const all = s.split(" ").filter((t) => t.endsWith(".html")); if (all.length === 0) throw new Error("build:ui names no .html entrypoint: " + s); const flat = all.filter((t) => /^ui[/][A-Za-z0-9._-]+[.]html$/.test(t)); if (flat.length !== all.length) throw new Error("build:ui names an entrypoint this check cannot map to a ui/dist document: " + all.filter((t) => !flat.includes(t)).join(", ")); console.log(flat.map((t) => t.slice(3)).join(" "))'); \
    for doc in $docs; do \
      [ -f "ui/dist/$doc" ] || { \
        echo "build:ui did not emit ui/dist/$doc, which it names as an entrypoint" >&2; \
        exit 1; \
      }; \
      echo "ui/dist has $doc"; \
    done

# Stamp the release version into package.json. REQUIRED, and no longer skipped
# when absent (#625).
#
# Placement (#647): this is the LAST instruction of the build stage on
# purpose, and it stamps the version-neutral copy from the `manifest` stage,
# so the result is the committed package.json with the release's version.
# Nothing above reads package.json's version -- the model copy does not, and
# build:ui bundles ui/ (which imports no package.json) and reads only the
# `scripts` field for its assertion -- and the only consumer is the
# production stage's `COPY --from=build /app/package.json`. Stamped earlier,
# every new VERSION re-ran the model copy and the UI build.
#
# Measured with real builds against the cache of a VERSION=0.0.0-ci build:
# with this placement and the `manifest` stage, a simulated release
# (package.json bumped, matching VERSION) re-ran only the manifest RUN and
# this one; deps, the model copy, build:ui and build:workflows were CACHED.
# Placement alone was not enough: the release commit's version bump reached
# deps through package.json and re-ran everything from `bun install` on.
# The shipped image is the same either way; the later production layers
# (from the package.json COPY on) change with every VERSION regardless.
#
# What the old `if [ -n "$VERSION" ]; then ... fi` cost us: docker-build.yml
# passed no build-arg, so the guard was false on every CI build and this step
# never ran. The image CI smoked therefore carried whatever version happened to
# be committed to package.json, while every published image carries the tag's
# version -- CI was proving a different artifact healthy. (Note the premise in
# #625 is wrong in one detail: the version was never EMPTY, it was stale. There
# is no "unknown" branch for a consumer to take, so nothing was exercising one.)
# Worse, the skip meant the stamp COMMAND ran in no CI job at all (the RUN layer
# executed on every build; the `if` simply took its false branch), so a break in
# it could only ever surface as a failed release.
#
# A default would NOT fix that. It would make a caller who OMITS the build-arg
# build successfully with a placeholder, and the registry tags come from a
# completely separate path (docker/metadata-action, off the git tag), so
# deleting the `build-args:` line from release-exec.yml would publish
# ghcr.io/...:v1.2.3 containing a package.json that says something else, green
# and silent. No default plus a hard failure covers BOTH omission and an
# explicit `--build-arg VERSION=`, which is why the version is required here.
# The cost is that a bare `docker build .` now fails; it fails loudly, naming
# the flag, which is the trade.
#
# Stamped with bun rather than `bunx npm version`: bunx resolves and downloads
# the npm package from the registry at build time, at whatever `latest` is. That
# was tolerable while this step only ran during a release; making it
# unconditional would have put an unpinned registry fetch in the path of every
# PR image build. bun is already in the image, so this needs no network.
#
# The regex enforces semver's shape, including the no-leading-zero rule on
# major.minor.patch, and admits no shell metacharacters. It is NOT the release's
# tag control (#644): it is looser than `npm version` on pre-release
# identifiers (it takes `1.2.3-01`) and still admits build metadata, both of
# which release-exec.yml's validate-tag job rejects before a release build
# starts. It is stricter in one direction: `npm version` accepts a leading `v`
# and normalises it away, this does not. Release builds pass validate-tag's
# `version` output, which has the `v` stripped, so a `v` arriving here means
# something upstream stopped stripping it, which is worth failing on.
#
# `${VERSION:-}` rather than `$VERSION`: `set -u` is in effect, and a declared
# ARG with no value may not be exported into the RUN environment at all, in
# which case a bare dereference would abort with "unbound variable" and this
# message -- the one that names the flag -- would never print for the omission
# case, which is the common one.
ARG VERSION
RUN set -eu; \
    [ -n "${VERSION:-}" ] || { \
      echo "VERSION build-arg is required and was empty. Pass --build-arg VERSION=<semver>." >&2; \
      exit 1; \
    }; \
    VERSION="$VERSION" bun -e 'const v = process.env.VERSION; if (!/^(0|[1-9][0-9]*)[.](0|[1-9][0-9]*)[.](0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?([+][0-9A-Za-z.-]+)?$/.test(v)) throw new Error("VERSION is not semver: " + v); const f = "package.json"; const p = await Bun.file(f).json(); p.version = v; await Bun.write(f, JSON.stringify(p, null, 2) + String.fromCharCode(10)); console.log("stamped package.json version " + v)'

# ─── Stage 3: Prebuild the workflow runtime ────────────────────────
#
# `bun run build:workflows` compiles the vendored Jarvis pieces into
# `<piece>/dist/` and bundles the Activepieces engine. Neither artifact is in
# git: both are build output that only `prepublishOnly` produced, i.e.
# the npm path. The image never ran it, so on first boot `buildPiece()` took
# its rebuild path, found /app root-owned while the daemon runs as `jarvis`,
# and failed the whole `piece-compile` bootstrap phase (#613). Prebuilding
# lands the pieces on the hash fast-path instead, so nothing under /app has
# to be writable and the read-only guard stays as written.
#
# Pinned to BUILDPLATFORM so a multi-arch build runs this ONCE and both
# images share the result. Two reasons, in order of importance:
#
#   1. One prebuild, one artifact. The engine staging install is held to the
#      committed src/workflows/runner/engine-runtime/engine-staging.lock and
#      installed --frozen-lockfile (#836, in #861), so two prebuilds of one
#      commit install the same versions. Before that it resolved the
#      synthesized package.json's version RANGES with no lockfile, and two
#      builds two hours apart emitted bundles ~9.7 KB apart under the SAME
#      bundleHash -- the drift #836 diagnosed and the lockfile fixed. Running
#      the prebuild once still makes both images share one bundle by
#      construction, rather than by the lockfile holding.
#   2. The arm64 leg then copies plain JavaScript instead of re-running
#      esbuild and a `bun install` under QEMU.
#
# Verified by building this stage for both arches: the nine piece bundles and
# every .source-hash come out byte-identical, and a same-time amd64 and arm64
# pair produced identical engine bundles too, so nothing here is
# architecture-dependent.
#
# No `bun install` of the repository in this stage: build-workflows.ts and
# everything it imports resolve to node: builtins and the repo's own source.
# esbuild and the engine's dependencies are fetched by the build itself, by
# the staging install above (into the engine staging dir under $HOME), at
# exactly the versions and integrity hashes engine-staging.lock records.
FROM --platform=$BUILDPLATFORM oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895 AS workflows

WORKDIR /app

# tsconfig.json is not needed to RUN the build script, but esbuild
# auto-discovers the nearest one per input file and applies its
# compilerOptions. Copying it keeps the bundles identical to the ones the npm
# path produces (`prepublishOnly`, which runs with it present), and keeps a
# future piece that uses the `@/*` alias from building everywhere but here.
# Nothing in the piece hash covers it, so a difference would be invisible.
# package.json from the `manifest` stage, version-neutral, so a release's
# version bump does not re-run the prebuild (#647).
COPY --from=manifest /app/package.json ./
COPY tsconfig.json ./
COPY scripts/ scripts/
COPY src/ src/

RUN bun run build:workflows

# Prove the prebuild actually produced something, for every piece directory
# that exists, not just for the ones the builder chose to return. A piece
# missing its package.json is skipped silently by buildAllJarvisPieces(), and
# a dist/ without package.json still satisfies the runtime cache fast-path
# while being invisible to the engine's piece loader (it matches on
# dist/package.json's `name`). Either would ship a quietly broken image.
# `[ -d ]` is not redundant: an unmatched glob stays literal in POSIX sh, so
# without it the loop would run once on a path that does not exist and the
# "built nothing" message below could never print.
RUN set -eu; \
    pieces=/app/src/workflows/activepieces/packages/pieces/jarvis; \
    n=0; \
    for dir in "$pieces"/*/; do \
      [ -d "$dir" ] || continue; \
      for artifact in dist/package.json dist/src/index.js dist/.source-hash; do \
        [ -f "$dir$artifact" ] || { \
          echo "prebuild incomplete: $(basename "$dir") is missing $artifact" >&2; \
          exit 1; \
        }; \
      done; \
      n=$((n + 1)); \
    done; \
    [ "$n" -gt 0 ] || { echo "prebuild built nothing: no piece directories under $pieces" >&2; exit 1; }; \
    echo "prebuilt $n piece bundle(s)"

# Stage both artifacts under /out so the production stage copies exactly
# them and nothing else:
#   /out/pieces/<piece>/dist   overlays ONLY dist/ onto the shipped src/
#   /out/engine/<hash>/main.js the read-only shared bundle, with the content
#                              manifest findSharedBundle() verifies
# main.js.map and main.js.meta.json are deliberately left behind: nothing
# reads them at runtime and the metafile alone is several MB.
# The bundle dir is counted with `find`, not a glob: an unmatched glob would
# stay literal and a `$#`-style count would pass with zero matches.
RUN set -eu; \
    pieces=/app/src/workflows/activepieces/packages/pieces/jarvis; \
    mkdir -p /out/pieces; \
    for dir in "$pieces"/*/; do \
      [ -d "$dir" ] || continue; \
      name=$(basename "$dir"); \
      mkdir -p "/out/pieces/$name"; \
      cp -a "${dir}dist" "/out/pieces/$name/dist"; \
    done; \
    engine="$HOME/.jarvis/cache/engine"; \
    count=$(find "$engine" -mindepth 1 -maxdepth 1 -type d | wc -l); \
    [ "$count" -eq 1 ] || { echo "expected exactly one engine bundle dir under $engine, found $count" >&2; exit 1; }; \
    bundle=$(find "$engine" -mindepth 1 -maxdepth 1 -type d); \
    hash=$(basename "$bundle"); \
    mkdir -p "/out/engine/$hash"; \
    cp "$bundle/main.js" "/out/engine/$hash/main.js"; \
    sha256sum "/out/engine/$hash/main.js" | cut -d' ' -f1 > "/out/engine/$hash/main.js.sha256"; \
    echo "staged engine bundle $hash"

# ─── Stage 4: Production image ─────────────────────────────────────
FROM oven/bun:1.4.2-slim@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61 AS production

# ca-certificates: HTTPS calls to LLM APIs
# git: required by the Site Builder for project version control
RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates git make procps libc-dev && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy installed dependencies
COPY --from=deps /app/node_modules ./node_modules

# Copy application source and built assets
COPY --from=build /app/src ./src
COPY --from=build /app/bin ./bin
COPY --from=build /app/roles ./roles
COPY --from=build /app/ui/dist ./ui/dist
COPY --from=build /app/ui/public ./ui/public
# Copy version-stamped package.json from build stage (not the original)
COPY --from=build /app/package.json ./
COPY tsconfig.json ./

# Compiled piece bundles from the `workflows` stage. Only each piece's dist/
# is overlaid, so every source file under src/ still comes from exactly one
# stage. Note that COPY merges rather than replaces: that claim also depends
# on the .dockerignore rule keeping any locally built dist/ out of the
# context, or a leftover file in a destination dist/ could survive.
COPY --from=workflows /out/pieces/ ./src/workflows/activepieces/packages/pieces/jarvis/

# Prebuilt engine bundle, read-only and root-owned. Shipping it keeps first
# boot offline and fast: the fallback path would `bun install` ~47 MB of
# esbuild staging before it could build anything.
#
# findSharedBundle() verifies main.js against main.js.sha256 and treats a
# mismatch as a cache MISS. That is a corruption check (a truncated copy, a
# bad layer pull), NOT a tamper check: this build writes the bundle and its
# digest in the same step, so whatever can influence one can influence both.
#
# A MISS here is NOT harmless, despite the engine's graceful fallback. The
# two artifacts share one cache key: pieceHash() starts from bundleHash(), so
# anything that moves the bundle hash moves all nine piece hashes too, and
# the piece path has no fallback at all (it hits the read-only guard as uid
# 999 and fails bootstrap, which is #613). The assertion after USER jarvis
# below is what keeps that from ever shipping.
COPY --from=workflows /out/engine/ ./engine-cache/

# Install jarvis as a global command
# Note: `bun link` can't be used here — it symlinks through /root/.bun/ which
# is inaccessible to the non-root jarvis user. Direct symlink works because
# Bun resolves import.meta.dir through symlinks to the real path (/app/bin).
RUN ln -s /app/bin/jarvis.ts /usr/local/bin/jarvis

# Create non-root user and data directory
RUN groupadd -r jarvis && useradd -r -g jarvis -d /data -s /bin/bash jarvis && \
    mkdir -p /data && chown jarvis:jarvis /data

ENV JARVIS_HOME=/data
# The workflow runtime resolves its writable state (engine bundle cache,
# piece-metadata cache, workflow logs/codes/files, the pieces library) from
# os.homedir(), which is NOT JARVIS_HOME. /data is the jarvis user's home in
# /etc/passwd and the volume, so this only pins what Docker already derives,
# but pinning it keeps those writes off root-owned /root if that ever changes.
# One caveat: an ENV is image-wide, so it also applies when USER is overridden
# (`docker run --user 0`, `docker exec -u 0`, runAsUser: 0), where HOME used to
# be /root. A root shell there reads shell/git/bun config from the operator's
# volume instead. The daemon's own file tools cannot plant those files without
# passing the authority gate (file-path-policy classifies .bashrc, .profile,
# .gitconfig, .npmrc and .bunfig.toml as exec-authority by name), and the
# daemon itself already ran with HOME=/data.
ENV HOME=/data
# Read-only shared engine bundle baked in above. Consulted before the
# per-user cache and short-circuits the staging install entirely.
ENV JARVIS_ENGINE_CACHE_ROOT=/app/engine-cache
ENV NODE_ENV=production
# Signal to `jarvis update` / `jarvis uninstall` that this is a container
# install. Both commands refuse to run here and point the user at the
# correct host-side docker commands.
ENV JARVIS_INSTALL_METHOD=docker
# Durable on-disk marker as a belt-and-suspenders fallback if the env var
# is ever unset (e.g. someone runs `docker exec -e JARVIS_INSTALL_METHOD= ...`).
RUN echo '{"method":"docker","installedAt":"image-build"}' > /app/.install-method

EXPOSE 3142

VOLUME ["/data"]

USER jarvis

# Prove the prebuild is USABLE by the runtime user in this image, not merely
# present. Both artifacts are resolved by content hash, and the hashes
# computed here are the ones the daemon computes on first boot:
#   - every piece must come back `cached`, i.e. on the fast path. A miss as
#     uid 999 on root-owned /app is #613 exactly, and cannot self-repair.
#   - the bundle must resolve from the shared root, path included: a bare
#     "resolved" would also be satisfied by the per-user fallback cache, so
#     the assertion checks WHERE it came from. This exercises the
#     main.js.sha256 written above as a side effect.
# Failures throw rather than exiting, so BuildKit always flushes the reason.
# The presence checks in the prebuild stage cannot see either property, and
# the per-directory check there cannot be replaced by this one: a piece
# missing its package.json is skipped by buildAllJarvisPieces() rather than
# reported, so it would pass here while silently not shipping.
RUN bun -e 'const {buildAllJarvisPieces} = await import("/app/src/workflows/runner/engine-runtime/build-pieces.ts"); const {findCachedBundle} = await import("/app/src/workflows/runner/engine-runtime/build.ts"); const root = "/app/engine-cache"; const r = await buildAllJarvisPieces(); if (r.length === 0) throw new Error("no piece resolved from the shipped tree"); const miss = r.filter((p) => !p.cached).map((p) => p.packageName); if (miss.length > 0) throw new Error("piece content-hash MISS, the prebuilt dist/ does not match the shipped source: " + miss.join(", ")); const b = findCachedBundle(); if (!b) throw new Error("no engine bundle resolved at all"); if (!b.bundlePath.startsWith(root + "/")) throw new Error("engine bundle resolved from " + b.bundlePath + ", not from " + root); console.log(r.length + " piece(s) on the content-hash fast path; shared engine bundle resolved from " + root);'

# Liveness probe. `/health` is the only unauthenticated health route the
# daemon serves (see `isPublicRoute` in src/comms/websocket.ts): every
# `/api/*` route, including `/api/health`, requires an enrolled device
# token, so probing one can only ever 401 and the container stays unhealthy
# forever while the daemon is fine.
#
# Addressed as 127.0.0.1, not `localhost`: the server binds IPv4 only, while
# Docker's /etc/hosts maps `localhost` to both 127.0.0.1 and ::1.
#
# Port resolution, most to least authoritative: the lock file the daemon
# records its bound port in (pid on line one, port on line two, see
# writeLockedPort in src/daemon/pid.ts), then JARVIS_PORT, then 3142.
# Hardcoding 3142 would re-create this very bug for anyone who moves the port:
# a healthy daemon, probed on the wrong port, unhealthy forever.
#
# The JARVIS_PORT rung is not redundant with the lock file. The file is not
# durable: `docker exec <c> jarvis status` unlinks it while the daemon is
# still running (pid.ts releaseLock, via the pid-1-in-a-container branch) and
# nothing rewrites it until the next boot. Without the env rung one such
# command would send the probe back to 3142 for good.
#
# Every malformed input degrades to the next rung rather than failing: no
# file, no second line, a non-port value, a read error (the whole lookup is
# wrapped). Only digit runs are matched, so this needs no backslash escape in
# a Dockerfile. Still unreachable: a port set only in config.yaml once the
# lock file has been unlinked, and `daemon.listen: unix:`, which binds no TCP
# port at all.
#
# This proves the HTTP listener is up and answering, not that every service
# came up: `/health` reports a literal `status: ok` and consults no service
# registry, so a #613-style partial boot still looks healthy. Per-service
# state lives behind the token on `/api/health`, which stays authenticated on
# purpose: it reports a full service inventory.
#
# start-period 20s: boot to the first 200 measured 2.1s on a fresh volume,
# and a success inside the start period marks the container healthy
# immediately, so a wider window costs nothing and absorbs a slower host.
# No --start-interval here on purpose: the flag needs a recent Dockerfile
# frontend, and dockerd's own default already probes every 5s inside the
# start period (measured: first probe 5.4s in, healthy from then on).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD bun -e "const vp=(v)=>{const n=Number(v);return Number.isInteger(n)&&n>0&&n<65536?n:0};let port=vp(process.env.JARVIS_PORT)||3142;try{const f=Bun.file((process.env.JARVIS_HOME||'/data')+'/jarvis.pid');if(await f.exists()){const d=(await f.text()).match(/[0-9]+/g)||[];port=vp(d[1])||port;}}catch{};fetch('http://127.0.0.1:'+port+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

ENTRYPOINT ["jarvis"]
CMD ["start", "--no-open", "--data-dir", "/data", "--no-local-tools"]
