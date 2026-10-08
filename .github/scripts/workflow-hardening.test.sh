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
#      npm publishers pin the same exact npm, and every Dockerfile base image
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
#          | narrow | pushcache
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
  // environment test alone missed installer-release.yml, which has no
  // `release` environment yet compiled in the job that federates into the
  // same KMS signing key as the sidecar. A token is the authority, whatever
  // the environment is called, so holding one puts a workflow on this path.
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
            (npmRuns.test(line) && !(/\s(?:-g|--global)\b/.test(line) && !globalOther(line))))
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
        const next = steps[i + 1];
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
if (rule === "pushcache") {
  // #782: a job that pushes an image to a registry builds it cold. The GHA
  // cache is writable by any run on main and by every job in the same run, so
  // a job that both restores from it and pushes can ship layers nobody built
  // in that job. "Pushes": a build-push or bake step whose push is not false
  // or whose outputs push, a registry login, or a `docker push`,
  // `buildx ... --push` or `imagetools create` command. Every
  // image build in such a job is held to it, dry-run twins included, so a
  // rehearsal builds what the release does.
  for (const [name, job] of Object.entries(jobs)) {
    const steps = flatSteps(job.steps).map((x) => x.st);
    const u = (st) => String(st.uses ?? "").toLowerCase();
    const isBuild = (st) => /^docker\/(build-push-action|bake-action)@/.test(u(st));
    const runs = steps.map((st) => typeof st.run === "string" ? st.run : "").join("\n");
    // `outputs: type=image,...,push=true` (or type=registry) pushes as surely
    // as `push: true` does (#680: build-image pushes by digest that way).
    const pushes = steps.some((st) => isBuild(st) && (String(st.with?.push ?? "false") !== "false" ||
        /(?:^|[,\s])push\s*=\s*(?:true|1|t)\b|(?:^|[,\s])type\s*=\s*registry\b/i.test(String(st.with?.outputs ?? "")))) ||
      steps.some((st) => /^docker\/login-action@/.test(u(st))) ||
      /\bdocker\s+(?:image\s+)?push\b|\bbuildx\s+(?:build|bake)\b[^\n]*--push\b|\bimagetools\s+create\b/.test(runs);
    if (!pushes) continue;
    for (const [i, st] of steps.entries()) {
      const label = name + ": step " + (st.name ?? st.id ?? st.uses ?? String(i));
      if (isBuild(st) && st.with?.["cache-from"] !== undefined)
        out.push(label + " restores cache-from " + JSON.stringify(st.with["cache-from"]) + " in a job that pushes to a registry");
      if (isBuild(st) && /cache-from/.test(JSON.stringify(st.with?.set ?? "")))
        out.push(label + " sets cache-from through bake in a job that pushes to a registry");
      if (typeof st.run === "string" && /--cache-from\b/.test(st.run))
        out.push(label + " runs a build with --cache-from in a job that pushes to a registry");
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
	rm -rf "${WORK}/pins" && mkdir -p "${WORK}/pins" && cp -r "$WORKFLOWS" "${WORK}/pins/workflows" && cp -r "$ACTIONS_DIR" "${WORK}/pins/actions"
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
echo "no job that pushes an image restores it from a cache (#782)"
for f in "$WORKFLOWS"/*.yml; do
	expect_clean "$(basename "$f"): every image a pushing job builds is built cold" pushcache "$f"
done
# shellcheck disable=SC2016 # literal workflow text, not shell.
{
	expect_caught 'the gha cache back on the build that pushes (#782)' pushcache "$WORKFLOWS/release-exec.yml" \
		$'          outputs: type=image,name=ghcr.io/${{ github.repository }},push-by-digest=true,name-canonical=true,push=true\n' \
		$'          outputs: type=image,name=ghcr.io/${{ github.repository }},push-by-digest=true,name-canonical=true,push=true\n          cache-from: type=gha\n' \
		'restores cache-from "type=gha" in a job that pushes'
	expect_caught 'the gha cache back on the dry-run twin in the pushing job (#782)' pushcache "$WORKFLOWS/release-exec.yml" \
		$'          outputs: type=oci,dest=${{ runner.temp }}/release-image.oci.tar\n' \
		$'          outputs: type=oci,dest=${{ runner.temp }}/release-image.oci.tar\n          cache-from: type=registry,ref=ghcr.io/x/y:cache\n' \
		'in a job that pushes'
	expect_caught 'a buildx command line restoring a cache in the pushing job (#782)' pushcache "$WORKFLOWS/release-exec.yml" \
		'      - name: Build the image into an OCI archive (dry run)' $'      - run: docker buildx build --cache-from type=gha --push .\n      - name: Build the image into an OCI archive (dry run)' \
		'runs a build with --cache-from'
	expect_caught 'the push step spelled in another case, with its cache back (#782)' pushcache "$WORKFLOWS/release-exec.yml" \
		$'        uses: docker/build-push-action@c3c9e263c25d99ce0380d002d59b67737d91b0dc # v7.4.0\n        with:\n          context: .\n' \
		$'        uses: Docker/build-push-action@c3c9e263c25d99ce0380d002d59b67737d91b0dc # v7.4.0\n        with:\n          cache-from: type=gha\n          context: .\n' \
		'restores cache-from'
}
# A build that pushes through `outputs:` (push=true, as build-image does since
# #680) is a push whether or not the job also logs in: with the login removed,
# the cache coming back must still be reported. (This replaces a check that
# the validate-only build-docker job could keep its cache: #680 removed that
# job, and nothing in release-exec.yml uses the cache now.)
copy="${WORK}/pushcache-nologin.yml"
# shellcheck disable=SC2016 # JavaScript source, not shell.
if FROM="$WORKFLOWS/release-exec.yml" TO="$copy" bun -e '
const s = await Bun.file(process.env.FROM).text();
const re = /      # Only when something will be pushed \(#682\): a dry run has no use for\n      # a registry credential on disk\.\n      - name: Log in to GitHub Container Registry\n(?:        .*\n|          .*\n)+?(?=\n)/;
if (!re.test(s)) process.exit(2);
await Bun.write(process.env.TO, s.replace(re, ""));
'; then
	if grep -q 'docker/login-action' <(sed -n '/^  build-image:/,/^  smoke-image:/p' "$copy"); then
		no "the build-image login could be removed from the copy"
	else
		# shellcheck disable=SC2016 # literal workflow text, not shell.
		expect_caught 'the gha cache back on a build that pushes only through outputs push=true (#680)' pushcache "$copy" \
			$'          outputs: type=image,name=ghcr.io/${{ github.repository }},push-by-digest=true,name-canonical=true,push=true\n' \
			$'          outputs: type=image,name=ghcr.io/${{ github.repository }},push-by-digest=true,name-canonical=true,push=true\n          cache-from: type=gha\n' \
			'restores cache-from "type=gha" in a job that pushes'
		# BuildKit parses the value as a Go bool: 1 and t push too (#680 review).
		expect_caught 'the gha cache back on a build that pushes through outputs push=1 (#680 review)' pushcache "$copy" \
			$'          outputs: type=image,name=ghcr.io/${{ github.repository }},push-by-digest=true,name-canonical=true,push=true\n' \
			$'          outputs: type=image,name=ghcr.io/${{ github.repository }},push-by-digest=true,name-canonical=true,push=1\n          cache-from: type=gha\n' \
			'restores cache-from "type=gha" in a job that pushes'
	fi
else
	no "mutant 'build-image without its login' could be applied (the workflow no longer has the text it mutates)"
fi

echo
echo "the catalog sync processes third-party data without write access"
expect_clean "sync-pieces-catalog.yml: no job that installs dependencies or runs the generator holds a write scope; installs are frozen" \
	untrusted "$WORKFLOWS/sync-pieces-catalog.yml"

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
		$'          GCP_KMS_KEYRING: ${{ vars.GCP_KMS_KEYRING }}\n        run: |\n' \
		$'          GCP_KMS_KEYRING: ${{ vars.GCP_KMS_KEYRING }}\n          URL: ${{ env.ACTIONS_RESULTS_URL }}\n        run: |\n' \
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
		$'      - name: Verify sidecar binaries\n        if: needs.sidecar.outputs.released == \'true\'' $'      - name: Verify sidecar binaries\n        if: false' \
		'is checked under a different condition'
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

echo
echo "${pass} passed, ${fail} failed"
[ "$fail" -eq 0 ]
