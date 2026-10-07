#!/usr/bin/env bash
# Tests for .github/scripts/watch-release-run.sh (#683) and for how
# release.yml calls it. Needs bash, bun (for Bun.YAML) and jq; no network and
# no GitHub: `gh` is a fake on PATH that plays one scenario per case and
# records every call it gets.
#
# Run from anywhere:  .github/scripts/watch-release-run.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="${WATCH_RELEASE_RUN_SCRIPT:-${HERE}/watch-release-run.sh}"
RELEASE="${RELEASE_WORKFLOW:-${HERE}/../workflows/release.yml}"

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

command -v bun >/dev/null || {
	echo "bun is required (Bun.YAML)" >&2
	exit 1
}
command -v jq >/dev/null || {
	echo "jq is required" >&2
	exit 1
}
WORK="$(mktemp -d)" || exit 1
trap 'rm -rf "$WORK"' EXIT

# The fake gh. It answers in JSON and, like gh, applies the caller's --jq
# program to it (with jq), so the script's own jq programs run here too.
# Scenario knobs (environment):
#   FAKE_DISPATCH       body the dispatch answers with ("" is a 204)
#   FAKE_DISPATCH_RC    its exit code (default 0)
#   FAKE_LISTS          run ids the lookup answers, one list per call,
#                       separated by "|" ("x" makes that call fail); the last
#                       repeats
#   FAKE_RUN            the JSON of runs/<id> ("x" makes the call fail)
#   FAKE_WATCH_RCS      exit codes of successive `gh run watch` calls, "|"
#                       separated, the last repeating (default 0)
#   FAKE_WATCH_SLEEP    seconds `gh run watch` takes (default 0)
#   FAKE_RESULTS        successive `gh run view` answers, "status conclusion"
#                       separated by "|" ("x" fails that call); the last repeats
mkdir -p "${WORK}/bin"
cat >"${WORK}/bin/gh" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$FAKE_LOG"
jqprog=""
args=("$@")
for ((k = 0; k < ${#args[@]}; k++)); do [ "${args[$k]}" = "--jq" ] && jqprog="${args[$((k + 1))]}"; done
# nth <knob value> <counter name>: the Nth "|" field of a knob, the last repeating.
nth() {
	local n
	n="$(cat "${FAKE_COUNT}.$2" 2>/dev/null || echo 0)"
	echo $((n + 1)) >"${FAKE_COUNT}.$2"
	IFS='|' read -r -a parts <<<"$1"
	[ "${#parts[@]}" -eq 0 ] && parts=("")
	printf '%s' "${parts[$((n < ${#parts[@]} ? n : ${#parts[@]} - 1))]}"
}
answer() { if [ -n "$jqprog" ]; then jq -r "$jqprog" <<<"$1"; else printf '%s\n' "$1"; fi; }
case "$1 $2" in
"api --method")
	if [ "$3" = "POST" ]; then
		printf '%s' "${FAKE_DISPATCH-}"
		exit "${FAKE_DISPATCH_RC:-0}"
	fi
	ids="$(nth "${FAKE_LISTS-}" lookup)"
	[ "$ids" = x ] && { echo "HTTP 502" >&2; exit 1; }
	answer "$(jq -cn --arg ids "$ids" '{workflow_runs: ($ids | split(" ") | map(select(. != "") | {id: tonumber}))}')"
	;;
"api repos/"*)
	[ "$FAKE_RUN" = x ] && { echo "HTTP 502" >&2; exit 1; }
	answer "$FAKE_RUN"
	;;
"run watch")
	rc="$(nth "${FAKE_WATCH_RCS:-0}" watch)"
	# exec, so a timeout kills the sleep itself and leaves no orphan behind.
	[ "${FAKE_WATCH_SLEEP:-0}" != 0 ] && exec sleep "$FAKE_WATCH_SLEEP"
	exit "$rc"
	;;
"run view")
	r="$(nth "${FAKE_RESULTS-completed success}" view)"
	[ "$r" = x ] && { echo "HTTP 502" >&2; exit 1; }
	answer "$(jq -cn --arg s "${r%% *}" --arg c "${r#* }" '{status: $s, conclusion: (if $c == "" or $c == $s then null else $c end)}')"
	;;
*)
	echo "fake gh: unexpected call: $*" >&2
	exit 99
	;;
esac
EOF
chmod +x "${WORK}/bin/gh"

TAG=v1.2.3
SHA=0123456789abcdef0123456789abcdef01234567
# run_json <path> <event> <branch or null> <sha>
run_json() { jq -cn --arg p "$1" --arg e "$2" --argjson b "$3" --arg s "$4" '{path: $p, event: $e, head_branch: $b, head_sha: $s, html_url: "https://github.com/o/r/actions/runs/42"}'; }
RUN_OK="$(run_json .github/workflows/release-exec.yml workflow_dispatch '"v1.2.3"' "$SHA")"

# run_case: run the script under the current FAKE_* settings; sets RC, LOG.
run_case() {
	: >"${WORK}/calls"
	rm -f "${WORK}/count".*
	: >"${WORK}/summary"
	env -i PATH="${WORK}/bin:$PATH" HOME="$WORK" FAKE_LOG="${WORK}/calls" FAKE_COUNT="${WORK}/count" \
		FAKE_DISPATCH="${FAKE_DISPATCH-}" FAKE_DISPATCH_RC="${FAKE_DISPATCH_RC:-0}" FAKE_LISTS="${FAKE_LISTS-}" \
		FAKE_RUN="${FAKE_RUN-$RUN_OK}" FAKE_WATCH_RCS="${FAKE_WATCH_RCS:-0}" FAKE_WATCH_SLEEP="${FAKE_WATCH_SLEEP:-0}" \
		FAKE_RESULTS="${FAKE_RESULTS-completed success}" \
		TAG="$TAG" SHA="$SHA" GITHUB_REPOSITORY=o/r GITHUB_STEP_SUMMARY="${WORK}/summary" \
		WATCH_TIMEOUT_SECONDS="${WATCH_TIMEOUT_SECONDS:-60}" WATCH_INTERVAL=0 LOOKUP_ATTEMPTS="${LOOKUP_ATTEMPTS:-3}" LOOKUP_INTERVAL=0 \
		READ_ATTEMPTS=3 bash "$SCRIPT" >"${WORK}/out" 2>&1
	RC=$?
	LOG="$(cat "${WORK}/out")"
}
reset() {
	FAKE_DISPATCH='{"workflow_run_id":42,"run_url":"u","html_url":"h"}'
	FAKE_DISPATCH_RC=0
	FAKE_LISTS=""
	FAKE_RUN="$RUN_OK"
	FAKE_WATCH_RCS=0
	FAKE_WATCH_SLEEP=0
	FAKE_RESULTS="completed success"
	WATCH_TIMEOUT_SECONDS=60
	LOOKUP_ATTEMPTS=3
}
# expect <label> <rc: 0 or nonzero> [text the output must contain]
expect() {
	local want="$2"
	if { [ "$want" = 0 ] && [ "$RC" -ne 0 ]; } || { [ "$want" != 0 ] && [ "$RC" -eq 0 ]; }; then
		no "$1" "exit ${RC}; output:
${LOG}"
	elif [ -n "${3:-}" ] && ! grep -qF -- "$3" <<<"$LOG"; then
		no "$1" "output lacks '${3}':
${LOG}"
	else
		ok "$1"
	fi
}
RECOVER='Do NOT re-run the Release workflow'

echo "watch-release-run.sh (fake gh)"
reset
run_case
expect "a dispatched run that succeeds passes" 0 "the release executor succeeded"
dispatch="$(head -n1 "${WORK}/calls")"
if [[ "$dispatch" == *"actions/workflows/release-exec.yml/dispatches"* && "$dispatch" == *"ref=v1.2.3"* &&
	"$dispatch" == *"inputs[tag]=v1.2.3"* && "$dispatch" == *"inputs[dry_run]=false"* && "$dispatch" == *"return_run_details=true"* ]]; then
	ok "it dispatches release-exec.yml on the tag, as a real run, and asks for the run id"
else
	no "it dispatches release-exec.yml on the tag, as a real run, and asks for the run id" "$dispatch"
fi
if grep -q '^run watch 42 --repo o/r --exit-status' "${WORK}/calls"; then
	ok "it watches the run id the dispatch returned, with --exit-status"
else
	no "it watches the run id the dispatch returned, with --exit-status" "$(cat "${WORK}/calls")"
fi
if grep -qF 'https://github.com/o/r/actions/runs/42' "${WORK}/summary"; then
	ok "it links the run in the job summary"
else
	no "it links the run in the job summary" "$(cat "${WORK}/summary")"
fi

reset
FAKE_WATCH_RCS=1
FAKE_RESULTS="completed failure"
run_case
expect "a dispatched run that fails fails, and says how to retry without cutting a new version" 1 "ended completed failure"
grep -qF -- "$RECOVER" <<<"$LOG" && grep -qF -- "gh workflow run release-exec.yml --ref v1.2.3 -f tag=v1.2.3 -f dry_run=false" <<<"$LOG" && ok "the failure names the retry command" || no "the failure names the retry command" "$LOG"

reset
FAKE_WATCH_RCS=1
FAKE_RESULTS="completed cancelled"
run_case
expect "a dispatched run that is cancelled fails" 1 "ended completed cancelled"

reset
FAKE_WATCH_RCS=0
FAKE_RESULTS="completed failure"
run_case
expect "a failed run fails even when the watch itself exits 0" 1 "watch exit 0"

reset
FAKE_DISPATCH_RC=1
run_case
expect "a dispatch the API refuses fails" 1 "could not dispatch"

reset
FAKE_DISPATCH=""
FAKE_LISTS="|x|42"
run_case
expect "with no id in the answer it finds the run once it appears, through a failed lookup (the race)" 0 "succeeded"
if [ "$(cat "${WORK}/count.lookup")" = 3 ] && grep -q '^run watch 42 ' "${WORK}/calls"; then
	ok "it retried the lookup until the run existed, then watched it"
else
	no "it retried the lookup until the run existed, then watched it" "lookups: $(cat "${WORK}/count.lookup" 2>/dev/null); calls: $(cat "${WORK}/calls")"
fi
lookup="$(grep -m1 -- '--method GET' "${WORK}/calls")"
if [[ "$lookup" == *"event=workflow_dispatch"* && "$lookup" == *"branch=v1.2.3"* && "$lookup" == *"head_sha=${SHA}"* && "$lookup" == *"created=>="* ]]; then
	ok "the lookup filters on event, tag, commit and a created window"
else
	no "the lookup filters on event, tag, commit and a created window" "$lookup"
fi

reset
FAKE_DISPATCH=""
FAKE_LISTS=""
run_case
expect "a run that never appears fails after the retries, without watching anything" 1 "did not appear"
if grep -q '^run watch' "${WORK}/calls"; then no "nothing was watched when no run appeared"; else ok "nothing was watched when no run appeared"; fi

reset
FAKE_DISPATCH=""
FAKE_LISTS="41 42"
run_case
expect "two candidate runs fail rather than watching a guess" 1 "refusing to guess"
grep -qF "First check those runs" <<<"$LOG" && ok "an ambiguous lookup says to check the runs before retrying" || no "an ambiguous lookup says to check the runs before retrying" "$LOG"

reset
FAKE_RUN="$(run_json .github/workflows/release-exec.yml workflow_dispatch '"v1.2.3"' ffffffffffffffffffffffffffffffffffffffff)"
run_case
expect "a run at another commit is refused" 1 "is not the release-exec.yml dispatch"
reset
FAKE_RUN="$(run_json .github/workflows/other.yml workflow_dispatch '"v1.2.3"' "$SHA")"
run_case
expect "a run of another workflow is refused" 1 "is not the release-exec.yml dispatch"
reset
FAKE_RUN="$(run_json .github/workflows/release-exec.yml push '"v1.2.3"' "$SHA")"
run_case
expect "a run from another event is refused" 1 "is not the release-exec.yml dispatch"

reset
FAKE_WATCH_SLEEP=30
WATCH_TIMEOUT_SECONDS=1
start=$SECONDS
run_case
took=$((SECONDS - start))
expect "a run that outlasts the bound fails with a message, instead of hanging" 1 "still running; stopped waiting"
if [ "$took" -lt 10 ]; then ok "it stopped at the bound (${took}s for a 1s bound and a 30s watch)"; else no "it stopped at the bound" "took ${took}s"; fi


reset
FAKE_RUN="$(run_json .github/workflows/release-exec.yml workflow_dispatch null "$SHA")"
run_case
expect "a run with no ref is refused, and the message names the real fields (no shifting)" 1 "ref= sha=${SHA}"

reset
FAKE_RUN=x
run_case
expect "a run that cannot be read fails with an error, not silently" 1 "::error::v1.2.3: could not read run 42"

reset
FAKE_WATCH_RCS="1|0"
FAKE_RESULTS="in_progress|completed success"
run_case
expect "a watch that errors while the run is still going is watched again, and the success counts" 0 "watching again"
if [ "$(grep -c '^run watch' "${WORK}/calls")" = 2 ]; then ok "it watched twice"; else no "it watched twice" "$(cat "${WORK}/calls")"; fi

reset
FAKE_WATCH_RCS="1|1"
FAKE_RESULTS="in_progress|completed failure"
run_case
expect "a watch error then a failed run still fails" 1 "ended completed failure"

reset
FAKE_RESULTS="x|completed success"
run_case
expect "one failed read of the run state is retried" 0 "succeeded"

reset
FAKE_RESULTS="x"
run_case
expect "a run state that can never be read fails after the retries" 1 "could not read the state"

reset
FAKE_WATCH_SLEEP=30
WATCH_TIMEOUT_SECONDS=1
run_case
expect "a timed-out wait says how to retry too" 1 "$RECOVER"

echo
echo "release.yml calls it, bounded below the job clock"
# check_release <file>: one problem per line, nothing when clean.
check_release() {
	# shellcheck disable=SC2016 # JavaScript source, not shell.
	FILE="$1" bun -e '
const doc = Bun.YAML.parse(await Bun.file(process.env.FILE).text());
const out = [];
const job = doc.jobs?.cut;
const steps = job?.steps ?? [];
const runs = steps.map((s) => typeof s.run === "string" ? s.run : "").join("\n");
// Dispatching any other way would return without watching.
if (/\bgh\s+workflow\s+run\b/.test(runs)) out.push("release.yml dispatches with gh workflow run, which does not wait for the run");
const i = steps.findIndex((s) => typeof s.run === "string" && /watch-release-run\.sh/.test(s.run));
if (i < 0) out.push("release.yml never runs .github/scripts/watch-release-run.sh");
else {
  const st = steps[i];
  if (st.if !== undefined) out.push("the watch step has an if: (" + st.if + "), so it can be skipped on its own");
  if (st["continue-on-error"] !== undefined) out.push("the watch step has continue-on-error, so a failed release would not fail release.yml");
  for (const k of ["TAG", "SHA"]) if (!st.env?.[k]) out.push("the watch step is not given " + k);
  const tag = steps.findIndex((s) => typeof s.run === "string" && /refs\/tags\//.test(s.run));
  if (tag < 0 || tag > i) out.push("the watch step runs before the tag exists");
  // The bound must end before the job clock does, or the job is killed
  // with no word of which run it was waiting on.
  const bound = Number(st.env?.WATCH_TIMEOUT_SECONDS);
  const clock = Number(job["timeout-minutes"]) * 60;
  if (!Number.isFinite(bound) || bound <= 0) out.push("the watch step sets no WATCH_TIMEOUT_SECONDS (got " + JSON.stringify(st.env?.WATCH_TIMEOUT_SECONDS) + ")");
  else if (!Number.isFinite(clock)) out.push("the cut job has no timeout-minutes, so the bound cannot be checked against it");
  else if (bound + 600 > clock) out.push("the watch bound (" + bound + "s) leaves under 10 minutes of the job clock (" + clock + "s) for the steps before it");
  else if (clock > 360 * 60) out.push("timeout-minutes " + job["timeout-minutes"] + " is past the 360 GitHub allows a hosted job");
}
// The job now holds the release group for the whole release, so a pending
// run must not be evicted by the next one (the default queue holds one).
if (doc.concurrency?.queue !== "max") out.push("release.yml concurrency must set queue: max (got " + JSON.stringify(doc.concurrency?.queue) + ")");
if (!["write"].includes(doc.permissions?.actions) && !["read", "write"].includes(job?.permissions?.actions))
  out.push("release.yml cannot read runs (no actions permission)");
if (out.length) console.log(out.join("\n"));
'
}
found="$(check_release "$RELEASE")"
if [ -z "$found" ]; then
	ok "release.yml dispatches through the watcher, after tagging, unskippable, bounded inside the job timeout"
else
	no "release.yml dispatches through the watcher" "$found"
fi
# release_caught <label> <exact text> <replacement>
release_caught() {
	local copy="${WORK}/release.yml"
	if ! FROM="$RELEASE" TO="$copy" OLD="$2" NEW="$3" bun -e '
const s = await Bun.file(process.env.FROM).text();
if (s.split(process.env.OLD).length !== 2) { console.error("anchor must occur once"); process.exit(2); }
await Bun.write(process.env.TO, s.replace(process.env.OLD, process.env.NEW));
'; then
		no "mutant '$1' could be applied (release.yml no longer has the text it mutates)"
		return
	fi
	if [ -n "$(check_release "$copy")" ]; then ok "reports: $1"; else no "reports: $1" "the check passed release.yml with this hole"; fi
}
# shellcheck disable=SC2016 # literal workflow text.
{
	release_caught 'the fire-and-forget dispatch back (#683)' \
		'run: .github/scripts/watch-release-run.sh' 'run: gh workflow run release-exec.yml --ref "v${NEW}" -f tag="v${NEW}" -f dry_run=false'
	release_caught 'the watch made skippable (#683)' \
		'      - name: Start the release executor and wait for it' $'      - name: Start the release executor and wait for it\n        continue-on-error: true'
	release_caught 'no job clock to bound the watch against (#683)' \
		'    timeout-minutes: 330' ''
	release_caught 'the watch step given an if: (#683 review)' \
		'      - name: Start the release executor and wait for it' $'      - name: Start the release executor and wait for it\n        if: github.event_name == \'push\''
	release_caught 'the watch run before the tag exists (#683 review)' \
		'      - name: Tag merge commit' $'      - name: Early watch\n        env:\n          TAG: v1\n          SHA: x\n          WATCH_TIMEOUT_SECONDS: "60"\n        run: .github/scripts/watch-release-run.sh\n\n      - name: Tag merge commit'
	release_caught 'a third queued Release silently cancelling the waiting one (#683 review)' \
		'  queue: max' ''
	release_caught 'a watch bound longer than the job clock (#683)' \
		'WATCH_TIMEOUT_SECONDS: "18000"' 'WATCH_TIMEOUT_SECONDS: "21600"'
}

echo
echo "${pass} passed, ${fail} failed"
[ "$fail" -eq 0 ]
