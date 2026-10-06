#!/usr/bin/env bash
# Tests for the release tag gate in .github/workflows/release-exec.yml (#644).
# Needs bash and bun (for Bun.YAML); no network, no Docker, no GitHub.
#
# The validator is a `run:` block inside the workflow, not a script file, on
# purpose: its job holds `permissions: {}` and checks nothing out, so there is
# no file to call. This test therefore pulls that block out of the YAML and
# executes it VERBATIM against each fixture, with the env the runner would give
# it. A copy of the regex kept here would pass forever while the workflow
# drifted.
#
# Three parts:
#   1. the validator: accept/reject for each tag, what reaches $GITHUB_OUTPUT,
#      that a hostile tag is never evaluated (a sentinel file stays absent),
#      that a real run must be building the tag it publishes, and that a UTF-8
#      locale does not widen the alphabet;
#   2. the structure that makes the validator the ONLY control that matters:
#      no `run:` contains a `${{ }}` expression; the raw tag (by expression, by
#      bracket syntax, or through $GITHUB_REF/$GITHUB_REF_NAME) is read nowhere
#      but the validator's env; the gate's outputs forward exactly what the
#      validator wrote; every output a job reads exists; every job that reads
#      one lists validate-tag in `needs:` (the needs context holds direct
#      dependencies only, so a missing entry silently yields ""); no consumer
#      runs after a failed gate; and every job sits downstream of it;
#   3. the structure check run against mutated copies of the workflow, one hole
#      per copy, each of which must be reported -- so a structure check that
#      has been neutered fails here instead of passing everything.
#   Plus one sink executed directly -- pack-brain's `npm version` -- with a
#   hostile value and no validator in front of it, to show the env-quoted form
#   is safe on its own and not just because the gate stopped the input.
#
# Run from anywhere:  .github/scripts/release-exec.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKFLOW="${RELEASE_EXEC_WORKFLOW:-${HERE}/../workflows/release-exec.yml}"

pass=0
fail=0
ok() {
	pass=$((pass + 1))
	echo "  ok   - $1"
}
no() {
	fail=$((fail + 1))
	echo "  FAIL - $1"
	[ -n "${2:-}" ] && printf '%s\n' "$2" | sed 's/^/         /'
}

WORK="$(mktemp -d)" || exit 1
trap 'rm -rf "$WORK"' EXIT

command -v bun >/dev/null || {
	echo "bun is required (Bun.YAML)" >&2
	exit 1
}

# yq <mode> [args]: read a workflow (default $WORKFLOW, or $YQ_FILE) with Bun's
# YAML parser.
yq() {
	# shellcheck disable=SC2016 # JavaScript source, not shell: nothing should expand.
	WORKFLOW="${YQ_FILE:-$WORKFLOW}" bun -e '
const mode = process.argv[1];
const doc = Bun.YAML.parse(await Bun.file(process.env.WORKFLOW).text());
const jobs = doc.jobs ?? {};
const needsOf = (j) => [jobs[j]?.needs ?? []].flat();
const findStep = (job, pred) => (jobs[job]?.steps ?? []).find(pred);
if (mode === "validator" || mode === "step") {
  const step = mode === "validator"
    ? findStep("validate-tag", (s) => s.id === "validate")
    : findStep(process.argv[2], (s) => s.name === process.argv[3] || s.id === process.argv[3]);
  if (!step || typeof step.run !== "string") process.exit(3);
  process.stdout.write(step.run);
  process.exit(0);
}
if (mode === "run-expressions") {
  // #684: the same rule as the structure check below, for any workflow:
  // no `run:` (or github-script `script:`) contains a ${{ }} expression.
  const found = [];
  for (const [name, job] of Object.entries(jobs))
    for (const [i, s] of (job.steps ?? []).entries()) {
      const label = name + ": step " + (s.name ?? s.id ?? s.uses ?? String(i));
      if (typeof s.run === "string" && s.run.includes("${{")) found.push(label + " has a ${{ }} expression inside run:");
      if (typeof s.with?.script === "string" && s.with.script.includes("${{")) found.push(label + " has a ${{ }} expression inside a script: input");
    }
  if (found.length) console.log(found.join("\n"));
  process.exit(0);
}
// mode === "structure": one violation per line, nothing when clean.
const out = [];
const EXPECT_OUTPUTS = {
  tag: "${{ steps.validate.outputs.tag }}",
  version: "${{ steps.validate.outputs.version }}",
  prerelease: "${{ steps.validate.outputs.prerelease }}",
};
const EXPECT_ENV = {
  RAW_TAG: "${{ inputs.tag || github.ref_name }}",
  REF_NAME: "${{ github.ref_name }}",
  REF_TYPE: "${{ github.ref_type }}",
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const gate = jobs["validate-tag"];
if (!gate) out.push("no validate-tag job");
else {
  const perms = gate.permissions;
  if (!(perms && typeof perms === "object" && Object.keys(perms).length === 0))
    out.push("validate-tag must declare permissions: {} (got " + JSON.stringify(perms) + ")");
  const steps = gate.steps ?? [];
  if (steps.length !== 1 || steps[0].id !== "validate" || steps[0].uses)
    out.push("validate-tag must run exactly one step, its own `validate` run block");
  const v = steps.find((s) => s.id === "validate");
  if (v && !same(v.env, EXPECT_ENV))
    out.push("validate-tag step env must be exactly " + JSON.stringify(EXPECT_ENV) + " (got " + JSON.stringify(v.env) + ")");
  if (v && v.shell !== undefined && v.shell !== "bash")
    out.push("validate-tag step must run under bash (got shell: " + v.shell + ")");
  if (!same(gate.outputs, EXPECT_OUTPUTS))
    out.push("validate-tag outputs must forward exactly what the validator wrote: " + JSON.stringify(EXPECT_OUTPUTS) + " (got " + JSON.stringify(gate.outputs) + ")");
}
// The raw tag, in every spelling: expression syntax with dots or brackets,
// the push event payload, and the runner default env vars a `run:` can read.
const raw = /\binputs\s*(\.|\[)\s*["\x27]?tag\b|\bgithub\s*(\.|\[)\s*["\x27]?(ref|ref_name|event|event_path|workflow_ref)\b|\bGITHUB_(REF|REF_NAME|EVENT_PATH|WORKFLOW_REF)\b|\btoJSON\s*\(\s*(github|inputs)\s*\)/i;
if (raw.test(JSON.stringify(doc.env ?? {}))) out.push("workflow-level env reads the raw tag");
// The release must be created at the commit this run built, or a tag that
// vanished mid-run is re-created at the default branch tip.
const rel = (jobs["github-release"]?.steps ?? []).find((s) => String(s.uses ?? "").startsWith("softprops/action-gh-release@"));
if (!rel) out.push("github-release has no action-gh-release step");
else if (rel.with?.target_commitish !== "${{ github.sha }}")
  out.push("action-gh-release must set target_commitish: ${{ github.sha }} (got " + JSON.stringify(rel.with?.target_commitish) + ")");
const reads = /needs\s*(\.\s*validate-tag|\[\s*["\x27]validate-tag["\x27]\s*\])/;
const readKeys = /needs\s*(?:\.\s*validate-tag|\[\s*["\x27]validate-tag["\x27]\s*\])\s*\.\s*outputs\s*\.\s*([A-Za-z0-9_-]+)/g;
for (const [name, job] of Object.entries(jobs)) {
  const text = JSON.stringify(job);
  if (name !== "validate-tag" && raw.test(text))
    out.push(name + ": reads the raw tag instead of needs.validate-tag.outputs");
  for (const [i, s] of (job.steps ?? []).entries()) {
    const label = s.name ?? s.id ?? s.uses ?? String(i);
    if (typeof s.run === "string" && s.run.includes("${{"))
      out.push(name + ": step " + label + " has a ${{ }} expression inside run:");
    if (typeof s.with?.script === "string" && s.with.script.includes("${{"))
      out.push(name + ": step " + label + " has a ${{ }} expression inside a script: input");
  }
  if (name === "validate-tag" || !reads.test(text)) continue;
  if (!needsOf(name).includes("validate-tag"))
    out.push(name + ": reads needs.validate-tag.* but does not list validate-tag in needs");
  for (const m of text.matchAll(readKeys))
    if (!gate?.outputs || !(m[1] in gate.outputs))
      out.push(name + ": reads needs.validate-tag.outputs." + m[1] + ", which validate-tag does not output");
  if (/\b(always|failure|cancelled)\s*\(/.test(String(job.if ?? "")))
    out.push(name + ": reads validate-tag outputs but can run after a failed gate (if: " + job.if + ")");
}
// #645: one publish at a time, queued rather than cancelled. The group must be
// global for real publishes -- per-ref or per-run context would put two
// releases in different groups and let them race for :latest again.
const cc = doc.concurrency;
if (!cc || typeof cc !== "object") out.push("no workflow-level concurrency block (#645)");
else {
  if (cc["cancel-in-progress"] !== false)
    out.push("concurrency must set cancel-in-progress: false; cancelling a half-finished publish is worse than queueing (got " + JSON.stringify(cc["cancel-in-progress"]) + ")");
  // An allowlist, not a denylist of contexts: any expression in the group
  // can split two releases into different groups.
  if (cc.group !== "release-exec")
    out.push("concurrency group must be exactly the global release-exec (got " + JSON.stringify(cc.group) + ")");
  // The default queue holds one pending run and cancels it for the next one.
  if (cc.queue !== "max")
    out.push("concurrency must set queue: max, or a third queued release evicts the waiting one (got " + JSON.stringify(cc.queue) + ")");
}
const reaches = (j, seen = new Set()) => {
  if (j === "validate-tag") return true;
  if (seen.has(j)) return false;
  seen.add(j);
  return needsOf(j).some((n) => reaches(n, seen));
};
for (const name of Object.keys(jobs))
  if (name !== "validate-tag" && !reaches(name)) out.push(name + ": does not run downstream of validate-tag");
// #682: every job that installs dependencies runs either before the sidecar
// workflow starts (upstream of it) or after it has published (downstream).
// Running alongside it, a lifecycle script could swap a sidecar artifact
// between its upload and the download in publish-sidecar.
const upstreamOf = (j, target, seen = new Set()) => {
  if (j === target) return true;
  if (seen.has(j)) return false;
  seen.add(j);
  return needsOf(j).some((n) => upstreamOf(n, target, seen));
};
for (const [name, job] of Object.entries(jobs)) {
  const runs = (job.steps ?? []).map((st) => typeof st.run === "string" ? st.run : "").join("\n");
  const depCode = /\b(?:bun\s+(?:install|i|add|run|test|x)|bunx|npx|npm\s+(?:ci|install|i|run|run-script|test|pack|exec|x))\b/;
  if (!depCode.test(runs) || !jobs.sidecar) continue;
  if (!upstreamOf("sidecar", name) && !upstreamOf(name, "sidecar"))
    out.push(name + ": installs dependencies while the sidecar workflow may still be running (neither before nor after it)");
}
// ...and ordering covers only publish-sidecar. A job that consumes the
// sidecar-* artifacts later (github-release attaches them) checks them
// against the digests publish-sidecar recorded, which arrive as a job output.
for (const [name, job] of Object.entries(jobs)) {
  const steps = job.steps ?? [];
  // A download reaches the sidecar artifacts when it names none (that is
  // all of them) or its name or glob matches a sidecar artifact name.
  const glob = (g) => new RegExp("^" + String(g).replace(/[.+^$(){}|\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
  const reaches = (st) => {
    const w = st.with ?? {};
    if (w.name === undefined && w.pattern === undefined) return true;
    return ["sidecar-linux-x64", "sidecar-win32-x64", "sidecar-darwin-arm64"].some((n) => glob(w.pattern ?? w.name).test(n));
  };
  const dl = steps.findIndex((st) => String(st.uses ?? "").startsWith("actions/download-artifact@") && reaches(st));
  if (dl < 0) continue;
  // Same condition as the download (or none), so it cannot be switched off
  // on its own.
  const cond = steps[dl].if;
  const v = steps.findIndex((st, i) => i > dl && typeof st.run === "string" && /\bsha256sum\b[^\n]*-c\b/.test(st.run) &&
    /needs\.sidecar\.outputs\.sums/.test(JSON.stringify(st.env ?? {})) && (st.if === undefined || st.if === cond));
  if (v < 0) out.push(name + ": uses the sidecar artifacts without checking them against needs.sidecar.outputs.sums");
  else if (steps.slice(dl + 1, v).some((st) => st.run !== undefined || st.uses))
    out.push(name + ": does something with the sidecar artifacts before checking their digests");
}
if (out.length) console.log(out.join("\n"));
' "$@"
}

VALIDATOR="$(yq validator)" || {
	echo "could not extract the validate-tag step from $WORKFLOW" >&2
	exit 1
}

echo "release tag validator (executed verbatim from the workflow)"

# The script must be runnable as extracted. If it carried a ${{ }}, executing it
# here would test text the runner never runs.
# shellcheck disable=SC2016 # a literal GitHub expression opener is the pattern.
case "$VALIDATOR" in
*'${{'*) no "the validator contains a \${{ }} expression, so this test cannot execute it as the runner would" ;;
*) ok "the validator has no \${{ }} expression, so what runs here is what runs in CI" ;;
esac

# run_validator <tag> [ref_name] [ref_type] [dry_run] [locale]: sets RC and
# OUT (the $GITHUB_OUTPUT content). Defaults model a tag push of <tag>.
run_validator() {
	local out="${WORK}/output"
	: >"$out"
	local -a envs=(PATH="$PATH" GITHUB_OUTPUT="$out"
		RAW_TAG="$1" REF_NAME="${2-$1}" REF_TYPE="${3:-tag}" DRY_RUN="${4:-false}")
	[ -n "${5:-}" ] && envs+=(LC_ALL="$5" LANG="$5")
	env -i "${envs[@]}" bash -c "$VALIDATOR" >"${WORK}/stdout" 2>&1
	RC=$?
	OUT="$(cat "$out")"
}

# accept <tag> <version> <prerelease> [ref_name] [ref_type] [dry_run]
accept() {
	local label
	label="$(printf '%q' "$1")${4+ on ${5:-tag} $(printf '%q' "$4")}${6:+ (dry_run=$6)}"
	run_validator "$1" "${4-$1}" "${5:-tag}" "${6:-false}"
	local want
	want="$(printf 'tag=v%s\nversion=%s\nprerelease=%s' "$2" "$2" "$3")"
	if [ "$RC" -eq 0 ] && [ "$OUT" = "$want" ]; then
		ok "accepts ${label} -> version=$2 prerelease=$3"
	else
		no "accepts ${label}" "exit ${RC}; GITHUB_OUTPUT was:
${OUT}
expected:
${want}
stdout/stderr:
$(cat "${WORK}/stdout")"
	fi
}

# expect_rejected <label> <error prefix>: the run just made must have exited
# non-zero, written NOTHING to $GITHUB_OUTPUT, printed exactly one workflow
# command (the ::error:: naming the problem), and created no sentinel.
expect_rejected() {
	local label="$1" prefix="$2"
	if [ "$RC" -eq 0 ]; then
		no "rejects ${label}" "exited 0; GITHUB_OUTPUT was:
${OUT}"
	elif [ -n "$OUT" ]; then
		no "rejects ${label} without writing outputs" "GITHUB_OUTPUT was:
${OUT}"
	elif ! grep -qF "::error::${prefix}" "${WORK}/stdout"; then
		no "rejects ${label} with the ::error:: '${prefix}...'" "$(cat "${WORK}/stdout")"
	elif [ "$(grep -c '^::' "${WORK}/stdout")" -ne 1 ]; then
		no "rejects ${label} with exactly one workflow command (a newline must not start another)" "$(cat "${WORK}/stdout")"
	elif [ -e "${WORK}/pwned" ]; then
		no "rejects ${label} without evaluating it" "the sentinel ${WORK}/pwned was created"
	else
		ok "rejects ${label}"
	fi
}

NOT_SEMVER='Release tag is not v<semver>'
WRONG_REF='A real release must build the tag it publishes'

# reject <tag>: rejected as malformed (on a tag push of itself).
reject() {
	rm -f "${WORK}/pwned"
	run_validator "$1"
	expect_rejected "$(printf '%q' "$1")" "$NOT_SEMVER"
}

accept 'v1.2.3' '1.2.3' false
accept 'v1.2.3-rc.1' '1.2.3-rc.1' true
# workflow_dispatch's default input: a dry run must still get past the gate.
accept 'v0.0.0-dry-run' '0.0.0-dry-run' true main branch true
accept 'v10.20.30' '10.20.30' false
# What `npm version prerelease` produces, i.e. what release.yml can dispatch.
accept 'v1.2.4-0' '1.2.4-0' true
accept 'v1.2.3-alpha-1.beta.11' '1.2.3-alpha-1.beta.11' true
accept 'v1.2.3-0a.x-y' '1.2.3-0a.x-y' true

# Sizes every publisher accepts: 16-digit components, a 128-character version
# (Docker's tag limit; npm's is 256).
accept 'v1234567890123456.0.0' '1234567890123456.0.0' false
reject 'v12345678901234567.0.0'
reject 'v1.12345678901234567.0'
LONG_OK="1.2.3-$(printf 'a%.0s' $(seq 1 122))"
accept "v${LONG_OK}" "$LONG_OK" true
reject "v${LONG_OK}a"

# No leading v: github-release uses the tag verbatim as tag_name.
reject '1.2.3'
reject ''
reject 'v'
reject 'v1.2'
reject 'v01.2.3'
reject 'vv1.2.3'
reject 'refs/tags/v1.2.3'
reject ' v1.2.3'
reject 'v1.2.3 '
# Build metadata: npm drops it, so v1.2.3+x would collide with 1.2.3.
reject 'v1.2.3-rc.1+build.5'
reject 'v1.2.3+build.5'
reject 'v1.2.3+build-5'
# Looser than SemVer 2.0 pre-release identifiers, all refused by `npm version`.
reject 'v1.2.3-'
reject 'v1.2.3-01'
reject 'v1.2.3-rc.01'
reject 'v1.2.3-.'
reject 'v1.2.3-rc..1'
reject 'v1.2.3-rc.'
# The two shapes the issue verified git accepts as ref names.
reject 'v1.0.0";id;"'
# shellcheck disable=SC2016 # the literal, unexpanded text IS the fixture.
reject 'v1.0.0$(id)'
# The same shapes with a payload that would leave evidence if evaluated.
reject "v1.0.0\$(touch ${WORK}/pwned)"
reject "v1.0.0\";touch ${WORK}/pwned;\""
reject "v1.0.0\`touch ${WORK}/pwned\`"
reject "v1.0.0-\$(touch ${WORK}/pwned)"
# Newlines: the old echo would have written a second KEY=value line, and a
# per-line regex would accept the first line.
reject $'v1.2.3\nversion=9.9.9'
reject $'v1.2.3\n'
reject $'v1.2.3\n::warning::injected'
reject $'v1.2.3\rversion=9.9.9'

# The tag must be the ref being built on a real run; a dry run is free.
rm -f "${WORK}/pwned"
run_validator 'v1.2.3' 'main' 'branch' false
expect_rejected "v1.2.3 dispatched from branch main (real run)" "$WRONG_REF"
run_validator 'v1.2.4' 'v1.2.3' 'tag' false
expect_rejected "tag input v1.2.4 on a run of tag v1.2.3 (real run)" "$WRONG_REF"
run_validator 'v1.2.3' 'v1.2.3' 'branch' false
expect_rejected "v1.2.3 on a BRANCH named v1.2.3 (real run)" "$WRONG_REF"
accept 'v1.2.3' '1.2.3' false 'main' 'branch' true

# A UTF-8 locale must not widen [A-Za-z]/[0-9] past ASCII. Under glibc's
# en_US.UTF-8 both of these matched the unguarded regex; the runner itself uses
# C.UTF-8, where they do not, which is why this pins en_US explicitly.
UTF8_LOCALE="$(locale -a 2>/dev/null | grep -im1 -E '^en_US\.utf-?8$' || true)"
if [ -z "$UTF8_LOCALE" ]; then
	echo "  skip - no en_US.UTF-8 locale on this machine, so the locale fixtures cannot run"
else
	for tag in $'v1.2.3-é' $'v١.2.3' $'v1.2.3-ａ'; do
		run_validator "$tag" "$tag" tag false "$UTF8_LOCALE"
		expect_rejected "$(printf '%q' "$tag") under ${UTF8_LOCALE}" "$NOT_SEMVER"
	done
fi

echo
echo "workflow structure"
VIOLATIONS="$(yq structure)" || {
	no "structure check ran" "the bun helper failed"
	VIOLATIONS=""
}
if [ -z "$VIOLATIONS" ]; then
	ok "no run: contains \${{ }}, the raw tag is read only by the validator, outputs and needs line up, every job is gated"
else
	no "workflow structure" "$VIOLATIONS"
fi

echo
echo "the structure check reports each hole (mutated copies of the workflow)"
# mutant <label> <exact text> <replacement>: the text must occur exactly once.
mutant() {
	local label="$1" copy="${WORK}/mutant.yml"
	if ! FROM="$WORKFLOW" TO="$copy" OLD="$2" NEW="$3" bun -e '
const s = await Bun.file(process.env.FROM).text();
const n = s.split(process.env.OLD).length - 1;
if (n !== 1) { console.error("anchor occurs " + n + " times"); process.exit(2); }
await Bun.write(process.env.TO, s.replace(process.env.OLD, process.env.NEW));
'; then
		no "mutant '${label}' could be applied (the workflow no longer has the text it mutates)"
		return
	fi
	local found
	found="$(YQ_FILE="$copy" yq structure)"
	if [ -n "$found" ]; then
		ok "reports: ${label}"
	else
		no "reports: ${label}" "the structure check passed a workflow with this hole"
	fi
}
# shellcheck disable=SC2016 # every mutant is literal workflow text.
{
	mutant 'the gate forwarding the raw tag as an output' \
		'version: ${{ steps.validate.outputs.version }}' 'version: ${{ inputs.tag || github.ref_name }}'
	mutant 'a ${{ }} expression back inside a run:' \
		'run: npm version "$VERSION"' 'run: npm version "${{ needs.validate-tag.outputs.version }}"'
	mutant 'a consumer that does not list validate-tag in needs' \
		'needs: [validate-tag, pack-brain, build-docker, sidecar]' 'needs: [pack-brain, build-docker, sidecar]'
	mutant 'RELEASE_TAG back in the workflow env' \
		'  DRY_RUN: ${{ inputs.dry_run || false }}' '  DRY_RUN: ${{ inputs.dry_run || false }}
  RELEASE_TAG: ${{ inputs.tag || github.ref_name }}'
	mutant 'a step reading $GITHUB_REF_NAME' \
		'run: npm version "$VERSION"' 'run: npm version "${GITHUB_REF_NAME#v}"'
	mutant 'an env var bound to github.event.ref' \
		'VERSION: ${{ needs.validate-tag.outputs.version }}
        run: npm version' 'VERSION: ${{ github.event.ref }}
        run: npm version'
	mutant 'bracket syntax for the raw tag' \
		'tag_name: ${{ needs.validate-tag.outputs.tag }}' "tag_name: \${{ github['ref_name'] }}"
	mutant 'a step reading the event payload file' \
		'run: npm version "$VERSION"' 'run: npm version "$(jq -r .ref "$GITHUB_EVENT_PATH")"'
	mutant 'the whole github context serialised into an env var' \
		'VERSION: ${{ needs.validate-tag.outputs.version }}
        run: npm version' 'VERSION: ${{ toJSON(github) }}
        run: npm version'
	mutant 'the release no longer pinned to the built commit' \
		'          target_commitish: ${{ github.sha }}
' ''
	mutant 'a token scope on the gate' \
		'    permissions: {}
    timeout-minutes: 5' '    permissions:
      contents: read
    timeout-minutes: 5'
	mutant 'the validator fed something other than the tag' \
		'RAW_TAG: ${{ inputs.tag || github.ref_name }}' 'RAW_TAG: ${{ github.event.head_commit.message }}'
	mutant 'a second step in the gate' \
		'      - name: Validate the release tag' '      - uses: actions/checkout@v5
      - name: Validate the release tag'
	mutant 'a consumer that runs after a failed gate' \
		'    needs: [validate-tag, publish-docker, sidecar]' '    needs: [validate-tag, publish-docker, sidecar]
    if: always()'
	mutant 'a misspelt output name' \
		'enable=${{ needs.validate-tag.outputs.prerelease' 'enable=${{ needs.validate-tag.outputs.prerelaese'
	mutant 'a per-ref concurrency group (#645)' \
		"group: release-exec" 'group: release-exec-${{ github.ref }}'
	mutant 'a dry-run-split concurrency group (#645)' \
		'  group: release-exec
' "  group: release-exec\${{ inputs.dry_run && '-dry-run' || '' }}
"
	mutant 'the default single-pending queue (#645)' \
		'  queue: max
' ''
	mutant 'cancel-in-progress on the publish group (#645)' \
		'  cancel-in-progress: false' '  cancel-in-progress: true'
	mutant 'the brain build running alongside the sidecar workflow (#682)' \
		'    needs: [validate-tag, test, build-docker, sidecar]' '    needs: [validate-tag, test, build-docker]'
	mutant 'the GitHub Release attaching sidecar binaries without checking their digests (#682)' \
		"printf '%s' \"\$SUMS\" | base64 -d | sha256sum --strict -c -" "true"
	mutant 'the sidecar digest check switched off on its own (#682)' \
		$'      - name: Verify sidecar binaries\n        if: needs.sidecar.outputs.released == \'true\'' $'      - name: Verify sidecar binaries\n        if: false'
	mutant 'a download of every artifact attached without a digest check (#682)' \
		$'          path: artifacts\n          pattern: sidecar-*\n\n      # Exactly the bytes' $'          path: artifacts\n\n      - run: ls artifacts\n\n      # Exactly the bytes'
	mutant 'a job no longer downstream of the gate' \
		'  test:
    needs: validate-tag' '  test:'
}

echo
echo "sidecar-release.yml: no \${{ }} inside run: (#684)"
# The reusable sidecar workflow runs in the same release, and its publish job
# holds id-token too. Its versions come from sidecar/VERSION rather than the
# tag, so the gate above does not cover them; the structure rule does.
SIDECAR_WORKFLOW="${SIDECAR_RELEASE_WORKFLOW:-${HERE}/../workflows/sidecar-release.yml}"
found="$(YQ_FILE="$SIDECAR_WORKFLOW" yq run-expressions)" || {
	no "sidecar-release.yml run-expression check ran" "the bun helper failed"
	found=""
}
if [ -z "$found" ]; then
	ok "sidecar-release.yml: every run: takes its values through env:"
else
	no "sidecar-release.yml: every run: takes its values through env:" "$found"
fi
copy="${WORK}/sidecar-mutant.yml"
# shellcheck disable=SC2016 # JavaScript source, not shell.
FROM="$SIDECAR_WORKFLOW" TO="$copy" bun -e '
const s = await Bun.file(process.env.FROM).text();
const anchor = "npm version \"${VERSION}\" --no-git-tag-version --allow-same-version";
if (!s.includes(anchor)) process.exit(2);
await Bun.write(process.env.TO, s.replace(anchor, "npm version \"${{ needs.resolve.outputs.version }}\" --no-git-tag-version --allow-same-version"));
' || no "the sidecar mutant could be applied (the workflow no longer has the text it mutates)"
if [ -f "$copy" ] && [ -n "$(YQ_FILE="$copy" yq run-expressions)" ]; then
	ok "reports: a \${{ }} expression back inside a sidecar-release.yml run:"
else
	no "reports: a \${{ }} expression back inside a sidecar-release.yml run:"
fi

echo
echo "sink executed without the gate in front of it"
# The brain's `npm version` is the line #644 named (in publish-brain then,
# in pack-brain since #682 split the build out of the OIDC job). Run its
# script with a hostile VERSION in env and an npm stub that records its argv:
# the value must arrive as one literal argument and run nothing.
SINK="$(yq step pack-brain 'Set package version')" || SINK=""
if [ -z "$SINK" ]; then
	no "found pack-brain's 'Set package version' step"
else
	mkdir -p "${WORK}/bin"
	cat >"${WORK}/bin/npm" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$@" >"$NPM_ARGV"
EOF
	chmod +x "${WORK}/bin/npm"
	rm -f "${WORK}/pwned"
	hostile="1.0.0\";touch ${WORK}/pwned;\"\$(touch ${WORK}/pwned)"
	env -i PATH="${WORK}/bin:$PATH" NPM_ARGV="${WORK}/argv" VERSION="$hostile" bash -c "$SINK" >/dev/null 2>&1
	first="$(head -n1 "${WORK}/argv" 2>/dev/null)"
	second="$(sed -n 2p "${WORK}/argv" 2>/dev/null)"
	if [ -e "${WORK}/pwned" ]; then
		no "the npm version step does not evaluate VERSION" "sentinel created"
	elif [ "$first" != "version" ] || [ "$second" != "$hostile" ]; then
		no "the npm version step passes VERSION as one literal argument" "argv was:
$(cat "${WORK}/argv" 2>/dev/null)"
	else
		ok "the npm version step passes a hostile VERSION as one literal argument and runs nothing"
	fi
fi

echo
echo "sidecar version gate (sidecar-release.yml resolve step, executed verbatim)"
# #684. The sidecar version comes from sidecar/VERSION, not the tag, so the
# gate above never sees it. resolve now checks it before it becomes an output;
# run that script against hostile file contents (dry run, so it never reaches
# npm) and check what reaches $GITHUB_OUTPUT.
RESOLVE="$(YQ_FILE="$SIDECAR_WORKFLOW" yq step resolve v)" || RESOLVE=""
if [ -z "$RESOLVE" ]; then
	no "found sidecar-release.yml's resolve step"
else
	# sidecar_resolve <file contents>: sets RC and OUT.
	# sidecar_resolve <file contents> [locale]
	sidecar_resolve() {
		rm -rf "${WORK}/sc" && mkdir -p "${WORK}/sc/sidecar"
		printf '%s' "$1" >"${WORK}/sc/sidecar/VERSION"
		: >"${WORK}/sc/out"
		local -a envs=(PATH="$PATH" GITHUB_OUTPUT="${WORK}/sc/out" DRY_RUN=true)
		[ -n "${2:-}" ] && envs+=(LC_ALL="$2" LANG="$2")
		(cd "${WORK}/sc" && env -i "${envs[@]}" bash -c "$RESOLVE") >"${WORK}/sc/log" 2>&1
		RC=$?
		OUT="$(cat "${WORK}/sc/out")"
	}
	for v in 0.10.0 $'0.10.0\n' 1.2.3-rc.1 1.2.3-alpha-1.beta.11 10.20.30; do
		sidecar_resolve "$v"
		# The file normally ends in a newline, which $(cat) drops.
		if [ "$RC" -eq 0 ] && [ "$OUT" = "$(printf 'version=%s\nshould_release=true' "${v%$'\n'}")" ]; then
			ok "sidecar resolve accepts $(printf '%q' "$v")"
		else
			no "sidecar resolve accepts $(printf '%q' "$v")" "exit ${RC}; output: ${OUT}; log: $(cat "${WORK}/sc/log")"
		fi
	done
	for v in '' '1.2' '01.2.3' '1.2.3+build' $'1.2.3\nshould_release=false' "1.2.3\$(touch ${WORK}/pwned)" \
		"1.2.3\";touch ${WORK}/pwned;\"" '1.2.3|x' '1.2.3/x' '1.2.3-' "1.2.3-rc.1 " '1.2.3-01' '1.2.3-rc..1'; do
		rm -f "${WORK}/pwned"
		sidecar_resolve "$v"
		if [ "$RC" -ne 0 ] && [ -z "$OUT" ] && [ ! -e "${WORK}/pwned" ] && grep -qF '::error::sidecar/VERSION is not a plain semver' "${WORK}/sc/log"; then
			ok "sidecar resolve rejects $(printf '%q' "$v") without writing outputs"
		else
			no "sidecar resolve rejects $(printf '%q' "$v")" "exit ${RC}; output: ${OUT}; log: $(cat "${WORK}/sc/log")"
		fi
	done
	# Under a UTF-8 locale glibc's [A-Za-z] and [0-9] match more than ASCII;
	# the step pins LC_ALL=C, as the tag gate does.
	if [ -z "$UTF8_LOCALE" ]; then
		echo "  skip - no en_US.UTF-8 locale on this machine, so the sidecar locale fixtures cannot run"
	else
		for v in $'1.2.3-\u00e9' $'\u0661.2.3' $'1.2.3-\uff41'; do
			sidecar_resolve "$v" "$UTF8_LOCALE"
			if [ "$RC" -ne 0 ] && [ -z "$OUT" ]; then
				ok "sidecar resolve rejects $(printf '%q' "$v") under ${UTF8_LOCALE}"
			else
				no "sidecar resolve rejects $(printf '%q' "$v") under ${UTF8_LOCALE}" "exit ${RC}; output: ${OUT}"
			fi
		done
	fi
fi

echo
echo "${pass} passed, ${fail} failed"
[ "$fail" -eq 0 ]
