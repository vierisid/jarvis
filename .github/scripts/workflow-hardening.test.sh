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
#      restored from the Actions cache (writable by any run on main). Both
#      npm publishers pin the same exact npm. Not checked: Dockerfile base
#      images, and setup-node's node-version major (runner tool cache).
#   6. Per-job authority (#682): no matrix job holds id-token (every leg would
#      get it); no `secrets: inherit`, and a local reusable workflow is passed
#      exactly the secrets it declares, which are exactly the ones it reads; a
#      job that runs `npm publish` with id-token runs no Bun and no dependency
#      install or build; on the release path no checkout leaves its token in
#      the repository config; and no registry login happens on a dry run.
#   7. (#687) "Authority" also counts any use of the `secrets` context other
#      than secrets.GITHUB_TOKEN (including toJSON(secrets)), and `secrets:
#      inherit`; and every rule that reads steps descends into local
#      composite actions (./.github/actions/*), recursively, with the caller
#      inputs substituted. A local action that cannot be read, is not
#      composite, or nests too deep is reported rather than skipped. Rule 5
#      also refuses actions/cache restores where authority is held.
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
  for (const [name, job] of Object.entries(jobs)) {
    const perm = job.permissions ?? doc.permissions;
    const held = writes(perm);
    // Local composite actions are part of the job (#687): flatSteps expands
    // them, recursively, with inputs substituted.
    for (const [i, { st: s, via: path }] of flatSteps(job.steps).entries()) {
      const label = name + ": step " + (s.name ?? s.id ?? s.uses ?? String(i));
      const run = typeof s.run === "string" ? s.run : "";
      const via = path ? " (inside " + path.slice(0, -3) + ")" : "";
      for (const [t, bare] of lines(run)) {
        if (held && install.test(bare)) out.push(label + via + ": installs dependencies in a job holding " + JSON.stringify(perm) + ": " + t);
        if (held && thirdParty.test(bare)) out.push(label + via + ": processes third-party data in a job holding " + JSON.stringify(perm) + ": " + t);
        if (bunInstall.test(bare) && !frozen.test(bare)) out.push(label + via + ": bun install without --frozen-lockfile: " + t);
      }
    }
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
          const g = /\b(?:npm|pnpm)\s+(?:install|i|add)\b(.*)$/.exec(line);
          if (g && /(?:^|\s)(?:-g|--global)\b/.test(g[1]))
            for (const tok of g[1].split(/\s+/).filter((x) => x && !x.startsWith("-"))) {
              const at = tok.lastIndexOf("@");
              if (at <= 0 || !exactVersion.test(tok.slice(at + 1)))
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
  const release = Object.values(jobs).some((j) => (j.environment?.name ?? j.environment) === "release");
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
    const cmd = (w) => new RegExp("(?:^|[;&|(!`]\\s*|\\$\\(\\s*|\\b(?:then|do|else|if|elif|while|until)\\s+)" +
      "(?:(?:sudo|env|exec|time|command|nice|nohup|xargs)\\s+(?:-\\S+\\s+)*|timeout\\s+(?:-\\S+\\s+)*\\S+\\s+|[A-Za-z_][A-Za-z0-9_]*=\\S*\\s+)*(?:\\S*/)?" + w);
    // Comments: a # at line start or after whitespace, outside ${#...}.
    const lines = runs.split("\n").map((l) => l.replace(/(^|\s)#(?!\{).*$/, "$1").trim());
    // npm verbs that run package or repository code, and any global install
    // that is not npm itself pinned to NPM_VERSION.
    const npmRuns = cmd("npm\\s+(?:ci|install|i|add|isntall|in|it|install-test|install-ci-test|run|run-script|rum|urn|exec|x|pack|rebuild|rb|test|t|tst|start|restart|stop|update|up|upgrade|dedupe|link|ln|explore)\\b");
    const globalOther = (line) => /\bnpm\s+(?:install|i|add)\b/.test(line) && /\s(?:-g|--global)\b/.test(line) &&
      line.replace(/\s(?:-g|--global)\b/, "").replace(/^.*?\bnpm\s+(?:install|i|add)\s+/, "").trim() !== "\"npm@${NPM_VERSION}\"";
    if (oidc && /\bnpm\s+publish\b/.test(runs)) {
      if (steps.some((st) => String(st.uses ?? "").startsWith("oven-sh/setup-bun@")))
        out.push(name + ": publishes with id-token and installs Bun");
      for (const st of steps)
        if (st.shell !== undefined && !/^(bash|sh)\b/.test(String(st.shell)))
          out.push(name + ": step with shell: " + st.shell + " in a job that publishes with id-token");
      for (const line of lines)
        if (cmd("(?:bun|bunx|npx|yarn|pnpm|node|make|python3?|perl|ruby|deno|go)\\b").test(line) ||
            (npmRuns.test(line) && !(/\s(?:-g|--global)\b/.test(line) && !globalOther(line))) || globalOther(line))
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
    // On the release path a job that can mint a token builds nothing: the
    // compiler, the module graph and dependency scripts run in a job without
    // id-token, and the result crosses with its digest.
    if (release && oidc) {
      for (const line of lines)
        if (cmd("go\\s+(?:build|install|generate|run|test|vet|mod|get)\\b").test(line) || /build-sidecar\.sh/.test(line) ||
            cmd("(?:bun|bunx|npx|yarn|pnpm|make|swiftc|swift|xcodebuild|clang|gcc|cc|cargo|cmake)\\b").test(line) ||
            (npmRuns.test(line) && !(/\s(?:-g|--global)\b/.test(line) && !globalOther(line))))
          out.push(name + ": builds in a job holding id-token: " + line);
      for (const st of steps)
        if (String(st.uses ?? "").startsWith("./"))
          out.push(name + ": runs local action " + st.uses + " in a job holding id-token");
    }
    // google-github-actions/auth writes a credentials file by default that
    // can mint further tokens; on the release path only access_token is used.
    if (release)
      for (const st of steps)
        if (String(st.uses ?? "").startsWith("google-github-actions/auth@") && st.with?.create_credentials_file !== false)
          out.push(name + ": google-github-actions/auth leaves a credentials file in the workspace (create_credentials_file is not false)");
    if (release)
      for (const st of steps)
        if (String(st.uses ?? "").startsWith("actions/checkout@") && st.with?.["persist-credentials"] !== false)
          out.push(name + ": checkout leaves the token in .git/config (persist-credentials is not false)");
    for (const st of steps)
      if (String(st.uses ?? "").startsWith("docker/login-action@") && "dry_run" in ((doc.on ?? doc[true] ?? {}).workflow_dispatch?.inputs ?? {}) &&
          !/env\.DRY_RUN\s*!=\s*.true./.test(String(st.if ?? "")))
        out.push(name + ": logs in to a registry on a dry run");
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
	expect_clean "$(basename "$f"): no id-token matrix, no inherited secrets, OIDC publish jobs run no build, no persisted credentials" narrow "$f"
done

echo
echo "the catalog sync processes third-party data without write access"
expect_clean "sync-pieces-catalog.yml: no job that installs dependencies or runs the generator holds a write scope; installs are frozen" \
	untrusted "$WORKFLOWS/sync-pieces-catalog.yml"

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
		'  BUN_VERSION: "1.3.14"' '  BUN_VERSION: latest'
	expect_caught 'a floating Bun in the job that can tag a release' mutable "$WORKFLOWS/release.yml" \
		'bun-version: "1.3.14"' 'bun-version: latest'
	expect_caught 'the binfmt image back to its :latest default' mutable "$WORKFLOWS/release-exec.yml" \
		$'          image: ${{ env.BINFMT_IMAGE }}\n' ''
	expect_caught 'the privileged binfmt image restored from the Actions cache' mutable "$WORKFLOWS/release-exec.yml" \
		'          cache-image: false' '          cache-image: true'
	expect_caught 'BuildKit by tag instead of digest' mutable "$WORKFLOWS/release-exec.yml" \
		'BUILDKIT_IMAGE: moby/buildkit:v0.33.1@sha256:' 'BUILDKIT_IMAGE: moby/buildkit:buildx-stable-1 #'
	expect_caught 'BuildKit back to its default image' mutable "$WORKFLOWS/release-exec.yml" \
		$'        with:\n          driver-opts: image=${{ env.BUILDKIT_IMAGE }}\n' ''
	expect_caught 'a global npm install with no version' mutable "$WORKFLOWS/sidecar-release.yml" \
		'npm install -g "npm@${NPM_VERSION}"' 'npm install -g npm'
	expect_caught 'a global npm install of a range' mutable "$WORKFLOWS/sidecar-release.yml" \
		'npm install -g "npm@${NPM_VERSION}"' 'npm i -g npm@^12'
	expect_caught 'the npm pin itself loosened to a major' mutable "$WORKFLOWS/sidecar-release.yml" \
		'  NPM_VERSION: "12.1.0"' '  NPM_VERSION: "12"'
	expect_caught 'a Bun range in the job that can tag a release' mutable "$WORKFLOWS/release.yml" \
		'bun-version: "1.3.14"' 'bun-version: "1.x"'
	expect_caught 'a download piped into a shell' mutable "$WORKFLOWS/release.yml" \
		'      - name: Compute new version' $'      - run: curl -fsSL https://bun.sh/install | bash\n      - name: Compute new version'
	expect_caught 'Bun taken from a version file' mutable "$WORKFLOWS/release.yml" \
		'bun-version: "1.3.14"' 'bun-version-file: package.json'
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
	expect_caught 'id-token back on the four-leg sidecar matrix' narrow "$WORKFLOWS/sidecar-release.yml" \
		$'    permissions:\n      contents: read\n    env:\n      # secrets can' $'    permissions:\n      contents: read\n      id-token: write\n    env:\n      # secrets can'
	expect_caught 'the brain build back in the job that holds id-token' narrow "$WORKFLOWS/release-exec.yml" \
		'      - name: Verify the tarball' $'      - run: bun run prepublishOnly\n      - name: Verify the tarball'
	expect_caught 'a token left in .git/config by the release job' narrow "$WORKFLOWS/release-exec.yml" \
		$'          fetch-depth: 0\n          persist-credentials: false\n' $'          fetch-depth: 0\n'
	expect_caught 'no secrets passed to the sidecar call at all (signing would silently skip)' narrow "$WORKFLOWS/release-exec.yml" \
		$'    secrets:\n      APPLE_CERT_P12: ${{ secrets.APPLE_CERT_P12 }}\n      APPLE_CERT_PASSWORD: ${{ secrets.APPLE_CERT_PASSWORD }}\n      ASC_KEY_ID: ${{ secrets.ASC_KEY_ID }}\n      ASC_ISSUER_ID: ${{ secrets.ASC_ISSUER_ID }}\n      ASC_API_KEY_P8: ${{ secrets.ASC_API_KEY_P8 }}\n' ''
	expect_caught 'a checkout back in the npm publish job' narrow "$WORKFLOWS/release-exec.yml" \
		'      - name: Verify the tarball' $'      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n        with:\n          persist-credentials: false\n      - name: Verify the tarball'
	expect_caught 'a directory npm publish (runs lifecycle scripts)' narrow "$WORKFLOWS/release-exec.yml" \
		'npm publish "${RUNNER_TEMP}/brain-pack/${TARBALL}" --access public' 'npm publish --access public'
	expect_caught 'the digest check removed before the publish' narrow "$WORKFLOWS/release-exec.yml" \
		'| sha256sum -c -' '| cat'
	expect_caught 'another global package installed in the npm publish job' narrow "$WORKFLOWS/release-exec.yml" \
		'      - name: Verify the tarball' $'      - run: npm install -g evil@1.0.0\n      - name: Verify the tarball'
	expect_caught 'a node script run in the npm publish job' narrow "$WORKFLOWS/release-exec.yml" \
		'      - name: Verify the tarball' $'      - run: node scripts/x.js\n      - name: Verify the tarball'
	expect_caught 'the Windows build back in the job that signs with id-token' narrow "$WORKFLOWS/sidecar-release.yml" \
		'      - name: Install osslsigncode' $'      - run: ../.github/scripts/build-sidecar.sh\n      - name: Install osslsigncode'
	expect_caught 'a global install with the flag after the package' narrow "$WORKFLOWS/release-exec.yml" \
		'      - name: Verify the tarball' $'      - run: npm install evil@1.0.0 -g\n      - name: Verify the tarball'
	expect_caught 'npm test in the npm publish job' narrow "$WORKFLOWS/release-exec.yml" \
		'      - name: Verify the tarball' $'      - run: npm test\n      - name: Verify the tarball'
	expect_caught 'a command behind sudo in the npm publish job' narrow "$WORKFLOWS/release-exec.yml" \
		'      - name: Verify the tarball' $'      - run: sudo node x.js\n      - name: Verify the tarball'
	expect_caught 'a non-shell step in the npm publish job' narrow "$WORKFLOWS/release-exec.yml" \
		'      - name: Verify the tarball' $'      - shell: node {0}\n        run: console.log(1)\n      - name: Verify the tarball'
	expect_caught 'go test in the job that signs with id-token' narrow "$WORKFLOWS/sidecar-release.yml" \
		'      - name: Install osslsigncode' $'      - run: go test ./...\n      - name: Install osslsigncode'
	expect_caught 'a local action in the job that signs with id-token' narrow "$WORKFLOWS/sidecar-release.yml" \
		'      - name: Install osslsigncode' $'      - uses: ./.github/actions/bun-setup\n      - name: Install osslsigncode'
	expect_caught 'the Google credentials file left in the workspace' narrow "$WORKFLOWS/sidecar-release.yml" \
		$'          create_credentials_file: false\n' ''
	expect_caught 'node behind an if, in the npm publish job' narrow "$WORKFLOWS/release-exec.yml" \
		'      - name: Verify the tarball' $'      - run: if node x.js; then true; fi\n      - name: Verify the tarball'
	expect_caught 'node behind an assignment and a path, in the npm publish job' narrow "$WORKFLOWS/release-exec.yml" \
		'      - name: Verify the tarball' $'      - run: X=1 /usr/bin/node evil.js\n      - name: Verify the tarball'
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

echo
echo "${pass} passed, ${fail} failed"
[ "$fail" -eq 0 ]
