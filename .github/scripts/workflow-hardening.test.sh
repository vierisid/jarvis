#!/usr/bin/env bash
# Workflow token and supply-chain hardening checks (#646). Needs bash and bun.
#
#   1. Every job's GITHUB_TOKEN scope is written down: each workflow either
#      declares a top-level `permissions:` or gives every job its own. A job
#      with neither inherits the REPOSITORY default, which is a setting outside
#      this tree -- read-only today (the run logs show Contents/Metadata/
#      Packages: read), but one toggle away from write on every PR run of code
#      the PR itself supplies.
#   2. The publish path holds nothing by default: release-exec.yml declares
#      `permissions: {}` at the top and every job asks for exactly what it
#      uses, so a new job starts with no token rather than inheriting write.
#   3. Every `uses:` in a workflow that holds AUTHORITY names a full 40-hex
#      commit SHA (or a local ./ path). A tag is mutable: whoever controls the
#      action's repo can move it, and the next run executes whatever it points
#      at with that workflow's token. "Authority" is derived, not listed: any
#      write scope or `id-token: write` (top level or any job), `write-all`,
#      or a `pull_request_target` trigger. A fixed list of "the publish path"
#      missed release.yml and sync-pieces-catalog.yml, whose tokens can create
#      a v* tag and dispatch a real release, and installer-release.yml, which
#      signs and publishes installers.
#
# Each rule is also run against a mutated copy that breaks it, and must report
# it, so a neutered check fails here instead of passing everything.
#
# Run from anywhere:  .github/scripts/workflow-hardening.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKFLOWS="${WORKFLOW_DIR:-${HERE}/../workflows}"

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
WORK="$(mktemp -d)" || exit 1
trap 'rm -rf "$WORK"' EXIT

# check <rule> <file>: one violation per line, nothing when clean.
#   rule = scoped | publish-perms | pinned | authority
check() {
	RULE="$1" FILE="$2" bun -e '
const doc = Bun.YAML.parse(await Bun.file(process.env.FILE).text());
const jobs = doc.jobs ?? {};
const out = [];
const rule = process.env.RULE;
if (rule === "scoped" && doc.permissions === undefined)
  for (const [name, job] of Object.entries(jobs))
    if (job.permissions === undefined)
      out.push(name + ": no permissions of its own and none at the top level, so it inherits the repository default");
if (rule === "publish-perms") {
  const top = doc.permissions;
  if (!(top && typeof top === "object" && Object.keys(top).length === 0))
    out.push("top-level permissions must be {} (got " + JSON.stringify(top) + ")");
  for (const [name, job] of Object.entries(jobs))
    if (job.permissions === undefined) out.push(name + ": declares no permissions of its own");
}
if (rule === "authority") {
  // Prints "yes" when the workflow holds authority (see header), else nothing.
  const grants = (perm) => perm === "write-all" ||
    (perm && typeof perm === "object" && Object.values(perm).some((v) => v === "write"));
  const on = doc.on ?? doc[true] ?? {};
  const triggers = typeof on === "string" ? [on] : Array.isArray(on) ? on : Object.keys(on);
  if (grants(doc.permissions) || Object.values(jobs).some((j) => grants(j.permissions)) ||
      triggers.includes("pull_request_target"))
    out.push("yes");
}
if (rule === "pinned") {
  const uses = [];
  for (const [name, job] of Object.entries(jobs)) {
    if (typeof job.uses === "string") uses.push([name, job.uses]);
    for (const s of job.steps ?? []) if (typeof s.uses === "string") uses.push([name, s.uses]);
  }
  for (const [name, u] of uses)
    if (!u.startsWith("./") && !/^[^@\s]+@[0-9a-f]{40}$/.test(u))
      out.push(name + ": uses " + u + " (not a full commit SHA)");
}
if (out.length) console.log(out.join("\n"));
'
}

# expect_clean <label> <rule> <file>
expect_clean() {
	local found
	found="$(check "$2" "$3")" || {
		no "$1" "the bun helper failed"
		return
	}
	if [ -z "$found" ]; then ok "$1"; else no "$1" "$found"; fi
}

# expect_caught <label> <rule> <file> <exact text> <replacement>
expect_caught() {
	local copy="${WORK}/mutant.yml"
	if ! FROM="$3" TO="$copy" OLD="$4" NEW="$5" bun -e '
const s = await Bun.file(process.env.FROM).text();
const n = s.split(process.env.OLD).length - 1;
if (n < 1) { console.error("anchor not found"); process.exit(2); }
await Bun.write(process.env.TO, s.replace(process.env.OLD, process.env.NEW));
'; then
		no "mutant '$1' could be applied (the workflow no longer has the text it mutates)"
		return
	fi
	if [ -n "$(check "$2" "$copy")" ]; then
		ok "reports: $1"
	else
		no "reports: $1" "the check passed a workflow with this hole"
	fi
}

echo "every job's token scope is explicit"
for f in "$WORKFLOWS"/*.yml; do
	expect_clean "$(basename "$f")" scoped "$f"
done

echo
echo "the publish path holds nothing by default"
expect_clean "release-exec.yml: permissions {} at the top, every job explicit" publish-perms "$WORKFLOWS/release-exec.yml"

echo
echo "every action in a workflow that holds authority is pinned to a commit"
held=0
for f in "$WORKFLOWS"/*.yml; do
	auth="$(check authority "$f")" || {
		no "$(basename "$f"): authority check ran" "the bun helper failed"
		continue
	}
	[ -n "$auth" ] || continue
	held=$((held + 1))
	expect_clean "$(basename "$f")" pinned "$f"
done
# release-exec.yml alone holds id-token + packages: write; if the derivation
# found nothing, the derivation is broken, not the repository clean.
if grep -q 'release-exec.yml' < <(for f in "$WORKFLOWS"/*.yml; do [ -n "$(check authority "$f")" ] && basename "$f"; done); then
	ok "the authority derivation finds release-exec.yml (${held} workflow(s) hold authority)"
else
	no "the authority derivation finds release-exec.yml"
fi

echo
echo "each rule reports the hole it exists for (mutated copies)"
expect_caught 'a workflow and job with no permissions anywhere' scoped "$WORKFLOWS/test.yml" \
	$'permissions:\n  contents: read\n' ''
expect_caught 'a publish job with no permissions of its own' publish-perms "$WORKFLOWS/release-exec.yml" \
	$'  discord-notify:\n    needs: [validate-tag, github-release]\n    if: ${{ !inputs.dry_run }}\n    runs-on: ubuntu-latest\n    permissions:\n      contents: read\n' \
	$'  discord-notify:\n    needs: [validate-tag, github-release]\n    if: ${{ !inputs.dry_run }}\n    runs-on: ubuntu-latest\n'
expect_caught 'write scopes back at the top of the publish path' publish-perms "$WORKFLOWS/release-exec.yml" \
	$'permissions: {}\n' $'permissions:\n  contents: write\n'
expect_caught 'a major tag on the publish path' pinned "$WORKFLOWS/release-exec.yml" \
	'uses: softprops/action-gh-release@' 'uses: softprops/action-gh-release@v2 #'
# A read-only workflow gaining a write scope must come under the pin rule:
# test.yml still uses tags, so granting it write has to surface them.
copy="${WORK}/authority.yml"
FROM="$WORKFLOWS/test.yml" TO="$copy" bun -e '
const s = await Bun.file(process.env.FROM).text();
await Bun.write(process.env.TO, s.replace("permissions:\n  contents: read\n", "permissions:\n  contents: write\n"));
'
if [ -n "$(check authority "$copy")" ] && [ -n "$(check pinned "$copy")" ]; then
	ok "reports: a read-only workflow that gains a write scope while using tags"
else
	no "reports: a read-only workflow that gains a write scope while using tags"
fi
expect_caught 'a major tag in a pull_request_target workflow' pinned "$WORKFLOWS/labeler.yml" \
	'uses: actions/labeler@bf12e9b00b37c5c0ca2b87b79b2daf7891dbda13' 'uses: actions/labeler@v5'
expect_caught 'a short SHA on the publish path' pinned "$WORKFLOWS/sidecar-release.yml" \
	'uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1' 'uses: actions/checkout@3d3c42e'

echo
echo "${pass} passed, ${fail} failed"
[ "$fail" -eq 0 ]
