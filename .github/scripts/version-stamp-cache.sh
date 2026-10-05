#!/usr/bin/env bash
#
# Asserts that a release reuses the image cache a non-release build leaves
# behind (#647): only the version-dependent steps may re-run.
#
# A release commit differs from the commit before it in exactly one byte range
# that the image build sees: package.json's `version` (release.yml bumps it),
# plus the VERSION build-arg that is stamped in. The Dockerfile keeps both away
# from the expensive steps -- the `manifest` stage hands deps and workflows a
# version-neutral package.json, and the stamp is the build stage's last
# instruction -- so `bun install`, the model copy, build:ui and the workflow
# prebuild stay cache hits. Either property is the kind a later edit undoes
# without noticing, so this checks the behaviour rather than the layout.
#
# How: copy the tracked tree to a temp context, set package.json and VERSION
# to one throwaway version, bump the version in the copy as a release commit
# does, build again with that version as VERSION, and judge only the second
# build. Warming a fresh manifest matters: changing only VERSION can reuse an
# imported manifest result without materialising its cross-stage cache keys.
# The first manifest change would then rebuild expensive steps despite equal
# normalized bytes. Warm that path before judging the version-only rebuild.
# This checks reuse on the warmed builder, not cache export/import fidelity.
#
# Allowed to re-run in the second build: the `manifest` stage (it reads the
# bumped package.json), the version stamp, and the production steps from the
# stamped `COPY --from=build /app/package.json` on, which change with every
# version by design. Every deps/build/workflows step, and every production
# step before that COPY, must be CACHED.
#
# Usage:   .github/scripts/version-stamp-cache.sh [REPO_DIR]
# Needs:   docker buildx, git, jq (all on GitHub's ubuntu runners; the job
#          that runs this sets up no bun). No output is exported; only cache entries
#          are left behind.
#
# Exit 0 = only allowed steps re-ran. Exit 1 = another step re-ran (named), or
# a step this relies on recognising was not found.

set -euo pipefail

REPO="${1:-.}"
TAG="${STAMP_CACHE_TAG:-$(date +%s)}"
WARM_VERSION="0.0.0-stamp-check.warm.${TAG}"
VERSION_ARG="0.0.0-stamp-check.${TAG}"
WORK="$(mktemp -d)"
LOG="${WORK}/build.log"
CTX="${WORK}/context"
trap 'rm -rf "$WORK"' EXIT

# The stamp is recognised by the message only it prints. If that text ever
# changes, this fails closed ("no stamp step found") rather than passing.
STAMP_MARKER='VERSION build-arg is required'

mkdir -p "$CTX"
# Tracked paths only, with their working-tree contents: a developer's
# untracked build output must not make the two builds differ or match by
# accident. (In CI the working tree is the checkout.)
git -C "$REPO" ls-files -z | (cd "$REPO" && tar --null -T - -cf -) | tar -xf - -C "$CTX"

build() {
  if ! docker buildx build --progress=plain --build-arg "VERSION=$1" "$CTX" >"$LOG" 2>&1; then
    cat "$LOG" >&2
    echo "the image did not build with VERSION=$1" >&2
    exit 1
  fi
}

set_manifest_version() {
  jq --arg v "$1" '.version = $v' "$CTX/package.json" >"${WORK}/package.json"
  mv "${WORK}/package.json" "$CTX/package.json"
}

echo "==> warming package.json and VERSION=${WARM_VERSION}"
set_manifest_version "$WARM_VERSION"
build "$WARM_VERSION"

echo "==> bumping package.json to ${VERSION_ARG}, as a release commit does, and rebuilding"
set_manifest_version "$VERSION_ARG"
build "$VERSION_ARG"

# BuildKit's plain progress names each vertex once ("#12 [build 8/10] RUN ...",
# or "[linux/amd64 build 8/10]" on a multi-platform builder) and reports its
# outcome on a later line ("#12 CACHED" / "#12 DONE 0.4s"). Ids are per build,
# so they are mapped inside this log only. The marker is matched on the full
# label, before anything is shortened for display.
ran=()
stamp_ran=0
stamp_seen=0
seen_deps=0 seen_build=0 seen_workflows=0
pkg_step=""
prod=()
while IFS=$'\t' read -r id stage num label; do
  if grep -qE "^${id} CACHED\$" "$LOG"; then
    status=cached
  elif grep -qE "^${id} DONE " "$LOG"; then
    status=ran
  else
    status=unknown
  fi
  short="${label:0:150}"
  case "$label" in
  *"$STAMP_MARKER"*)
    stamp_seen=1
    [ "$status" = ran ] && stamp_ran=1
    continue
    ;;
  # FROM resolves metadata and always reports DONE; it executes nothing.
  *"] FROM "*) continue ;;
  esac
  case "$stage" in
  deps) seen_deps=$((seen_deps + 1)) ;;
  build) seen_build=$((seen_build + 1)) ;;
  workflows) seen_workflows=$((seen_workflows + 1)) ;;
  esac
  case "$stage" in
  manifest) ;;
  production)
    case "$label" in *"COPY --from=build /app/package.json"*) pkg_step="$num" ;; esac
    prod+=("${num}"$'\t'"${status}"$'\t'"${short}")
    ;;
  *) [ "$status" = cached ] || ran+=("${status}: ${short}") ;;
  esac
done < <(grep -E '^#[0-9]+ \[([a-z0-9/]+ )?(manifest|deps|build|workflows|production) +[0-9]+/[0-9]+\] ' "$LOG" |
  awk '!seen[$1]++ {
    id = $1
    match($0, /\[([a-z0-9\/]+ )?[a-z]+ +[0-9]+\/[0-9]+\]/)
    head = substr($0, RSTART + 1, RLENGTH - 2)
    n = split(head, parts, " ")
    stage = (n >= 3) ? parts[n - 1] : parts[1]
    split(parts[n], frac, "/")
    label = $0
    sub(/^#[0-9]+ /, "", label)
    print id "\t" stage "\t" frac[1] "\t" label
  }')

if [ "$stamp_seen" -ne 1 ]; then
  cat "$LOG" >&2
  echo "no stamp step found (looked for: ${STAMP_MARKER})" >&2
  exit 1
fi
# A parser that classed every step as an allowed stage would pass anything.
if [ "$seen_deps" -eq 0 ] || [ "$seen_build" -eq 0 ] || [ "$seen_workflows" -eq 0 ]; then
  cat "$LOG" >&2
  echo "could not find the steps to judge (deps: ${seen_deps}, build: ${seen_build}, workflows: ${seen_workflows})" >&2
  exit 1
fi
# Production steps before the stamped package.json COPY must survive a release.
if [ -z "$pkg_step" ]; then
  cat "$LOG" >&2
  echo "no production 'COPY --from=build /app/package.json' step found to split the production stage on" >&2
  exit 1
fi
for entry in "${prod[@]}"; do
  IFS=$'\t' read -r num status short <<<"$entry"
  if [ "$num" -lt "$pkg_step" ] && [ "$status" != cached ]; then
    ran+=("${status}: ${short}")
  fi
done
if [ "$stamp_ran" -ne 1 ]; then
  echo "the stamp step did not run for a never-before-used VERSION, so this check proved nothing" >&2
  exit 1
fi
if [ "${#ran[@]}" -gt 0 ]; then
  echo "a release (package.json version bump + VERSION) re-ran steps that should be cache hits (#647):" >&2
  printf '  %s\n' "${ran[@]}" >&2
  echo "Keep the stamp last in the build stage, and package.json into deps/workflows from the manifest stage." >&2
  exit 1
fi
echo "    ok: a release re-ran only the manifest stage, the version stamp and the production layers after it"
