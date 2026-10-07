#!/usr/bin/env bash
# Dispatch release-exec.yml for a tag and wait for THAT run to finish, failing
# unless it succeeded (#683). Called by release.yml after it has tagged.
#
# Before this, release.yml dispatched and exited green, so a failed or
# cancelled release left a merged bump and a pushed tag with nothing
# published, and nothing went red.
#
# Finding the run. The dispatch API returns the new run id when asked
# (`return_run_details: true`, answered with 200 and `workflow_run_id`).
# If the answer carries no id (an older API answering 204 with no body), it
# falls back to a lookup: workflow_dispatch runs of this workflow on the
# tag, at the tagged commit, created since just before the dispatch, retried
# while the run has not been created yet. More than one match fails rather
# than watching a guess. Either way the run is checked to be that workflow,
# that event, that ref and that commit before it is watched.
#
# Waiting. `gh run watch --exit-status`, bounded by WATCH_TIMEOUT_SECONDS so
# the step fails with a message naming the run instead of the job running out
# its clock. The run state is then read back: still running (the watch hit a
# network or API error) means watch again for the time left; finished means
# it must be `success`, so the result does not rest on the watch exit code.
#
# Every failure after the tag exists says how to recover. Re-running the
# Release workflow is the wrong move: it would bump and tag the NEXT version.
#
# Inputs (environment): TAG, SHA, GITHUB_REPOSITORY, GH_TOKEN (for gh).
# Tunables, defaults for release.yml: WORKFLOW_FILE (release-exec.yml),
# WATCH_TIMEOUT_SECONDS (18000), WATCH_INTERVAL (60), LOOKUP_ATTEMPTS (20),
# LOOKUP_INTERVAL (6), READ_ATTEMPTS (10, consecutive failed reads of the
# run state before giving up).
set -euo pipefail
export LC_ALL=C
: "${TAG:?}" "${SHA:?}" "${GITHUB_REPOSITORY:?}"
WORKFLOW_FILE="${WORKFLOW_FILE:-release-exec.yml}"
WATCH_TIMEOUT_SECONDS="${WATCH_TIMEOUT_SECONDS:-18000}"
WATCH_INTERVAL="${WATCH_INTERVAL:-60}"
LOOKUP_ATTEMPTS="${LOOKUP_ATTEMPTS:-20}"
LOOKUP_INTERVAL="${LOOKUP_INTERVAL:-6}"
READ_ATTEMPTS="${READ_ATTEMPTS:-10}"
REPO="$GITHUB_REPOSITORY"
url=""

summary() {
	if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then printf '%s\n' "$1" >>"$GITHUB_STEP_SUMMARY"; fi
}
# fail <message> [first]: the error, then how to recover. The tag and the
# merged bump already exist whenever this runs. [first] is what to do before
# retrying, when the release may in fact still be running.
fail() {
	echo "::error::${TAG}: $1"
	local how="Do NOT re-run the Release workflow: it would bump and tag the next version. ${2:+$2 }Retry this release with: gh workflow run ${WORKFLOW_FILE} --ref ${TAG} -f tag=${TAG} -f dry_run=false"
	echo "$how"
	summary "**Release executor for \`${TAG}\` did not succeed:** $1"
	summary ""
	summary "$how"
	exit 1
}

# A minute of slack for clock skew between this runner and GitHub. The other
# filters (event, ref, commit) are what keep an older run out.
since="$(date -u -d '-60 seconds' +%Y-%m-%dT%H:%M:%SZ)"

if ! resp="$(gh api --method POST "repos/${REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches" \
	-f ref="$TAG" -f "inputs[tag]=$TAG" -f "inputs[dry_run]=false" -F return_run_details=true)"; then
	fail "could not dispatch ${WORKFLOW_FILE}"
fi
id="$(printf '%s' "$resp" | jq -r '.workflow_run_id // empty' 2>/dev/null || true)"

if [ -z "$id" ]; then
	echo "The dispatch did not return a run id; looking the run up."
	for attempt in $(seq 1 "$LOOKUP_ATTEMPTS"); do
		# A failed call counts as "not there yet": the loop exists to retry.
		ids="$(gh api --method GET "repos/${REPO}/actions/workflows/${WORKFLOW_FILE}/runs" \
			-f event=workflow_dispatch -f branch="$TAG" -f head_sha="$SHA" -f created=">=${since}" \
			--jq '[.workflow_runs[].id] | map(tostring) | join(" ")')" || {
			echo "::warning::looking up the run failed (attempt ${attempt}/${LOOKUP_ATTEMPTS}); retrying"
			ids=""
		}
		read -r -a found <<<"$ids"
		if [ "${#found[@]}" -gt 1 ]; then
			fail "${#found[@]} ${WORKFLOW_FILE} runs were dispatched for it since ${since} (${ids}); refusing to guess which one this release started" \
				"First check those runs: one of them may be this release, still going, and a retry would queue a duplicate."
		fi
		if [ "${#found[@]}" -eq 1 ]; then
			id="${found[0]}"
			break
		fi
		echo "No ${WORKFLOW_FILE} run for ${TAG} yet (attempt ${attempt}/${LOOKUP_ATTEMPTS})."
		sleep "$LOOKUP_INTERVAL"
	done
fi
if ! [[ "$id" =~ ^[0-9]+$ ]]; then
	fail "the ${WORKFLOW_FILE} run dispatched for it did not appear"
fi

# The run must be the one asked for, whichever way its id was found. Fields
# are joined with US (0x1f), not a tab: tab is whitespace to `read`, so an
# empty field would shift every later one.
got="$(gh api "repos/${REPO}/actions/runs/${id}" \
	--jq '[.path, .event, .head_branch, .head_sha, .html_url] | map(. // "" | tostring) | join("\u001f")')" ||
	fail "could not read run ${id}"
IFS=$'\x1f' read -r path event branch head url <<<"$got"
if [ "$path" != ".github/workflows/${WORKFLOW_FILE}" ] || [ "$event" != "workflow_dispatch" ] ||
	[ "$branch" != "$TAG" ] || [ "$head" != "$SHA" ]; then
	fail "run ${id} is not the ${WORKFLOW_FILE} dispatch for it at ${SHA} (got path=${path} event=${event} ref=${branch} sha=${head})"
fi
echo "Watching ${url}"
summary "Release executor for \`${TAG}\`: ${url}"

deadline=$((SECONDS + WATCH_TIMEOUT_SECONDS))
misses=0
while :; do
	left=$((deadline - SECONDS))
	if [ "$left" -le 0 ]; then
		fail "the release executor had not finished after ${WATCH_TIMEOUT_SECONDS}s and is still running; stopped waiting (it may still succeed): ${url}"
	fi
	rc=0
	timeout "$left" gh run watch "$id" --repo "$REPO" --exit-status --interval "$WATCH_INTERVAL" || rc=$?
	if [ "$rc" -eq 124 ]; then
		fail "the release executor had not finished after ${WATCH_TIMEOUT_SECONDS}s and is still running; stopped waiting (it may still succeed): ${url}"
	fi
	if ! result="$(gh run view "$id" --repo "$REPO" --json status,conclusion --jq '.status + " " + (.conclusion // "")')"; then
		misses=$((misses + 1))
		[ "$misses" -lt "$READ_ATTEMPTS" ] || fail "could not read the state of ${url} ${misses} times in a row"
		echo "::warning::could not read the run state (${misses}/${READ_ATTEMPTS}); trying again"
		sleep "$WATCH_INTERVAL"
		continue
	fi
	misses=0
	[ "${result%% *}" = "completed" ] && break
	# The watch ended while the run did not: a network or API error, not a
	# verdict. Watch again for whatever time is left.
	echo "::warning::gh run watch exited ${rc} while the run is ${result% }; watching again"
	sleep "$WATCH_INTERVAL"
done
if [ "$result" != "completed success" ]; then
	fail "the release executor ended ${result} (watch exit ${rc}); the tag exists and the bump is merged, but the release did not complete: ${url}"
fi
echo "${TAG}: the release executor succeeded (${url})"
summary "Release executor succeeded."
