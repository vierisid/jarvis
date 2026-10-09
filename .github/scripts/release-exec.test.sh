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
#   Plus (#685) the dry-run decision in release-exec.yml and
#   sidecar-release.yml: each site that makes it is evaluated under a tag
#   push, a real dispatch and a dry dispatch, and they must agree.
#   Plus (#781, #779) the artifact handoffs into the jobs that sign and
#   publish: sidecar-release.yml publish-sidecar, and installer-release.yml
#   sign-windows and publish. Each check is executed verbatim against
#   tampered, extra, missing and undigested fixtures.
#   Plus (#680, #868) the image path: one build in build-image, into an OCI
#   archive, by a job with no registry scope; smoke-image loading and
#   running exactly that archive and rehearsing its push on a loopback
#   registry; publish-docker, the only job holding packages: write, pushing
#   it by digest and tagging it after the approval chain, by the very script
#   the rehearsal runs. The push script and the archive load are executed
#   verbatim against docker and skopeo stubs, with tampered, wrong and
#   missing inputs.
#   Plus (#817) post-sign verification in a job without id-token, on the
#   digest that ships, gating the publish.
#   Plus (#684, #818) the version gates of sidecar-release.yml and
#   installer-release.yml, executed verbatim against hostile VERSION files,
#   and no ${{ }} inside any run: of either workflow.
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
if (mode === "dry-run") {
  // #685: one dry-run decision. Every place that must make it (DRY_RUN, and
  // where `env` is not available: the sidecar call input, discord-notify,
  // the environment names) spells it `inputs.dry_run == true`, each is
  // EVALUATED under every way the workflow starts, and they must agree. No
  // other expression reads dry_run, nothing redefines DRY_RUN, and every
  // consumer compares DRY_RUN with true and nothing else (a bare
  // `if: env.DRY_RUN` is the string "false", which is truthy).
  const out = [];
  const file = require("node:path").basename(process.env.WORKFLOW);
  const ENV_NAME = "${{ inputs.dry_run == true && \x27release-dry-run\x27 || \x27release\x27 }}";
  const FLAG = "${{ inputs.dry_run == true }}";
  // [description, getter, canonical text, kind]
  const sites = [["env.DRY_RUN", (d) => d.env?.DRY_RUN, FLAG, "env"]];
  if (file === "release-exec.yml") sites.push(
    ["jobs.sidecar.with.dry_run", (d) => d.jobs?.sidecar?.with?.dry_run, FLAG, "flag"],
    ["jobs.discord-notify.if", (d) => d.jobs?.["discord-notify"]?.if, "${{ inputs.dry_run != true }}", "notify"],
    ["jobs.publish-brain.environment.name", (d) => d.jobs?.["publish-brain"]?.environment?.name, ENV_NAME, "environment"]);
  else if (file === "sidecar-release.yml") sites.push(
    ["jobs.publish-sidecar.environment.name", (d) => d.jobs?.["publish-sidecar"]?.environment?.name, ENV_NAME, "environment"]);
  // #869: the installer readiness step reads DRY_RUN. Its one site is
  // env.DRY_RUN itself, already in sites; this branch only keeps the file
  // from being reported as unknown, so the spelling and no-redefinition
  // rules below apply to it.
  else if (file === "installer-release.yml") {}
  else out.push("no dry-run sites are known for " + file);
  // A small evaluator for the GitHub expression subset these use: literals,
  // inputs.dry_run, ! == != && || and parentheses, with GitHub loose
  // equality (different types compare as numbers, so null == false is true)
  // and its truthiness. Anything else is reported, never guessed at.
  const evaluate = (src, value) => {
    const m = /^\$\{\{([\s\S]*)\}\}$/.exec(String(src).trim());
    if (!m) throw new Error("not a single ${{ }} expression");
    const toks = m[1].match(/\s+|\x27(?:[^\x27]|\x27\x27)*\x27|&&|\|\||==|!=|!|\(|\)|[A-Za-z_][\w.-]*|\S/g).filter((t) => !/^\s+$/.test(t));
    let i = 0;
    const peek = () => toks[i];
    const num = (v) => v === null ? 0 : typeof v === "boolean" ? Number(v) : typeof v === "string" ? (v.trim() === "" ? 0 : Number(v)) : v;
    const eq = (a, b) => typeof a === typeof b && a !== null && b !== null
      ? (typeof a === "string" ? a.toLowerCase() === b.toLowerCase() : a === b)
      : (a === null && b === null) || num(a) === num(b);
    const truthy = (v) => !(v === false || v === null || v === "" || v === 0 || Number.isNaN(v));
    const primary = () => {
      const t = toks[i++];
      if (t === "(") { const v = or(); if (toks[i++] !== ")") throw new Error("unbalanced parentheses"); return v; }
      if (t === "true") return true;
      if (t === "false") return false;
      if (t === "null") return null;
      if (/^\x27/.test(t ?? "")) return t.slice(1, -1).replace(/\x27\x27/g, "\x27");
      if (/^inputs\.dry_run$/i.test(t ?? "")) return value;
      throw new Error("cannot evaluate " + JSON.stringify(t));
    };
    // GitHub precedence: ! binds tighter than == and !=, which bind tighter
    // than &&, then ||. So !a == b is (!a) == b.
    const not = () => { if (peek() === "!") { i++; return !truthy(not()); } return primary(); };
    const cmp = () => {
      const a = not();
      if (peek() === "==" || peek() === "!=") { const op = toks[i++]; const b = not(); return op === "==" ? eq(a, b) : !eq(a, b); }
      return a;
    };
    const and = () => { let v = cmp(); while (peek() === "&&") { i++; const r = cmp(); v = truthy(v) ? r : v; } return v; };
    const or = () => { let v = and(); while (peek() === "||") { i++; const r = and(); v = truthy(v) ? v : r; } return v; };
    const v = or();
    if (i !== toks.length) throw new Error("trailing " + JSON.stringify(toks.slice(i).join(" ")));
    return { v, truthy };
  };
  // EVAL_EXPR set: evaluate it for EVAL_VALUE (JSON) and print the result,
  // so the evaluator itself can be checked against known GitHub answers.
  if (process.env.EVAL_EXPR !== undefined) {
    try { console.log(JSON.stringify(evaluate(process.env.EVAL_EXPR, JSON.parse(process.env.EVAL_VALUE)).v)); }
    catch (e) { console.log("error: " + e.message); }
    process.exit(0);
  }
  // A tag push has no inputs; a dispatch or a workflow_call passes a boolean.
  const starts = [["a tag push", null, false], ["a real dispatch", false, false], ["a dry-run dispatch", true, true]];
  for (const [what, get, canon, kind] of sites) {
    const src = get(doc);
    if (src === undefined) { out.push(what + " is missing"); continue; }
    if (src !== canon) out.push(what + " is " + JSON.stringify(src) + ", not the one spelling " + JSON.stringify(canon));
    for (const [how, value, dry] of starts) {
      let r;
      try { r = evaluate(src, value); } catch (e) { out.push(what + ": " + e.message); break; }
      const { v, truthy } = r;
      // An env value is the expression result as a string; null becomes "".
      const ok = kind === "env" ? (v === null ? "" : String(v)) === String(dry)
        : kind === "flag" ? v === dry
        : kind === "notify" ? truthy(v) === !dry
        : v === (dry ? "release-dry-run" : "release");
      if (!ok) out.push(what + " disagrees on " + how + " (dry run " + dry + "): it gives " + JSON.stringify(v));
    }
  }
  // Every other reading of the input is a second decision.
  const known = new Set(sites.map(([what]) => what));
  const walk = (o, path) => {
    if (typeof o === "string") {
      // An `if:` is an expression with or without the ${{ }} around it.
      const exprs = /\.if$/.test(path) && !o.includes("${{") ? [o] : o.match(/\$\{\{[\s\S]*?\}\}/g) ?? [];
      // The input, by dot or bracket (contexts are case-insensitive, and
      // github.event.inputs.dry_run contains inputs.dry_run), or the whole
      // inputs context serialised. env.DRY_RUN is the consumer, checked below.
      const readsInput = /\binputs\s*(?:\.\s*dry_run\b|\[\s*["\x27]?dry_run\b)|\btoJSON\s*\(\s*inputs\s*\)/i;
      for (const e of exprs)
        if (readsInput.test(e) && !known.has(path)) out.push(path + " reads dry_run on its own: " + e);
      return;
    }
    if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) walk(v, path + "." + k);
  };
  walk(doc.jobs ?? {}, "jobs");
  walk(doc.concurrency ?? {}, "concurrency");
  for (const [k, v] of Object.entries(doc.env ?? {})) if (k !== "DRY_RUN") walk(v, "env." + k);
  const consumerIf = /^(?:\$\{\{\s*)?env\.DRY_RUN\s*(?:==|!=)\s*\x27true\x27(?:\s*\}\})?$/;
  const consumerRun = /"\$\{?DRY_RUN\}?"\s*!?=\s*"true"/g;
  for (const [name, job] of Object.entries(doc.jobs ?? {})) {
    if (job.env && "DRY_RUN" in job.env) out.push(name + ": redefines DRY_RUN");
    for (const [i, s] of (job.steps ?? []).entries()) {
      const label = name + ": step " + (s.name ?? s.id ?? s.uses ?? String(i));
      if (s.env && "DRY_RUN" in s.env) out.push(label + " redefines DRY_RUN");
      if (/DRY_RUN/.test(String(s.if ?? "")) && !consumerIf.test(String(s.if).trim()))
        out.push(label + " tests DRY_RUN as " + JSON.stringify(s.if) + ", not env.DRY_RUN == or != \x27true\x27");
      if (typeof s.run === "string" && /DRY_RUN/.test(s.run.replace(consumerRun, "")))
        out.push(label + " reads DRY_RUN other than as \"$DRY_RUN\" = or != \"true\"");
    }
  }
  if (out.length) console.log(out.join("\n"));
  process.exit(0);
}
if (mode === "sidecar-digests") {
  // #781: every sidecar-* artifact publish-sidecar publishes crosses with a
  // digest carried as a job output, and is checked against it first.
  const out = [];
  const isUpload = (st) => String(st.uses ?? "").toLowerCase().startsWith("actions/upload-artifact@");
  // Legs of a job: 1 with no matrix, or with a matrix that is exactly one
  // include entry and no axis. Any axis multiplies the legs (and include can
  // add more), so anything else counts as many: they would share one
  // outputs block.
  const legsOf = (j) => {
    const m = jobs[j]?.strategy?.matrix;
    if (m === undefined) return 1;
    if (!m || typeof m !== "object") return Infinity;
    const keys = Object.keys(m);
    return keys.length === 1 && keys[0] === "include" && Array.isArray(m.include) ? m.include.length : Infinity;
  };
  // The digest is taken of the finished file: after it, the job only uploads.
  const digestLast = (name) => {
    const steps = jobs[name]?.steps ?? [];
    const at = steps.findIndex((st) => st.id === "digest");
    if (at < 0) { out.push(name + ": no step with id digest"); return; }
    if (!steps.slice(at + 1).length || !steps.slice(at + 1).every(isUpload))
      out.push(name + ": steps other than uploads run after the digest is taken, so it may not describe what is uploaded");
    if (!steps.slice(at + 1).some((st) => /^sidecar-/.test(String(st.with?.name ?? ""))))
      out.push(name + ": does not upload a sidecar-* artifact after the digest");
    if (steps[at]["continue-on-error"] !== undefined) out.push(name + ": the digest step has continue-on-error");
    if (jobs[name]?.outputs?.sha256 !== "${{ steps.digest.outputs.sha256 }}")
      out.push(name + ": output sha256 must be ${{ steps.digest.outputs.sha256 }} (got " + JSON.stringify(jobs[name]?.outputs?.sha256) + ")");
  };
  // A matrix shares ONE outputs block across its legs, so any leg can write
  // a name another leg owns. Whatever uploads a sidecar-* artifact is
  // therefore a job with at most one leg, and so the only writer of its own
  // digest.
  for (const [name, job] of Object.entries(jobs))
    if ((job.steps ?? []).some((st) => isUpload(st) && /^sidecar-/.test(String(st.with?.name ?? ""))) && legsOf(name) > 1)
      out.push(name + ": uploads a sidecar-* artifact from a matrix of " + legsOf(name) + " legs, any of which can set the digest output");
  // Each leg job: one leg, the npm package its name says.
  const expectEnv = {};
  for (const leg of ["linux-x64", "linux-arm64", "darwin-arm64", "darwin-x64"]) {
    const j = "build-sidecar-" + leg;
    if (!jobs[j]) { out.push("no " + j + " job"); continue; }
    const inc = jobs[j].strategy?.matrix?.include ?? [];
    if (legsOf(j) !== 1 || inc[0]?.npm_pkg !== leg) out.push(j + ": must build exactly the " + leg + " leg (got " + JSON.stringify(inc.map((l) => l.npm_pkg)) + ")");
    digestLast(j);
    expectEnv[leg] = "needs." + j + ".outputs.sha256";
  }
  digestLast("sign-sidecar-windows");
  expectEnv["win32-x64"] = "needs.sign-sidecar-windows.outputs.sha256";
  const pub = jobs["publish-sidecar"];
  if (!pub) out.push("no publish-sidecar job");
  else {
    for (const ref of Object.values(expectEnv)) {
      const n = ref.split(".")[1];
      if (!needsOf("publish-sidecar").includes(n)) out.push("publish-sidecar: does not list " + n + " in needs, so its outputs read as empty");
    }
    const steps = pub.steps ?? [];
    const dl = steps.findIndex((st) => String(st.uses ?? "").toLowerCase().startsWith("actions/download-artifact@"));
    const v = steps[dl + 1];
    if (dl < 0) out.push("publish-sidecar: no artifact download");
    else if (!v || typeof v.run !== "string" || !/\bsha256sum\s+--strict\s+-c\b/.test(v.run))
      out.push("publish-sidecar: the step right after the download is not a sha256sum --strict -c of the artifacts");
    else {
      if (v.if !== undefined) out.push("publish-sidecar: the artifact check has an if:, so it can be switched off on its own");
      for (const st of [steps[dl], v])
        if (st["continue-on-error"] !== undefined) out.push("publish-sidecar: continue-on-error on " + (st.name ?? st.uses) + ", so a failed check would not stop the publish");
      // By name, so two legs cannot be crossed over: the script binds each
      // SHA_<LEG> to that leg file, which the fixtures below exercise.
      for (const [leg, ref] of Object.entries(expectEnv)) {
        const k = "SHA_" + leg.toUpperCase().replace(/-/g, "_");
        if (v.env?.[k] !== "${{ " + ref + " }}")
          out.push("publish-sidecar: the artifact check must take " + k + " from ${{ " + ref + " }} (got " + JSON.stringify(v.env?.[k]) + ")");
      }
    }
  }
  if (out.length) console.log(out.join("\n"));
  process.exit(0);
}
if (mode === "installer-digests") {
  // #779: the installer crosses build-windows -> sign-windows -> publish, and
  // build-macos -> publish, each by a digest that is a job output of the job
  // that produced the bytes, checked in the step right after the download.
  const out = [];
  const isUpload = (st) => String(st.uses ?? "").toLowerCase().startsWith("actions/upload-artifact@");
  const isDownload = (st) => String(st.uses ?? "").toLowerCase().startsWith("actions/download-artifact@");
  for (const name of ["build-windows", "sign-windows", "build-macos"]) {
    const job = jobs[name];
    if (!job) { out.push("no " + name + " job"); continue; }
    // None of the three needs a matrix; with one, its legs would share one
    // outputs block and any leg could set the digest (#779 re-review).
    if (job.strategy?.matrix !== undefined)
      out.push(name + ": has a matrix, whose legs would share one outputs block");
    const dg = (job.steps ?? []).find((st) => st.id === "digest");
    if (dg && dg["continue-on-error"] !== undefined) out.push(name + ": the digest step has continue-on-error");
    if (job.outputs?.sha256 !== "${{ steps.digest.outputs.sha256 }}")
      out.push(name + ": output sha256 must be ${{ steps.digest.outputs.sha256 }} (got " + JSON.stringify(job.outputs?.sha256) + ")");
    const steps = job.steps ?? [];
    const at = steps.findIndex((st) => st.id === "digest");
    if (at < 0) out.push(name + ": no step with id digest");
    else if (!steps.slice(at + 1).length || !steps.slice(at + 1).every(isUpload))
      out.push(name + ": steps other than uploads run after the digest is taken");
  }
  // check <job> <env var> <expected needs reference>: the step after the
  // job download reads that digest, under no condition of its own.
  const check = (job, want) => {
    const steps = jobs[job]?.steps ?? [];
    const dl = steps.findIndex(isDownload);
    const v = steps[dl + 1];
    if (dl < 0 || !v || typeof v.run !== "string" || !/\bsha256sum\b[^\n]*\s-c\b/.test(v.run)) {
      out.push(job + ": the step right after its download is not a sha256sum -c");
      return;
    }
    if (v.if !== undefined || v["continue-on-error"] !== undefined || steps[dl]["continue-on-error"] !== undefined)
      out.push(job + ": its digest check can be skipped or allowed to fail");
    for (const [k, ref] of Object.entries(want)) {
      if (v.env?.[k] !== "${{ " + ref + " }}") out.push(job + ": the check must take " + k + " from ${{ " + ref + " }} (got " + JSON.stringify(v.env?.[k]) + ")");
      const n = ref.split(".")[1];
      if (!needsOf(job).includes(n)) out.push(job + ": does not list " + n + " in needs, so its outputs read as empty");
    }
  };
  check("sign-windows", { SHA256: "needs.build-windows.outputs.sha256" });
  // The SIGNED installer: its digest comes from the signer, not the build.
  check("publish", { SHA_WIN32_X64: "needs.sign-windows.outputs.sha256", SHA_DARWIN: "needs.build-macos.outputs.sha256" });
  if (out.length) console.log(out.join("\n"));
  process.exit(0);
}
if (mode === "image") {
  // #680, #868: the image is built once into an OCI archive by a job that
  // cannot write to a registry, smoke-tested from that archive, its push
  // rehearsed against a loopback registry by the very script publish-docker
  // runs, and pushed to GHCR by digest only by publish-docker, after the
  // approval chain. No comment in this JS may contain an apostrophe: the
  // whole program sits inside a single-quoted shell string.
  const out = [];
  const lc = (st) => String(st.uses ?? "").toLowerCase();
  const isBuild = (st) => /^docker\/(build-push-action|bake-action)@/.test(lc(st));
  const isLogin = (st) => lc(st).startsWith("docker/login-action@");
  const code = (st) => typeof st.run === "string" ? st.run.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n") : "";
  const stepsOf = (j) => jobs[j]?.steps ?? [];
  const permOf = (j) => jobs[j]?.permissions ?? doc.permissions;
  const same = (a, b) => JSON.stringify(Object.entries(a ?? {}).sort()) === JSON.stringify(Object.entries(b ?? {}).sort());
  const upstream = (j, target, seen = new Set()) => {
    if (j === target) return true;
    if (seen.has(j)) return false;
    seen.add(j);
    return needsOf(j).some((n) => upstream(n, target, seen));
  };
  const OCI_OUT = "type=oci,dest=${{ runner.temp }}/release-image.oci.tar";
  const ARCHIVE = "${{ runner.temp }}/release-image.oci.tar";
  const DIG = "${{ needs.build-image.outputs.digest }}";
  const ASUM = "${{ needs.build-image.outputs.archive_sha256 }}";
  const PUSH_ENV = (registry) => ({
    REGISTRY: registry,
    DIGEST: DIG,
    ARCHIVE_SHA256: ASUM,
    TAGS: "${{ needs.build-image.outputs.tags }}",
    VERSION: "${{ needs.validate-tag.outputs.version }}",
    PRERELEASE: "${{ needs.validate-tag.outputs.prerelease }}",
  });
  const REAL = "env.DRY_RUN != \x27true\x27";
  const PUSH_NAME = "Push the smoked archive by digest and tag it";
  const REHEARSE_NAME = "Rehearse the push by digest and the tagging";
  const pd = stepsOf("publish-docker");
  const si = stepsOf("smoke-image");
  const bi = stepsOf("build-image");
  const push = pd.find((st) => st.name === PUSH_NAME);
  const rehearse = si.find((st) => st.name === REHEARSE_NAME);
  // Who builds, who writes to a registry, who holds a registry scope.
  const buildCmd = /\bdocker\s+(?:image\s+)?build\b|\bbuildx\s+(?:build|bake)\b|\bdocker\s+(?:image\s+)?(?:commit|import)\b/;
  // Global flags may sit between a binary and its subcommand (docker
  // --config x push, skopeo --debug copy), so they are skipped (#868 review).
  const flags = "(?:\\s+-{1,2}[^\\s=]+(?:=\\S*|\\s+(?!-)\\S+)?)*";
  const registryWrite = new RegExp(
    "\\b(?:docker|podman|buildah)" + flags + "\\s+(?:(?:image|manifest)\\s+)?push\\b" +
    "|\\bimagetools" + flags + "\\s+create\\b" +
    "|\\b(?:skopeo|crane|regctl|oras)" + flags + "\\s+(?:copy|cp|push|tag|sync|delete|mutate|append|attach|image\\s+copy|index\\s+create|image\\s+mod|manifest\\s+(?:put|push|delete))\\b" +
    "|--push\\b|\\btype\\s*=\\s*registry\\b" +
    "|\\b(?:curl|wget)\\b[^\\n]*(?:-X\\s*|--method[=\\s])(?:PUT|POST|PATCH|DELETE)\\b[^\\n]*\\/v2\\/");
  for (const [name, job] of Object.entries(jobs)) {
    const steps = job.steps ?? [];
    if (name !== "build-image" && (steps.some(isBuild) || steps.some((st) => buildCmd.test(code(st)))))
      out.push(name + ": builds an image; only build-image may, so the image that ships is built once");
    // The only two run: steps that may write to a registry are the push
    // script and its rehearsal, which are pinned to each other below.
    for (const st of steps)
      if (registryWrite.test(code(st)) && st !== push && st !== rehearse)
        out.push(name + ": writes to a registry from a run: step other than the push script; only publish-docker pushes, and smoke-image rehearses that push on loopback");
    if (name !== "publish-docker" && steps.some(isLogin))
      out.push(name + ": logs in to a registry; since #868 only publish-docker, after the approval chain, holds a registry credential");
    const p = permOf(name);
    if ((p === "write-all" || p?.packages === "write") && name !== "publish-docker")
      out.push(name + ": holds packages: write; only publish-docker may, after the approval chain (#868)");
    if (steps.some((st) => isBuild(st) && (String(st.with?.push ?? "false") !== "false" || /(?:^|[,\s])(?:push\s*=\s*(?:true|1|t)\b|type\s*=\s*(?:image|registry)\b)/i.test(String(st.with?.outputs ?? "")))))
      out.push(name + ": a build step pushes or exports to a registry; the release image leaves its build only as the archive");
  }
  // Every action the three image jobs use, allowlisted (#868 review): a
  // push action has no run: text for the rule above to see.
  const USES = {
    "build-image": ["actions/checkout@", "docker/setup-qemu-action@", "docker/setup-buildx-action@", "docker/metadata-action@", "docker/build-push-action@", "actions/upload-artifact@"],
    "smoke-image": ["actions/checkout@", "actions/download-artifact@"],
    "publish-docker": ["actions/download-artifact@", "docker/login-action@"],
  };
  for (const [j, ok] of Object.entries(USES))
    for (const st of stepsOf(j))
      if (st.uses !== undefined && !ok.some((a) => lc(st).startsWith(a)))
        out.push(j + ": uses " + st.uses + ", which is not one of the actions this job may use");
  // build-image: one cold, attested build into the archive, and nothing else.
  const b = bi.find((st) => st.id === "build");
  if (!jobs["build-image"]) out.push("no build-image job");
  else {
    if (!same(permOf("build-image"), { contents: "read" })) out.push("build-image: permissions must be exactly contents: read, no registry scope (#868) (got " + JSON.stringify(permOf("build-image")) + ")");
    if (bi.filter(isBuild).length !== 1) out.push("build-image: has " + bi.filter(isBuild).length + " build steps, not exactly one (#868 retired the dry-run twin)");
    if (!b || !isBuild(b)) out.push("build-image: needs a build step with id build");
    else {
      if (b.if !== undefined) out.push("build-image: the build runs under " + JSON.stringify(b.if) + "; it must run on every run, dry or real, so a rehearsal builds what ships");
      if (b["continue-on-error"] !== undefined) out.push("build-image: a build step has continue-on-error");
      if (b.with?.outputs !== OCI_OUT) out.push("build-image: the build must output exactly " + OCI_OUT + " (got " + JSON.stringify(b.with?.outputs) + ")");
      for (const k of ["push", "load", "tags", "cache-from", "cache-to"])
        if (b.with?.[k] !== undefined) out.push("build-image: the build sets " + k + ", which a cold build into the archive must not");
      if (b.with?.provenance !== "mode=max") out.push("build-image: provenance must be mode=max (got " + JSON.stringify(b.with?.provenance) + ")");
      if (b.with?.sbom !== "generator=${{ env.SBOM_GENERATOR }}") out.push("build-image: sbom must be generator=${{ env.SBOM_GENERATOR }} (got " + JSON.stringify(b.with?.sbom) + ")");
      // Nothing that hands the build a credential or more authority (#680
      // review). Without context: ., build-push-action builds the git
      // context and passes its github-token as a build secret any RUN step
      // can mount.
      if (b.with?.context !== ".") out.push("build-image: build builds context " + JSON.stringify(b.with?.context) + ", not the checkout (.)");
      for (const k of ["secrets", "secret-files", "secret-envs", "ssh", "github-token", "build-contexts", "allow", "network"])
        if (b.with?.[k] !== undefined) out.push("build-image: build sets " + k + ", which hands the build a credential or more authority");
    }
    const o = jobs["build-image"].outputs ?? {};
    if (o.digest !== "${{ steps.build.outputs.digest }}") out.push("build-image: output digest must be ${{ steps.build.outputs.digest }} (got " + JSON.stringify(o.digest) + ")");
    if (o.archive_sha256 !== "${{ steps.archive.outputs.sha256 }}") out.push("build-image: output archive_sha256 must be ${{ steps.archive.outputs.sha256 }} (got " + JSON.stringify(o.archive_sha256) + ")");
    // The archive digest is taken after the build, and only the upload follows.
    const at = bi.findIndex((st) => st.id === "archive");
    const up = bi[at + 1];
    if (at < 0 || at < bi.indexOf(b) || bi.length !== at + 2 || !up || !lc(up).startsWith("actions/upload-artifact@"))
      out.push("build-image: the archive digest is not taken after the build with only the upload after it");
    else {
      if (bi[at].if !== undefined || up.if !== undefined) out.push("build-image: the archive digest or upload runs under a condition; both run on every run");
      // Kept until publish-docker can read it after the approvals: GitHub
      // cancels a run after 35 days, waiting included.
      if (up.with?.name !== "release-image-oci" || up.with?.path !== ARCHIVE || up.with?.["if-no-files-found"] !== "error" ||
          up.with?.["retention-days"] !== "${{ env.DRY_RUN == \x27true\x27 && 1 || 35 }}")
        out.push("build-image: the archive upload must be release-image-oci from " + ARCHIVE + ", if-no-files-found: error, retention-days ${{ env.DRY_RUN == \x27true\x27 && 1 || 35 }} (got " + JSON.stringify(up.with) + ")");
    }
    // Never runs what it built.
    const runsImage = /\bdocker\s+(?:container\s+)?(?:run|create|start|exec|load)\b|docker-smoke\.sh/;
    if (bi.some((st) => runsImage.test(code(st))) || bi.some((st) => isBuild(st) && String(st.with?.load ?? "false") !== "false"))
      out.push("build-image: runs or loads an image");
  }
  // smoke-image: no registry scope, the archive checked by content and run,
  // and the push rehearsed on loopback by the publish script itself.
  if (!jobs["smoke-image"]) out.push("no smoke-image job");
  else {
    if (!same(permOf("smoke-image"), { contents: "read" })) out.push("smoke-image: permissions must be exactly contents: read, in the job that runs the image (got " + JSON.stringify(permOf("smoke-image")) + ")");
    for (const n of ["build-image", "validate-tag"])
      if (!needsOf("smoke-image").includes(n)) out.push("smoke-image: does not list " + n + " in needs, so its outputs read as empty");
    if (si.some((st) => /\bdocker\s+(?:image\s+)?pull\b/.test(code(st)))) out.push("smoke-image: pulls an image by name; it runs the archive build-image made");
    const load = si.findIndex((st) => /\bdocker\s+load\b/.test(code(st)));
    const ls = si[load];
    if (load < 0) out.push("smoke-image: never loads the archive");
    else {
      if (ls.if !== undefined || ls["continue-on-error"] !== undefined) out.push("smoke-image: the archive load runs under " + JSON.stringify(ls.if) + " or may fail; it must run on every run");
      if (ls.env?.DIGEST !== DIG || ls.env?.ARCHIVE_SHA256 !== ASUM)
        out.push("smoke-image: the archive load does not take DIGEST and ARCHIVE_SHA256 from build-image outputs");
      const dl = si[load - 1];
      if (!dl || !lc(dl).startsWith("actions/download-artifact@") || dl.with?.name !== "release-image-oci" || dl.if !== undefined || dl["continue-on-error"] !== undefined)
        out.push("smoke-image: the archive load is not right after an unconditional release-image-oci download");
      if (!/sha256sum -c -[\s\S]*tar -xf[\s\S]*sha256sum -c -[\s\S]*sha256sum -c -[\s\S]*docker load/.test(code(ls)))
        out.push("smoke-image: the archive load does not check the archive, then the index, then the amd64 manifest, before docker load");
    }
    const sm = si.findIndex((st) => /docker-smoke\.sh\s+"\$GATE_IMAGE_TAG"/.test(code(st)));
    if (sm < 0) out.push("smoke-image: never runs docker-smoke.sh on $GATE_IMAGE_TAG");
    else {
      if (si[sm].if !== undefined || si[sm]["continue-on-error"] !== undefined) out.push("smoke-image: the smoke test can be skipped or allowed to fail");
      if (sm < load) out.push("smoke-image: smokes before the image is loaded");
    }
    if (!rehearse || typeof rehearse.run !== "string") out.push("smoke-image: no step named " + JSON.stringify(REHEARSE_NAME) + " rehearsing the push");
    else {
      if (rehearse.if !== undefined || rehearse["continue-on-error"] !== undefined) out.push("smoke-image: the push rehearsal can be skipped or allowed to fail; it runs on every run, dry or real");
      if (!same(rehearse.env, PUSH_ENV("127.0.0.1:5000")))
        out.push("smoke-image: the push rehearsal env must be exactly, pushing to a loopback registry, " + JSON.stringify(PUSH_ENV("127.0.0.1:5000")) + " (got " + JSON.stringify(rehearse.env) + ")");
      if (si.indexOf(rehearse) < load) out.push("smoke-image: rehearses the push before the archive is checked and loaded");
    }
    // The throwaway registry: pinned by digest, on loopback only.
    const reg = si.find((st) => /\bdocker\s+run\b[^\n]*\$REHEARSAL_REGISTRY_IMAGE/.test(code(st)));
    if (!reg) out.push("smoke-image: the throwaway registry is not started from $REHEARSAL_REGISTRY_IMAGE");
    else if (!/\bdocker\s+run\s+-d\s+--name\s+"\$REHEARSAL_CONTAINER"\s+-p\s+127\.0\.0\.1:5000:5000\s+"\$REHEARSAL_REGISTRY_IMAGE"\s*$/m.test(code(reg)))
      out.push("smoke-image: the throwaway registry is not bound to 127.0.0.1:5000 alone");
    if (!/^registry:[0-9][0-9.]*@sha256:[0-9a-f]{64}$/.test(String(doc.env?.REHEARSAL_REGISTRY_IMAGE ?? "")))
      out.push("REHEARSAL_REGISTRY_IMAGE is not pinned by tag and digest (got " + JSON.stringify(doc.env?.REHEARSAL_REGISTRY_IMAGE) + ")");
  }
  // publish-docker: after the approval chain, the archive checked, pushed by
  // digest and tagged, by the script smoke-image rehearsed.
  if (!jobs["publish-docker"]) out.push("no publish-docker job");
  else {
    const p = permOf("publish-docker");
    if (JSON.stringify(p) !== JSON.stringify({ packages: "write" })) out.push("publish-docker: permissions must be exactly packages: write (got " + JSON.stringify(p) + ")");
    for (const n of ["build-image", "smoke-image", "publish-brain", "validate-tag"])
      if (!needsOf("publish-docker").includes(n)) out.push("publish-docker: does not list " + n + " in needs");
    if (!push || typeof push.run !== "string") out.push("publish-docker: no step named " + JSON.stringify(PUSH_NAME));
    else {
      if (push.if !== REAL || push["continue-on-error"] !== undefined)
        out.push("publish-docker: the push step must run under exactly " + REAL + " and may not fail (got if " + JSON.stringify(push.if) + ")");
      if (!same(push.env, PUSH_ENV("ghcr.io"))) out.push("publish-docker: the push step env must be exactly " + JSON.stringify(PUSH_ENV("ghcr.io")) + " (got " + JSON.stringify(push.env) + ")");
      // Exactly these steps, in this order (#868 review): the archive is
      // downloaded and checked before the credential exists, and nothing but
      // the push script runs while it does.
      const SHAPE = [
        ["download", (st) => lc(st).startsWith("actions/download-artifact@") && st.with?.name === "release-image-oci" && st.if === REAL],
        ["Verify the archive", (st) => st.name === "Verify the archive" && st.if === REAL && st.env?.ARCHIVE_SHA256 === ASUM && /sha256sum -c -/.test(code(st))],
        ["login", (st) => lc(st).startsWith("docker/login-action@") && st.if === REAL],
        [PUSH_NAME, (st) => st === push],
        ["Dry-run summary", (st) => st.name === "Dry-run summary" && st.if === "env.DRY_RUN == \x27true\x27" && !registryWrite.test(code(st))],
      ];
      if (pd.length !== SHAPE.length || SHAPE.some(([, test], i) => !pd[i] || !test(pd[i])))
        out.push("publish-docker: steps must be exactly " + SHAPE.map(([n]) => n).join(", ") + ", in that order, the first four under " + REAL + " (got " + JSON.stringify(pd.map((st) => st.name ?? st.uses)) + ")");
      if (rehearse && typeof rehearse.run === "string" && rehearse.run !== push.run)
        out.push("publish-docker: the rehearsal and the publish run different scripts, so the rehearsal no longer proves the push");
      // The script itself: the archive checked, then pushed by its index
      // digest with digests preserved, then that digest read back and tagged.
      const c = code(push);
      const at = (re) => { const m = re.exec(c); return m ? m.index : -1; };
      const chk = at(/echo "\$\{ARCHIVE_SHA256\}  \$\{archive\}" \| sha256sum -c -/);
      const cp = at(/\bskopeo copy --all --preserve-digests --retry-times 3 "oci-archive:\$\{archive\}" "docker:\/\/\$\{image\}@\$\{DIGEST\}"/);
      const plan = at(/\bimagetools create --dry-run "\$\{args\[@\]\}" "\$\{image\}@\$\{DIGEST\}"/);
      const cr = at(/\bimagetools create "\$\{args\[@\]\}" "\$\{image\}@\$\{DIGEST\}"/);
      if (!/^\s*archive="\$\{RUNNER_TEMP\}\/release-image\/release-image\.oci\.tar"$/m.test(c)) out.push("publish-docker: the push script does not read the archive from ${RUNNER_TEMP}/release-image");
      if (!/^\s*image="\$\{REGISTRY\}\/\$\{GITHUB_REPOSITORY,,\}"$/m.test(c) || !/^\s*owned="ghcr\.io\/\$\{GITHUB_REPOSITORY,,\}"$/m.test(c))
        out.push("publish-docker: the push script does not derive image from REGISTRY and check tags against ghcr.io/<repo>");
      if (chk < 0) out.push("publish-docker: the push script does not check the archive before skopeo");
      if (cp < 0) out.push("publish-docker: skopeo copy must be exactly skopeo copy --all --preserve-digests --retry-times 3 oci-archive:${archive} docker://${image}@${DIGEST}");
      if (cr < 0) out.push("publish-docker: imagetools create does not take its source as ${image}@${DIGEST}");
      if (plan < 0) out.push("publish-docker: no imagetools create --dry-run of ${image}@${DIGEST} before the tags move");
      if (chk >= 0 && cp >= 0 && plan >= 0 && cr >= 0 && !(chk < cp && cp < plan && plan < cr))
        out.push("publish-docker: the push script does not run archive check, push, read-back, tag in that order");
      // Exactly those three registry calls, and no other write of any kind.
      const rest = c.replace(/\bskopeo copy --all --preserve-digests --retry-times 3 "oci-archive:\$\{archive\}" "docker:\/\/\$\{image\}@\$\{DIGEST\}"/, "")
        .replace(/\bimagetools create --dry-run "\$\{args\[@\]\}" "\$\{image\}@\$\{DIGEST\}"/, "")
        .replace(/\bimagetools create "\$\{args\[@\]\}" "\$\{image\}@\$\{DIGEST\}"/, "");
      if (registryWrite.test(rest) || /\bskopeo\s+(?!--version\b)\S/.test(rest))
        out.push("publish-docker: the push script writes to the registry other than by its one skopeo copy and one imagetools create");
    }
    if (pd.some((st) => lc(st).startsWith("actions/checkout@") || lc(st).startsWith("docker/setup-")))
      out.push("publish-docker: checks out or sets up a builder, and it builds nothing");
  }
  // The gates in front of every publisher.
  for (const j of ["sidecar", "pack-brain", "publish-brain", "publish-docker", "github-release"])
    if (jobs[j] && !upstream(j, "smoke-image")) out.push(j + ": does not run after smoke-image, so it can publish an image nobody ran");
  if (jobs["publish-docker"] && !upstream("publish-docker", "publish-brain")) out.push("publish-docker: does not run after publish-brain, the approval gate");
  if (jobs["github-release"] && !upstream("github-release", "publish-docker")) out.push("github-release: does not run after publish-docker");
  for (const j of ["build-image", "smoke-image", "publish-docker"])
    if (/\b(always|failure|cancelled)\s*\(|\bsuccess\s*\(\s*\)\s*\|\|/.test(String(jobs[j]?.if ?? ""))) out.push(j + ": can run after a failed gate (if: " + jobs[j].if + ")");
  if (out.length) console.log(out.join("\n"));
  process.exit(0);
}
if (mode === "postsign") {
  // #817: the Authenticode check runs in a job that cannot mint a token, on
  // exactly the bytes that ship, and publishing waits for it. The signer
  // defers to it, so nothing in the signer needs osslsigncode.
  const out = [];
  const file = require("node:path").basename(process.env.WORKFLOW);
  const T = file === "sidecar-release.yml"
    ? { sign: "sign-sidecar-windows", verify: "verify-sidecar-windows", publish: "publish-sidecar", artifact: "sidecar-win32-x64" }
    : file === "installer-release.yml"
      ? { sign: "sign-windows", verify: "verify-windows", publish: "publish", artifact: "installer-win32-x64" }
      : null;
  if (!T) { console.log("no post-sign verification is known for " + file); process.exit(0); }
  const stepsOf = (j) => jobs[j]?.steps ?? [];
  const calls = (j) => stepsOf(j).filter((st) => typeof st.run === "string" && /\bsign-windows\.sh\b/.test(st.run));
  const SIGNED = "needs." + T.sign + ".outputs.signed == \x27true\x27";
  // The signer: every call defers, under the readiness condition, and the
  // signer reports whether it signed.
  if (!jobs[T.sign]) out.push("no " + T.sign + " job");
  else {
    const c = calls(T.sign);
    if (!c.length) out.push(T.sign + ": never calls sign-windows.sh");
    for (const st of c) {
      if (!/\bsign-windows\.sh\s+--defer-verify\s/.test(st.run))
        out.push(T.sign + ": calls sign-windows.sh without --defer-verify, so it would verify, and need osslsigncode, in the job holding id-token");
      if (st.if !== "steps.winsign.outputs.ready == \x27true\x27")
        out.push(T.sign + ": signs under " + JSON.stringify(st.if) + ", not the readiness its signed output reports");
    }
    if (jobs[T.sign].outputs?.signed !== "${{ steps.winsign.outputs.ready }}")
      out.push(T.sign + ": output signed must be ${{ steps.winsign.outputs.ready }} (got " + JSON.stringify(jobs[T.sign].outputs?.signed) + "), or the check can be told there is nothing to verify");
    // #869: readiness fails a real run unless the escape hatch is set. Its
    // script is executed verbatim below; this pins what it is given and that
    // nothing can switch it off: no condition, no continue-on-error, the two
    // repository variables and nothing else, before any signing step.
    const steps = stepsOf(T.sign);
    const ri = steps.findIndex((st) => st.id === "winsign");
    const r = steps[ri];
    const READY_ENV = { GCP_KMS_KEYRING: "${{ vars.GCP_KMS_KEYRING }}", ALLOW_UNSIGNED_WINDOWS: "${{ vars.ALLOW_UNSIGNED_WINDOWS }}" };
    if (!r || typeof r.run !== "string") out.push(T.sign + ": no readiness run step with id winsign");
    else {
      if (r.if !== undefined) out.push(T.sign + ": the readiness step runs under " + JSON.stringify(r.if) + ", so it can be skipped and signing with it");
      if (r["continue-on-error"] !== undefined) out.push(T.sign + ": the readiness step has continue-on-error, so a real run missing its signing config would continue unsigned");
      if (r.shell !== undefined && r.shell !== "bash") out.push(T.sign + ": the readiness step runs under shell " + JSON.stringify(r.shell) + ", not bash");
      if (JSON.stringify(Object.entries(r.env ?? {}).sort()) !== JSON.stringify(Object.entries(READY_ENV).sort()))
        out.push(T.sign + ": the readiness step env must be exactly " + JSON.stringify(READY_ENV) + " (got " + JSON.stringify(r.env) + ")");
      const firstGated = steps.findIndex((st) => /steps\.winsign\.outputs\.ready/.test(String(st.if ?? "")));
      if (firstGated >= 0 && firstGated < ri) out.push(T.sign + ": a step gated on readiness runs before the readiness step");
      // What the step reads besides its own env: DRY_RUN, from the workflow.
      // A job env or an earlier GITHUB_ENV write could tell it a real run is
      // a rehearsal while the publish still reads the workflow value (#869
      // review).
      for (const k of ["DRY_RUN", "ALLOW_UNSIGNED_WINDOWS", "GCP_KMS_KEYRING"])
        if (jobs[T.sign].env && k in jobs[T.sign].env) out.push(T.sign + ": the job env sets " + k + ", which the readiness step reads");
      for (const st of steps.slice(0, ri))
        if (/GITHUB_ENV/.test(String(st.run ?? "") + JSON.stringify(st.with ?? {})))
          out.push(T.sign + ": a step before readiness writes GITHUB_ENV, which can change what the readiness step reads");
    }
  }
  const v = jobs[T.verify];
  if (!v) out.push("no " + T.verify + " job");
  else {
    const perm = v.permissions ?? doc.permissions;
    if (perm === "write-all" || (perm && typeof perm === "object" && Object.values(perm).some((x) => x === "write")))
      out.push(T.verify + ": holds a write scope or id-token (" + JSON.stringify(perm) + "); it installs a package and needs neither");
    if (!needsOf(T.verify).includes(T.sign)) out.push(T.verify + ": does not list " + T.sign + " in needs, so its outputs read as empty");
    const steps = stepsOf(T.verify);
    const dl = steps.findIndex((st) => String(st.uses ?? "").toLowerCase().startsWith("actions/download-artifact@"));
    const chk = steps[dl + 1];
    if (dl < 0 || steps[dl].with?.name !== T.artifact) out.push(T.verify + ": does not download " + T.artifact + ", the artifact that ships");
    else if (!chk || typeof chk.run !== "string" || !/\bsha256sum\b[^\n]*\s-c\b/.test(chk.run) || chk.env?.SHA256 !== "${{ needs." + T.sign + ".outputs.sha256 }}")
      out.push(T.verify + ": the step after the download is not a sha256sum -c against ${{ needs." + T.sign + ".outputs.sha256 }}, the digest of what ships");
    else if (steps[dl].if !== undefined || chk.if !== undefined || steps[dl]["continue-on-error"] !== undefined || chk["continue-on-error"] !== undefined)
      out.push(T.verify + ": its download or digest check can be skipped or allowed to fail");
    const at = steps.findIndex((st) => typeof st.run === "string" && /\bsign-windows\.sh\s+--verify-only\s/.test(st.run));
    const ver = steps[at];
    if (at < 0) out.push(T.verify + ": never runs sign-windows.sh --verify-only");
    else {
      if (at < dl + 2) out.push(T.verify + ": verifies before the digest check");
      if (ver.if !== SIGNED) out.push(T.verify + ": verifies under " + JSON.stringify(ver.if) + ", not exactly " + SIGNED);
      if (ver["continue-on-error"] !== undefined) out.push(T.verify + ": the signature check is allowed to fail");
      if (String(ver.env?.SIGN_REQUIRE_TRUSTED_CHAIN) !== "1") out.push(T.verify + ": SIGN_REQUIRE_TRUSTED_CHAIN is " + JSON.stringify(ver.env?.SIGN_REQUIRE_TRUSTED_CHAIN) + ", not \"1\"");
      if (ver.env?.SIGNING_PUBLISHER_CN !== "${{ vars.SIGNING_PUBLISHER_CN }}") out.push(T.verify + ": the publisher is not taken from vars.SIGNING_PUBLISHER_CN");
      const inst = steps.findIndex((st) => typeof st.run === "string" && /\bapt-get\s+install\b[^\n]*\bosslsigncode\b/.test(st.run));
      if (inst < 0 || inst > at || steps[inst].if !== SIGNED) out.push(T.verify + ": does not install osslsigncode, under the same condition, before the check");
    }
  }
  // #869 review: the token-less verify job refuses an unsigned answer from
  // the signer on a real run without the escape hatch, unconditionally.
  if (v) {
    const ref = (v.steps ?? []).find((st) => st.name === "Refuse an unsigned binary on a real run");
    const REF_ENV = { SIGNED: "${{ needs." + T.sign + ".outputs.signed }}", ALLOW_UNSIGNED_WINDOWS: "${{ vars.ALLOW_UNSIGNED_WINDOWS }}" };
    if (!ref || typeof ref.run !== "string") out.push(T.verify + ": no step refusing an unsigned binary on a real run");
    else {
      if (ref.if !== undefined || ref["continue-on-error"] !== undefined) out.push(T.verify + ": the unsigned-binary refusal can be skipped or allowed to fail");
      if (JSON.stringify(Object.entries(ref.env ?? {}).sort()) !== JSON.stringify(Object.entries(REF_ENV).sort()))
        out.push(T.verify + ": the unsigned-binary refusal env must be exactly " + JSON.stringify(REF_ENV) + " (got " + JSON.stringify(ref.env) + ")");
    }
    if (v.env && "DRY_RUN" in v.env) out.push(T.verify + ": the job env sets DRY_RUN, which the unsigned-binary refusal reads");
  }
  if (!needsOf(T.publish).includes(T.verify)) out.push(T.publish + ": does not wait for " + T.verify + ", so it can publish a signature nobody checked");
  // Job-level bypasses (#817 review): a failed check must fail the job, and
  // the publisher must not run past a failed or skipped dependency.
  for (const j of [T.sign, T.verify, T.publish])
    if (jobs[j]?.["continue-on-error"] !== undefined) out.push(j + ": continue-on-error on the job, so a failure there does not stop the publish");
  const SHOULD = "needs.resolve.outputs.should_release == \x27true\x27";
  if (v && v.if !== SHOULD) out.push(T.verify + ": runs under " + JSON.stringify(v.if) + ", not exactly " + SHOULD);
  if (/\b(?:always|failure|cancelled)\s*\(/.test(String(jobs[T.publish]?.if ?? "")))
    out.push(T.publish + ": can run after a failed dependency (if: " + jobs[T.publish].if + ")");
  if (out.length) console.log(out.join("\n"));
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
// A write call to the releases API needs `contents: write`, and each job
// declares its own permissions (#646), so a step pasted into the wrong job
// gets a 403 at the END of a release -- after the tag exists and npm has
// published. #786 did exactly that: the dry-run notes step landed in
// github-release (contents: write, correct) AND in publish-docker
// (contents: read); the copy that got a 403 failed the run, which skipped the
// copy that worked. A GET is fine on read, so this keys on the method.
for (const [name, job] of Object.entries(jobs))
  for (const [i, s] of (job.steps ?? []).entries()) {
    if (typeof s.run !== "string" || !/\bgh\s+api\b/.test(s.run)) continue;
    if (!/--method\s+(POST|PUT|PATCH|DELETE)\b/.test(s.run)) continue;
    if (!/\/releases\b/.test(s.run)) continue;
    if (job.permissions?.contents !== "write")
      out.push(name + ": step " + (s.name ?? s.id ?? String(i)) +
        " writes to the releases API but its job has contents: " +
        JSON.stringify(job.permissions?.contents ?? null) + " (needs \"write\", or it 403s)");
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
# mutant <label> <exact text> <replacement> [reason]: the text must occur exactly once.
# MUTANT_FROM (default the release workflow) and MUTANT_MODE (default
# structure) pick the file and the check. The copy keeps the basename of the
# file it mutates, because the dry-run check keys on it: a copy called
# anything else would be reported for its name, whatever its content.
mutant() {
	local label="$1" from="${MUTANT_FROM:-$WORKFLOW}"
	mkdir -p "${WORK}/m"
	local copy
	copy="${WORK}/m/$(basename "$from")"
	if ! FROM="$from" TO="$copy" OLD="$2" NEW="$3" bun -e '
const s = await Bun.file(process.env.FROM).text();
const n = s.split(process.env.OLD).length - 1;
if (n !== 1) { console.error("anchor occurs " + n + " times"); process.exit(2); }
await Bun.write(process.env.TO, s.replace(process.env.OLD, process.env.NEW));
'; then
		no "mutant '${label}' could be applied (the workflow no longer has the text it mutates)"
		return
	fi
	mutant_report "$label" "$copy" "${4:-}"
}
# mutant_all <label> <exact text> <replacement>: every occurrence, at least two
# (for a hole that needs the same change in two places, such as both builds).
mutant_all() {
	local label="$1" from="${MUTANT_FROM:-$WORKFLOW}"
	mkdir -p "${WORK}/m"
	local copy
	copy="${WORK}/m/$(basename "$from")"
	if ! FROM="$from" TO="$copy" OLD="$2" NEW="$3" bun -e '
const s = await Bun.file(process.env.FROM).text();
const n = s.split(process.env.OLD).length - 1;
if (n < 2) { console.error("anchor occurs " + n + " times"); process.exit(2); }
await Bun.write(process.env.TO, s.split(process.env.OLD).join(process.env.NEW));
'; then
		no "mutant '${label}' could be applied (the workflow no longer has the text it mutates)"
		return
	fi
	mutant_report "$label" "$copy" "${4:-}"
}
# mutant_report <label> <mutated copy> [reason]: with a reason, the report
# must contain it, so a mutant that some OTHER rule happens to report
# proves nothing about the rule it was written for (#680 review).
mutant_report() {
	local label="$1" copy="$2" reason="${3:-}"
	local found
	found="$(YQ_FILE="$copy" yq "${MUTANT_MODE:-structure}")"
	if [ -n "$found" ] && [ -n "$reason" ] && ! grep -qF -- "$reason" <<<"$found"; then
		no "reports: ${label}, for the reason it exists" "wanted '${reason}', got:
${found}"
	elif [ -n "$found" ]; then
		ok "reports: ${label}"
		# MUTANT_VERBOSE=1 shows WHAT was reported, to check it is the hole
		# the mutant made and not some other complaint.
		[ -n "${MUTANT_VERBOSE:-}" ] && printf '%s\n' "$found" | sed 's/^/           /'
	else
		no "reports: ${label}" "the structure check passed a workflow with this hole"
	fi
	return 0
}
# shellcheck disable=SC2016 # every mutant is literal workflow text.
{
	mutant 'the gate forwarding the raw tag as an output' \
		'version: ${{ steps.validate.outputs.version }}' 'version: ${{ inputs.tag || github.ref_name }}'
	mutant 'a ${{ }} expression back inside a run:' \
		'run: npm version "$VERSION"' 'run: npm version "${{ needs.validate-tag.outputs.version }}"'
	mutant 'a consumer that does not list validate-tag in needs' \
		'needs: [validate-tag, pack-brain, smoke-image, sidecar]' 'needs: [pack-brain, smoke-image, sidecar]'
	mutant 'RELEASE_TAG back in the workflow env' \
		'  DRY_RUN: ${{ inputs.dry_run == true }}' '  DRY_RUN: ${{ inputs.dry_run == true }}
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
	mutant 'a releases-API write in a job that only has contents: read (#786)' \
		'which needs no token scope.
    permissions:
      contents: write' 'which needs no token scope.
    permissions:
      contents: read'
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
		'    needs: [validate-tag, test, smoke-image, sidecar]' '    needs: [validate-tag, test, smoke-image]'
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
echo "the release image is built once into an archive, smoke-tested and rehearsed from it, and pushed by digest only after approval (#680, #868)"
found="$(yq image)" || {
	no "image structure check ran" "the bun helper failed"
	found=""
}
if [ -z "$found" ]; then
	ok "one build into an archive with no registry scope, smoke-image runs and rehearses it on loopback, only publish-docker pushes it, after the approval chain"
else
	no "release image built once" "$found"
fi
# Every mutant names the reason it must be reported for (#680 review), so
# none of them passes because some other rule happens to fire.
# shellcheck disable=SC2016 # every mutant is literal workflow text.
{
	MUTANT_MODE=image
	# Authority (#868): nothing before the approval chain can write to a registry.
	mutant 'the build job given packages: write again (#868)' \
		$'  build-image:\n    needs: [validate-tag, test]\n    runs-on: ubuntu-latest\n    permissions:\n      contents: read\n' \
		$'  build-image:\n    needs: [validate-tag, test]\n    runs-on: ubuntu-latest\n    permissions:\n      contents: read\n      packages: write\n' \
		'build-image: holds packages: write'
	mutant 'the build job logging in to GHCR again (#868)' \
		'      - name: Generate Docker metadata' $'      - uses: docker/login-action@dbcb813823bdd20940b903addbd779551569679f # v4.6.0\n        with:\n          registry: ghcr.io\n      - name: Generate Docker metadata' \
		'build-image: logs in to a registry'
	mutant 'the build pushing by digest again, as #680 did (#868)' \
		'          outputs: type=oci,dest=${{ runner.temp }}/release-image.oci.tar' '          outputs: type=image,name=ghcr.io/${{ github.repository }},push-by-digest=true,name-canonical=true,push=true' \
		'build-image: a build step pushes or exports to a registry'
	mutant 'the build job given a packages scope of any kind (#868)' \
		$'  build-image:\n    needs: [validate-tag, test]\n    runs-on: ubuntu-latest\n    permissions:\n      contents: read\n' \
		$'  build-image:\n    needs: [validate-tag, test]\n    runs-on: ubuntu-latest\n    permissions:\n      contents: read\n      packages: read\n' \
		'build-image: permissions must be exactly contents: read'
	mutant 'the smoke job given a packages scope (#868)' \
		$'  smoke-image:\n    needs: [validate-tag, build-image]\n    runs-on: ubuntu-latest\n    permissions:\n      contents: read\n' \
		$'  smoke-image:\n    needs: [validate-tag, build-image]\n    runs-on: ubuntu-latest\n    permissions:\n      contents: read\n      packages: read\n' \
		'smoke-image: permissions must be exactly contents: read'
	mutant 'the smoke job logging in to GHCR again (#868)' \
		'      - name: Download the archive
        uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1
        with:
          name: release-image-oci
          path: ${{ runner.temp }}/release-image

      # The amd64' $'      - uses: docker/login-action@dbcb813823bdd20940b903addbd779551569679f # v4.6.0\n        with:\n          registry: ghcr.io\n      - name: Download the archive\n        uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1\n        with:\n          name: release-image-oci\n          path: ${{ runner.temp }}/release-image\n\n      # The amd64' \
		'smoke-image: logs in to a registry'
	mutant 'a third job holding packages: write (#680)' \
		$'  github-release:\n    needs: [validate-tag, publish-docker, sidecar]\n    runs-on: ubuntu-latest\n    # Creating the release (and its generated notes) is a contents write. The\n    # sidecar artifacts come from this same run, which needs no token scope.\n    permissions:\n      contents: write' \
		$'  github-release:\n    needs: [validate-tag, publish-docker, sidecar]\n    runs-on: ubuntu-latest\n    # Creating the release (and its generated notes) is a contents write. The\n    # sidecar artifacts come from this same run, which needs no token scope.\n    permissions:\n      contents: write\n      packages: write' \
		'github-release: holds packages: write'
	mutant 'a docker push from a run: step in the build job (#680)' \
		'      - name: Upload the archive' $'      - run: docker push ghcr.io/vierisid/jarvis:latest\n      - name: Upload the archive' \
		'build-image: writes to a registry from a run: step'
	mutant 'a tag created in the smoke job outside the rehearsal (#680)' \
		'      - name: Remove the image tag and the registry this job started' $'      - run: docker buildx imagetools create -t ghcr.io/o/r:latest "ghcr.io/o/r@$DIGEST"\n      - name: Remove the image tag and the registry this job started' \
		'smoke-image: writes to a registry from a run: step'
	mutant 'a skopeo push from the smoke job outside the rehearsal (#868)' \
		'      - name: Remove the image tag and the registry this job started' $'      - run: skopeo copy oci-archive:x docker://ghcr.io/o/r:latest\n      - name: Remove the image tag and the registry this job started' \
		'smoke-image: writes to a registry from a run: step'
	# One build, cold, attested, into the archive.
	mutant 'a second build of the image, in the job that pushes it (#680)' \
		'      - name: Push the smoked archive by digest and tag it' $'      - uses: docker/build-push-action@c3c9e263c25d99ce0380d002d59b67737d91b0dc # v7.4.0\n        with:\n          push: true\n      - name: Push the smoked archive by digest and tag it' \
		'publish-docker: builds an image'
	mutant 'a rebuild by command line in the smoke job (#680)' \
		'      - name: Smoke-test the image (run it like a user does)' $'      - run: docker buildx build --load -t "$GATE_IMAGE_TAG" .\n      - name: Smoke-test the image (run it like a user does)' \
		'smoke-image: builds an image'
	mutant 'a second build step in build-image, a dry-run twin again (#868)' \
		'      - name: Digest the archive' $'      - uses: docker/build-push-action@c3c9e263c25d99ce0380d002d59b67737d91b0dc # v7.4.0\n        if: env.DRY_RUN == \'true\'\n      - name: Digest the archive' \
		'build-image: has 2 build steps'
	mutant 'the build skipped on a dry run, so the rehearsal builds nothing (#868)' \
		$'        id: build\n        uses: docker/build-push-action' $'        id: build\n        if: env.DRY_RUN != \'true\'\n        uses: docker/build-push-action' \
		'build-image: the build runs under'
	mutant 'the build that ships allowed to fail (#680)' \
		$'        id: build\n' $'        id: build\n        continue-on-error: true\n' \
		'build-image: a build step has continue-on-error'
	mutant 'provenance dropped from the build that ships (#680)' \
		'          provenance: mode=max' '          provenance: false' \
		'build-image: provenance must be mode=max'
	mutant 'the SBOM dropped from the build that ships (#680)' \
		$'          sbom: generator=${{ env.SBOM_GENERATOR }}\n' '' \
		'build-image: sbom must be generator='
	mutant 'the build tagging the image itself (#680 review)' \
		$'          provenance: mode=max\n' $'          provenance: mode=max\n          tags: ghcr.io/vierisid/jarvis:latest\n' \
		'build-image: the build sets tags'
	mutant 'the build exporting to the shared gha cache again (#782)' \
		$'          provenance: mode=max\n' $'          provenance: mode=max\n          cache-to: type=gha,mode=max\n' \
		'build-image: the build sets cache-to'
	mutant 'the github token handed to the build as a secret (#680 review)' \
		$'          provenance: mode=max\n' $'          provenance: mode=max\n          secrets: GIT_AUTH_TOKEN=${{ github.token }}\n' \
		'build-image: build sets secrets'
	mutant 'the build off the checkout, onto the git context and its token (#680 review)' \
		$'          context: .\n          file: ./Dockerfile\n' $'          file: ./Dockerfile\n' \
		'build-image: build builds context undefined'
	mutant 'the build granted an insecure entitlement (#680 review)' \
		$'          provenance: mode=max\n' $'          provenance: mode=max\n          allow: security.insecure\n' \
		'build-image: build sets allow'
	mutant 'the digest output read from the wrong step (#680)' \
		'      digest: ${{ steps.build.outputs.digest }}' '      digest: ${{ steps.meta.outputs.digest }}' \
		'build-image: output digest must be'
	mutant 'the archive digest output taken from the wrong step (#680)' \
		'      archive_sha256: ${{ steps.archive.outputs.sha256 }}' '      archive_sha256: ${{ steps.build.outputs.digest }}' \
		'build-image: output archive_sha256 must be'
	mutant 'a step between the archive digest and its upload (#680)' \
		'      - name: Upload the archive' $'      - run: ls "$RUNNER_TEMP"\n      - name: Upload the archive' \
		'build-image: the archive digest is not taken after the build'
	mutant 'the archive upload skipped on a real run (#868)' \
		$'      - name: Upload the archive\n' $'      - name: Upload the archive\n        if: env.DRY_RUN == \'true\'\n' \
		'build-image: the archive digest or upload runs under a condition'
	mutant 'the archive expiring before a slow approval (#868)' \
		"          retention-days: \${{ env.DRY_RUN == 'true' && 1 || 35 }}" '          retention-days: 1' \
		'build-image: the archive upload must be release-image-oci'
	mutant 'the image run in the build job (#680)' \
		'      - name: Upload the archive' $'      - run: docker run --rm alpine true\n      - name: Upload the archive' \
		'build-image: runs or loads an image'
	mutant 'the push allowed after a failed test gate (#680)' \
		$'  build-image:\n    needs: [validate-tag, test]\n' $'  build-image:\n    needs: [validate-tag, test]\n    if: always()\n' \
		'build-image: can run after a failed gate'
	# smoke-image: the archive, by content, run, and its push rehearsed.
	mutant 'the smoke job pulling the image by name again (#868)' \
		'      - name: Load the image from its archive' $'      - run: docker pull ghcr.io/vierisid/jarvis:latest\n      - name: Load the image from its archive' \
		'smoke-image: pulls an image by name'
	mutant 'the archive load skipped on a real run, as before #868' \
		$'      - name: Load the image from its archive\n' $'      - name: Load the image from its archive\n        if: env.DRY_RUN == \'true\'\n' \
		'smoke-image: the archive load runs under'
	mutant 'the archive download skipped on a real run, as before #868' \
		$'      - name: Download the archive\n        uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1\n        with:\n          name: release-image-oci\n          path: ${{ runner.temp }}/release-image\n\n      # The amd64' \
		$'      - name: Download the archive\n        if: env.DRY_RUN == \'true\'\n        uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1\n        with:\n          name: release-image-oci\n          path: ${{ runner.temp }}/release-image\n\n      # The amd64' \
		'smoke-image: the archive load is not right after an unconditional release-image-oci download'
	mutant 'the archive loaded without its content checks (#680)' \
		'          echo "${DIGEST#sha256:}  $(blob "$DIGEST")" | sha256sum -c -' '          true' \
		'smoke-image: the archive load does not check the archive, then the index'
	mutant 'the archive checked against a digest from somewhere else (#680)' \
		$'          ARCHIVE_SHA256: ${{ needs.build-image.outputs.archive_sha256 }}\n        run: |\n          set -euo pipefail\n          export LC_ALL=C\n          [[ "$DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "::error::build-image reported no image digest"; exit 1; }\n          [[ "$ARCHIVE_SHA256" =~ ^[0-9a-f]{64}$ ]] || { echo "::error::build-image reported no archive digest"; exit 1; }\n          dir=' \
		$'          ARCHIVE_SHA256: ${{ vars.ARCHIVE_SHA256 }}\n        run: |\n          set -euo pipefail\n          export LC_ALL=C\n          [[ "$DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "::error::build-image reported no image digest"; exit 1; }\n          [[ "$ARCHIVE_SHA256" =~ ^[0-9a-f]{64}$ ]] || { echo "::error::build-image reported no archive digest"; exit 1; }\n          dir=' \
		'smoke-image: the archive load does not take DIGEST and ARCHIVE_SHA256'
	mutant 'a step between the archive download and its checks (#680)' \
		'      - name: Load the image from its archive' $'      - run: ls "$RUNNER_TEMP"\n      - name: Load the image from its archive' \
		'smoke-image: the archive load is not right after'
	mutant 'the smoke test switched off on its own (#680)' \
		$'      - name: Smoke-test the image (run it like a user does)\n' $'      - name: Smoke-test the image (run it like a user does)\n        if: env.DRY_RUN == \'true\'\n' \
		'smoke-image: the smoke test can be skipped'
	mutant 'the smoke test run before the image is in place (#680)' \
		'      - name: Load the image from its archive' $'      - run: ./.github/scripts/docker-smoke.sh "$GATE_IMAGE_TAG"\n      - name: Load the image from its archive' \
		'smoke-image: smokes before the image is loaded'
	mutant 'the smoke job not waiting for build-image (#680)' \
		'    needs: [validate-tag, build-image]' '    needs: [validate-tag, test]' \
		'smoke-image: does not list build-image in needs'
	mutant 'the push rehearsal skipped on a real run (#868)' \
		$'      - name: Rehearse the push by digest and the tagging\n' $'      - name: Rehearse the push by digest and the tagging\n        if: env.DRY_RUN == \'true\'\n' \
		'smoke-image: the push rehearsal can be skipped'
	mutant 'the push rehearsal allowed to fail (#868)' \
		$'      - name: Rehearse the push by digest and the tagging\n' $'      - name: Rehearse the push by digest and the tagging\n        continue-on-error: true\n' \
		'smoke-image: the push rehearsal can be skipped or allowed to fail'
	mutant 'the push rehearsal pointed at GHCR (#868)' \
		'          REGISTRY: 127.0.0.1:5000' '          REGISTRY: ghcr.io' \
		'smoke-image: the push rehearsal env must be exactly'
	mutant 'the push rehearsal fed a digest of its own (#868)' \
		$'          REGISTRY: 127.0.0.1:5000\n          DIGEST: ${{ needs.build-image.outputs.digest }}' $'          REGISTRY: 127.0.0.1:5000\n          DIGEST: ${{ vars.REHEARSAL_DIGEST }}' \
		'smoke-image: the push rehearsal env must be exactly'
	mutant 'the push rehearsal running a script other than the publish one (#868)' \
		'        run: *push-release-image' $'        run: |\n          echo pushed' \
		'publish-docker: the rehearsal and the publish run different scripts'
	mutant 'the throwaway registry on every interface (#868)' \
		'-p 127.0.0.1:5000:5000 "$REHEARSAL_REGISTRY_IMAGE"' '-p 5000:5000 "$REHEARSAL_REGISTRY_IMAGE"' \
		'smoke-image: the throwaway registry is not bound to 127.0.0.1:5000 alone'
	mutant 'the throwaway registry by tag alone (#868)' \
		'  REHEARSAL_REGISTRY_IMAGE: registry:3.1.2@sha256:ddf754342cfc8acc51a56d5d0ab6af06826461864460636d8bd5c546dab2a7b8' '  REHEARSAL_REGISTRY_IMAGE: registry:3' \
		'REHEARSAL_REGISTRY_IMAGE is not pinned by tag and digest'
	# publish-docker: after the approval chain, by digest, the rehearsed script.
	mutant 'publish-docker pushing before the approval chain (#680)' \
		'    needs: [validate-tag, build-image, smoke-image, sidecar, publish-brain]' '    needs: [validate-tag, build-image, smoke-image]' \
		'publish-docker: does not list publish-brain in needs'
	mutant 'publish-docker not waiting for the smoke test (#680)' \
		'    needs: [validate-tag, build-image, smoke-image, sidecar, publish-brain]' '    needs: [validate-tag, build-image, sidecar, publish-brain]' \
		'publish-docker: does not list smoke-image in needs'
	mutant 'the push job allowed to run after a failed smoke test (#680)' \
		$'  publish-docker:\n    needs: [validate-tag, build-image, smoke-image, sidecar, publish-brain]\n' $'  publish-docker:\n    needs: [validate-tag, build-image, smoke-image, sidecar, publish-brain]\n    if: ${{ !cancelled() && needs.build-image.result == \'success\' }}\n' \
		'publish-docker: can run after a failed gate'
	mutant 'publish-docker given contents: write as well (#680)' \
		$'    permissions:\n      packages: write\n' $'    permissions:\n      contents: write\n      packages: write\n' \
		'publish-docker: permissions must be exactly packages: write'
	mutant 'a checkout in the push job, which builds nothing (#680)' \
		'      # Only when something will be pushed (#682). skopeo reads the' $'      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n        with:\n          persist-credentials: false\n      # Only when something will be pushed (#682). skopeo reads the' \
		'publish-docker: checks out or sets up a builder'
	mutant 'a builder set up in the push job (#680)' \
		'      # Outside the workspace, though nothing here is checked out. Before the' $'      - uses: docker/setup-buildx-action@f87e5991a6d7451dcb8d9637bfbc97413f497069 # v4.4.1\n      # Outside the workspace, though nothing here is checked out. Before the' \
		'publish-docker: checks out or sets up a builder'
	mutant 'the push step pushing on a dry run (#868)' \
		$'      - name: Push the smoked archive by digest and tag it\n        if: env.DRY_RUN != \'true\'\n' $'      - name: Push the smoked archive by digest and tag it\n' \
		'publish-docker: the push step must run under exactly'
	mutant 'the push step switched off on a real run (#868)' \
		$'      - name: Push the smoked archive by digest and tag it\n        if: env.DRY_RUN != \'true\'\n' $'      - name: Push the smoked archive by digest and tag it\n        if: env.DRY_RUN == \'true\'\n' \
		'publish-docker: the push step must run under exactly'
	mutant 'the push step allowed to fail (#868)' \
		$'      - name: Push the smoked archive by digest and tag it\n        if: env.DRY_RUN != \'true\'\n' $'      - name: Push the smoked archive by digest and tag it\n        if: env.DRY_RUN != \'true\'\n        continue-on-error: true\n' \
		'publish-docker: the push step must run under exactly'
	mutant 'the push sent to a registry other than GHCR (#868)' \
		'          REGISTRY: ghcr.io' '          REGISTRY: ghcr.io.example.com' \
		'publish-docker: the push step env must be exactly'
	mutant 'the push taking its digest from the smoke job (#680)' \
		$'          REGISTRY: ghcr.io\n          DIGEST: ${{ needs.build-image.outputs.digest }}' $'          REGISTRY: ghcr.io\n          DIGEST: ${{ needs.smoke-image.outputs.digest }}' \
		'publish-docker: the push step env must be exactly'
	mutant 'the push reading an archive it never downloaded (#868)' \
		$'      - name: Download the archive\n        if: env.DRY_RUN != \'true\'\n' $'      - name: Download the archive\n        if: env.DRY_RUN == \'true\'\n' \
		'publish-docker: steps must be exactly'
	mutant 'skopeo free to convert, changing the digest (#868)' \
		'skopeo copy --all --preserve-digests --retry-times 3' 'skopeo copy --all --retry-times 3' \
		'publish-docker: skopeo copy must be exactly'
	mutant 'skopeo pushing one platform only (#868)' \
		'skopeo copy --all --preserve-digests --retry-times 3' 'skopeo copy --preserve-digests --retry-times 3' \
		'publish-docker: skopeo copy must be exactly'
	mutant 'skopeo pushing to a tag instead of the digest (#868)' \
		'"docker://${image}@${DIGEST}"' '"docker://${image}:latest"' \
		'publish-docker: skopeo copy must be exactly'
	mutant 'the archive pushed without its check (#868)' \
		$'          echo "${ARCHIVE_SHA256}  ${archive}" | sha256sum -c -\n' $'          true\n' \
		'publish-docker: the push script does not check the archive before skopeo'
	mutant 'the tags created from a tag rather than the pushed digest (#680)' \
		'docker buildx imagetools create "${args[@]}" "${image}@${DIGEST}"' 'docker buildx imagetools create "${args[@]}" "${image}:edge"' \
		'publish-docker: imagetools create does not take its source as'
	mutant 'the tags moved with no read-back first (#680)' \
		'planned="$(docker buildx imagetools create --dry-run "${args[@]}" "${image}@${DIGEST}")"' 'planned="index"' \
		'publish-docker: no imagetools create --dry-run'
	mutant 'the tag check aimed at the push registry, so the rehearsal checks other names (#868)' \
		'          owned="ghcr.io/${GITHUB_REPOSITORY,,}"' '          owned="${REGISTRY}/${GITHUB_REPOSITORY,,}"' \
		'publish-docker: the push script does not derive image from REGISTRY and check tags against ghcr.io'
	mutant 'a second registry write in the push script (#868)' \
		'          args=()' $'          docker push "${image}:latest"\n          args=()' \
		'publish-docker: the push script writes to the registry other than by'
	mutant 'docker manifest push from the smoke job (#868 review)' \
		'      - name: Remove the image tag and the registry this job started' $'      - run: docker manifest push ghcr.io/o/r:latest\n      - name: Remove the image tag and the registry this job started' \
		'smoke-image: writes to a registry from a run: step'
	mutant 'skopeo with a global flag before copy, in the smoke job (#868 review)' \
		'      - name: Remove the image tag and the registry this job started' $'      - run: skopeo --debug copy oci-archive:x docker://ghcr.io/o/r:latest\n      - name: Remove the image tag and the registry this job started' \
		'smoke-image: writes to a registry from a run: step'
	mutant 'docker push behind --config, in the smoke job (#868 review)' \
		'      - name: Remove the image tag and the registry this job started' $'      - run: docker --config /tmp/c push ghcr.io/o/r:latest\n      - name: Remove the image tag and the registry this job started' \
		'smoke-image: writes to a registry from a run: step'
	mutant 'a raw registry API PUT from the build job (#868 review)' \
		'      - name: Upload the archive' $'      - run: curl -fsS -X PUT --data-binary @m.json https://ghcr.io/v2/o/r/manifests/latest\n      - name: Upload the archive' \
		'build-image: writes to a registry from a run: step'
	mutant 'a push action in the smoke job (#868 review)' \
		'      - name: Remove the image tag and the registry this job started' $'      - uses: redhat-actions/push-to-registry@5ed88d269cf581ea9ef6dd6806d01562096bee9c\n      - name: Remove the image tag and the registry this job started' \
		'smoke-image: uses redhat-actions/push-to-registry'
	mutant 'a second registry write after the push step in publish-docker (#868 review)' \
		$'      - name: Dry-run summary\n        if: env.DRY_RUN == \'true\'\n        env:\n          DIGEST:' $'      - run: skopeo --debug copy oci-archive:x docker://ghcr.io/o/r:latest\n      - name: Dry-run summary\n        if: env.DRY_RUN == \'true\'\n        env:\n          DIGEST:' \
		'publish-docker: steps must be exactly'
	mutant 'the credential written before the artifact is unpacked again (#868 review)' \
		$'      - name: Verify the archive\n        if: env.DRY_RUN != \'true\'\n' $'      - name: Log in again\n        uses: docker/login-action@dbcb813823bdd20940b903addbd779551569679f # v4.6.0\n      - name: Verify the archive\n        if: env.DRY_RUN != \'true\'\n' \
		'publish-docker: steps must be exactly'
	mutant 'the archive check before the login switched off (#868 review)' \
		$'      - name: Verify the archive\n        if: env.DRY_RUN != \'true\'\n' $'      - name: Verify the archive\n        if: false\n' \
		'publish-docker: steps must be exactly'
	mutant 'the GitHub Release no longer after the image push (#680)' \
		'    needs: [validate-tag, publish-docker, sidecar]' '    needs: [validate-tag, publish-brain, sidecar]' \
		'github-release: does not run after publish-docker'
	mutant 'the sidecar no longer gated on the smoke test (#680)' \
		'    needs: [test, smoke-image]' '    needs: [test, build-image]' \
		'sidecar: does not run after smoke-image'
	unset MUTANT_MODE
}

# The two scripts on this path, executed verbatim with docker and skopeo
# stubs that record their argv and answer what a registry would. (The same
# scripts ran against Docker 28.0.4, buildx 0.37.1, skopeo 1.13.3 and a real
# registry for #868; these keep their behaviour pinned.)
PUSH="$(yq step publish-docker 'Push the smoked archive by digest and tag it')" || PUSH=""
REHEARSE="$(yq step smoke-image 'Rehearse the push by digest and the tagging')" || REHEARSE=""
LOAD="$(yq step smoke-image 'Load the image from its archive')" || LOAD=""
if [ -z "$PUSH" ] || [ -z "$REHEARSE" ] || [ -z "$LOAD" ]; then
	no "found the publish-docker push step and the smoke-image rehearsal and load steps"
else
	if [ "$PUSH" = "$REHEARSE" ]; then ok "the rehearsal runs the publish script byte for byte"; else no "the rehearsal runs the publish script byte for byte"; fi
	mkdir -p "${WORK}/dbin"
	# docker stub: records each call; `imagetools inspect` answers
	# $STUB_INSPECT; `create --dry-run` prints $STUB_PLANNED (default
	# "index", which hashes to D1); `load -i x` computes the image ID docker
	# would (the sha256 of the config named in manifest.json) and `image
	# inspect` returns it, or $STUB_ID when set.
	cat >"${WORK}/dbin/docker" <<'EOF'
#!/usr/bin/env bash
printf 'docker %s\n' "$*" >>"$DOCKER_LOG"
if [ "$1 $2 $3" = "buildx imagetools inspect" ]; then printf '%s\n' "$STUB_INSPECT"; exit 0; fi
if [ "$1 $2 $3 $4" = "buildx imagetools create --dry-run" ]; then printf '%s\n' "${STUB_PLANNED-index}"; exit 0; fi
if [ "$1" = load ]; then
	t="$(mktemp -d)"
	tar -xf "$3" -C "$t" || exit 1
	cfg="$(jq -r '.[0].Config' "$t/manifest.json")" || exit 1
	printf 'sha256:%s\n' "$(sha256sum "$t/$cfg" | cut -d' ' -f1)" >"$DOCKER_STATE"
	exit 0
fi
if [ "$1 $2" = "image inspect" ]; then
	if [ -n "${STUB_ID:-}" ]; then printf '%s\n' "$STUB_ID"; else cat "$DOCKER_STATE"; fi
	exit 0
fi
exit 0
EOF
	# skopeo stub: records each call, and fails when STUB_SKOPEO_FAIL is set.
	cat >"${WORK}/dbin/skopeo" <<'EOF'
#!/usr/bin/env bash
printf 'skopeo %s\n' "$*" >>"$DOCKER_LOG"
[ -z "${STUB_SKOPEO_FAIL:-}" ]
EOF
	chmod +x "${WORK}/dbin/docker" "${WORK}/dbin/skopeo"
	D1="sha256:$(printf 'index' | sha256sum | cut -d' ' -f1)"
	rm -rf "${WORK}/prt" "${WORK}/ptar" && mkdir -p "${WORK}/prt/release-image" "${WORK}/ptar/blobs/sha256"
	printf 'layout' >"${WORK}/ptar/oci-layout" && printf 'index' >"${WORK}/ptar/index.json"
	tar -cf "${WORK}/prt/release-image/release-image.oci.tar" -C "${WORK}/ptar" oci-layout index.json blobs
	cp "${WORK}/prt/release-image/release-image.oci.tar" "${WORK}/ptar.tar"
	PARC="$(sha256sum "${WORK}/prt/release-image/release-image.oci.tar" | cut -d' ' -f1)"
	# pushrun <want 0|1> <label> <registry> <version> <prerelease> <tags> [digest] [inspect answer]
	pushrun() {
		local want="$1" label="$2"
		: >"${WORK}/docker.log"
		(cd "$WORK" && env -i PATH="${WORK}/dbin:$PATH" DOCKER_LOG="${WORK}/docker.log" GITHUB_REPOSITORY=Vierisid/Jarvis \
			RUNNER_TEMP="${WORK}/prt" ARCHIVE_SHA256="${PUSH_ARC-$PARC}" REGISTRY="$3" \
			VERSION="$4" PRERELEASE="$5" TAGS="$6" DIGEST="${7-$D1}" STUB_INSPECT="${8-\"${7-$D1}\"}" \
			${STUB_PLANNED+STUB_PLANNED="$STUB_PLANNED"} ${STUB_SKOPEO_FAIL+STUB_SKOPEO_FAIL=1} \
			bash -e -c "$PUSH") >"${WORK}/pub.out" 2>&1
		local rc=$?
		if { [ "$want" = 0 ] && [ "$rc" -eq 0 ]; } || { [ "$want" != 0 ] && [ "$rc" -ne 0 ]; }; then
			ok "push script: $label"
		else
			no "push script: $label" "exit ${rc}: $(cat "${WORK}/pub.out")
calls: $(cat "${WORK}/docker.log")"
		fi
	}
	# writes: the registry writes the last run made (skopeo copy and tag creation).
	writes() { grep -cE '^(skopeo copy|docker buildx imagetools create -t)' "${WORK}/docker.log"; }
	I=ghcr.io/vierisid/jarvis
	REL_TAGS="$(printf '%s\n' "$I:1.2.3" "$I:1.2" "$I:latest")"
	pushrun 0 "pushes and tags a release on GHCR" ghcr.io 1.2.3 false "$REL_TAGS"
	if [ "$(sed -n 2p "${WORK}/docker.log")" = "skopeo copy --all --preserve-digests --retry-times 3 oci-archive:${WORK}/prt/release-image/release-image.oci.tar docker://$I@$D1" ] &&
		[ "$(sed -n 3p "${WORK}/docker.log")" = "docker buildx imagetools create --dry-run -t $I:1.2.3 -t $I:1.2 -t $I:latest $I@$D1" ] &&
		[ "$(sed -n 4p "${WORK}/docker.log")" = "docker buildx imagetools create -t $I:1.2.3 -t $I:1.2 -t $I:latest $I@$D1" ] &&
		[ "$(grep -c '^docker buildx imagetools inspect' "${WORK}/docker.log")" = 3 ]; then
		ok "push script: pushes the archive to ${I}@<digest>, reads it back, creates exactly the three tags from it, then checks each one"
	else
		no "push script: pushes the archive by digest, reads it back, creates the three tags, then checks each one" "$(cat "${WORK}/docker.log")"
	fi
	# What metadata-action really emits for a release: latest TWICE, once
	# from the semver flavor and once from the raw latest rule (the v0.15.0
	# publish-docker log, run 36728949586, lists ghcr.io/vierisid/jarvis:latest
	# on two lines). The tag set is what counts, and each tag is created once.
	pushrun 0 "accepts the tags metadata-action emits for a release, latest listed twice" ghcr.io 1.2.3 false "$(printf '%s\n' "$I:1.2.3" "$I:1.2" "$I:latest" "$I:latest")"
	if [ "$(sed -n 4p "${WORK}/docker.log")" = "docker buildx imagetools create -t $I:1.2.3 -t $I:1.2 -t $I:latest $I@$D1" ]; then
		ok "push script: creates each of those tags once"
	else
		no "push script: creates each of those tags once" "$(cat "${WORK}/docker.log")"
	fi
	# The rehearsal: the same GHCR tag names checked, written to loopback.
	R=127.0.0.1:5000/vierisid/jarvis
	pushrun 0 "rehearses on loopback: checks the GHCR tag names, writes only to the loopback registry" 127.0.0.1:5000 1.2.3 false "$REL_TAGS"
	if [ "$(sed -n 2p "${WORK}/docker.log")" = "skopeo copy --all --preserve-digests --retry-times 3 oci-archive:${WORK}/prt/release-image/release-image.oci.tar docker://$R@$D1" ] &&
		[ "$(sed -n 4p "${WORK}/docker.log")" = "docker buildx imagetools create -t $R:1.2.3 -t $R:1.2 -t $R:latest $R@$D1" ] &&
		! grep -q 'ghcr\.io' "${WORK}/docker.log"; then
		ok "push script: the rehearsal names nothing on ghcr.io"
	else
		no "push script: the rehearsal names nothing on ghcr.io" "$(cat "${WORK}/docker.log")"
	fi
	pushrun 1 "refuses loopback tag names, so a rehearsal checks what a release would" 127.0.0.1:5000 1.2.3 false "$(printf '%s\n' "$R:1.2.3" "$R:1.2" "$R:latest")"
	pushrun 0 "tags a prerelease with its version only" ghcr.io 1.2.3-rc.1 true "$I:1.2.3-rc.1"
	pushrun 1 "refuses latest on a prerelease" ghcr.io 1.2.3-rc.1 true "$(printf '%s\n' "$I:1.2.3-rc.1" "$I:latest")"
	if [ "$(writes)" = 0 ]; then ok "push script: pushes nothing when the tags are wrong"; else no "push script: pushes nothing when the tags are wrong" "$(cat "${WORK}/docker.log")"; fi
	pushrun 1 "refuses a tag on another image" ghcr.io 1.2.3 false "$(printf '%s\n' "$I:1.2.3" "$I:1.2" "ghcr.io/evil/jarvis:latest")"
	pushrun 1 "refuses a missing tag" ghcr.io 1.2.3 false "$(printf '%s\n' "$I:1.2.3" "$I:1.2")"
	pushrun 1 "refuses an empty digest" ghcr.io 1.2.3 false "$REL_TAGS" ""
	if [ ! -s "${WORK}/docker.log" ]; then ok "push script: nothing reaches docker or skopeo once the digest is refused"; else no "push script: nothing reaches docker or skopeo once the digest is refused" "$(cat "${WORK}/docker.log")"; fi
	pushrun 1 "refuses a digest that is not sha256" ghcr.io 1.2.3 false "$REL_TAGS" "sha256:abc"
	PUSH_ARC="" pushrun 1 "refuses an empty archive digest" ghcr.io 1.2.3 false "$REL_TAGS"
	PUSH_ARC="$(printf 'other' | sha256sum | cut -d' ' -f1)" pushrun 1 "refuses an archive other than the one build-image hashed" ghcr.io 1.2.3 false "$REL_TAGS"
	if [ ! -s "${WORK}/docker.log" ]; then ok "push script: nothing is pushed from a refused archive"; else no "push script: nothing is pushed from a refused archive" "$(cat "${WORK}/docker.log")"; fi
	STUB_SKOPEO_FAIL=1 pushrun 1 "stops when skopeo cannot push by that digest" ghcr.io 1.2.3 false "$REL_TAGS"
	if ! grep -q '^docker buildx imagetools create' "${WORK}/docker.log"; then ok "push script: no tag is attempted after a failed push"; else no "push script: no tag is attempted after a failed push" "$(cat "${WORK}/docker.log")"; fi
	# The archive entry allowlist, against real tar files.
	mkdir -p "${WORK}/tarx/blobs/sha256" && printf x >"${WORK}/tarx/oci-layout" && printf x >"${WORK}/tarx/index.json"
	printf b >"${WORK}/tarx/blobs/sha256/$(printf b | sha256sum | cut -d' ' -f1)"
	tar -cf "${WORK}/prt/release-image/release-image.oci.tar" -C "${WORK}/tarx" oci-layout index.json blobs
	PUSH_ARC="$(sha256sum "${WORK}/prt/release-image/release-image.oci.tar" | cut -d' ' -f1)" pushrun 0 "accepts an archive of only OCI layout entries" ghcr.io 1.2.3 false "$REL_TAGS"
	ln -s /home "${WORK}/tarx/blobs/sha256/$(printf c | sha256sum | cut -d' ' -f1)"
	tar -cf "${WORK}/prt/release-image/release-image.oci.tar" -C "${WORK}/tarx" oci-layout index.json blobs
	PUSH_ARC="$(sha256sum "${WORK}/prt/release-image/release-image.oci.tar" | cut -d' ' -f1)" pushrun 1 "refuses an archive holding a symlink" ghcr.io 1.2.3 false "$REL_TAGS"
	if [ "$(writes)" = 0 ]; then ok "push script: nothing is pushed from an archive holding a symlink"; else no "push script: nothing is pushed from an archive holding a symlink" "$(cat "${WORK}/docker.log")"; fi
	rm "${WORK}/tarx/blobs/sha256/$(printf c | sha256sum | cut -d' ' -f1)" && printf e >"${WORK}/tarx/evil"
	tar -cf "${WORK}/prt/release-image/release-image.oci.tar" -C "${WORK}/tarx" oci-layout index.json blobs evil
	PUSH_ARC="$(sha256sum "${WORK}/prt/release-image/release-image.oci.tar" | cut -d' ' -f1)" pushrun 1 "refuses an archive holding a file outside the OCI layout" ghcr.io 1.2.3 false "$REL_TAGS"
	# The bad entry first, then more than 64 KiB of valid names behind it:
	# a check that pipes into grep -q under pipefail passes these (#868
	# re-review), so each must still be refused.
	rm -rf "${WORK}/tarbig" && mkdir -p "${WORK}/tarbig/blobs/sha256" && printf x >"${WORK}/tarbig/oci-layout" && printf x >"${WORK}/tarbig/index.json"
	for i in $(seq 1 1500); do : >"${WORK}/tarbig/blobs/sha256/$(printf '%064d' "$i")"; done
	ls "${WORK}/tarbig/blobs/sha256" | sed 's#^#blobs/sha256/#' >"${WORK}/tarbig.list"
	printf e >"${WORK}/tarbig/notallowed"
	tar -cf "${WORK}/prt/release-image/release-image.oci.tar" -C "${WORK}/tarbig" notallowed oci-layout index.json -T "${WORK}/tarbig.list"
	tar -tf "${WORK}/prt/release-image/release-image.oci.tar" | wc -c >"${WORK}/tarbig.size"
	PUSH_ARC="$(sha256sum "${WORK}/prt/release-image/release-image.oci.tar" | cut -d' ' -f1)" pushrun 1 "refuses a stray file listed first, ahead of $(cat "${WORK}/tarbig.size") bytes of valid names" ghcr.io 1.2.3 false "$REL_TAGS"
	rm "${WORK}/tarbig/notallowed" && ln -s /home "${WORK}/tarbig/blobs/sha256/$(printf '%064d' 0)"
	tar -cf "${WORK}/prt/release-image/release-image.oci.tar" -C "${WORK}/tarbig" "blobs/sha256/$(printf '%064d' 0)" oci-layout index.json -T "${WORK}/tarbig.list"
	PUSH_ARC="$(sha256sum "${WORK}/prt/release-image/release-image.oci.tar" | cut -d' ' -f1)" pushrun 1 "refuses a symlink listed first, ahead of thousands of valid entries" ghcr.io 1.2.3 false "$REL_TAGS"
	if [ "$(writes)" = 0 ]; then ok "push script: nothing is pushed from either"; else no "push script: nothing is pushed from either" "$(cat "${WORK}/docker.log")"; fi
	rm -rf "${WORK}/tarbig" "${WORK}/tarbig.list" "${WORK}/tarbig.size"
	cp "${WORK}/ptar.tar" "${WORK}/prt/release-image/release-image.oci.tar"
	rm -rf "${WORK}/tarx"
	pushrun 1 "refuses a tag that came out pointing elsewhere" ghcr.io 1.2.3 false "$REL_TAGS" "$D1" "\"sha256:$(printf 'other' | sha256sum | cut -d' ' -f1)\""
	STUB_PLANNED='{"re-serialised":true}' pushrun 1 "refuses before tagging when the index read back is not the archive one" ghcr.io 1.2.3 false "$REL_TAGS"
	if [ "$(grep -c '^docker buildx imagetools create -t' "${WORK}/docker.log")" = 0 ]; then
		ok "push script: moves no tag when the index read back is not the archive one"
	else
		no "push script: moves no tag when the index read back is not the archive one" "$(cat "${WORK}/docker.log")"
	fi

	# The archive load, against a hand-built two-platform OCI layout.
	# make_layout [amd64 count] [layer digest]: writes ${WORK}/oci/release-image.oci.tar and
	# sets IDX (the index digest), CFG (the amd64 config digest), ARC (the
	# archive sha256).
	make_layout() {
		local n="${1:-1}" L="${WORK}/oci/l"
		rm -rf "${WORK}/oci" && mkdir -p "$L/blobs/sha256"
		put() { local h; h="$(printf '%s' "$1" | sha256sum | cut -d' ' -f1)"; printf '%s' "$1" >"$L/blobs/sha256/$h"; printf 'sha256:%s' "$h"; }
		local layer cfg man arm i entries=""
		layer="${2:-$(put 'layer bytes')}"
		cfg="$(put '{"architecture":"amd64","os":"linux","rootfs":{"type":"layers","diff_ids":[]}}')"
		man="$(put "{\"schemaVersion\":2,\"config\":{\"digest\":\"$cfg\"},\"layers\":[{\"digest\":\"$layer\"}]}")"
		arm="$(put "{\"schemaVersion\":2,\"config\":{\"digest\":\"$cfg\"},\"layers\":[]}")"
		for i in $(seq 1 "$n"); do entries+="{\"digest\":\"$man\",\"platform\":{\"os\":\"linux\",\"architecture\":\"amd64\"}},"; done
		IDX="$(put "{\"schemaVersion\":2,\"manifests\":[${entries}{\"digest\":\"$arm\",\"platform\":{\"os\":\"linux\",\"architecture\":\"arm64\"}}]}")"
		CFG="$cfg"
		printf '{"manifests":[{"digest":"%s"}]}' "$IDX" >"$L/index.json"
		tar -cf "${WORK}/oci/release-image.oci.tar" -C "$L" index.json blobs
		ARC="$(sha256sum "${WORK}/oci/release-image.oci.tar" | cut -d' ' -f1)"
	}
	# run_load <want 0|1> <label> [STUB_ID]
	run_load() {
		local want="$1" label="$2"
		rm -rf "${WORK}/rt" && mkdir -p "${WORK}/rt/release-image"
		cp "${WORK}/oci/release-image.oci.tar" "${WORK}/rt/release-image/"
		: >"${WORK}/docker.log"
		(cd "$WORK" && env -i PATH="${WORK}/dbin:$PATH" DOCKER_LOG="${WORK}/docker.log" DOCKER_STATE="${WORK}/docker.state" \
			RUNNER_TEMP="${WORK}/rt" DIGEST="$IDX" ARCHIVE_SHA256="$ARC" GATE_IMAGE_TAG=jarvis:gate STUB_ID="${3:-}" \
			bash -e -c "$LOAD") >"${WORK}/load.out" 2>&1
		local rc=$?
		if { [ "$want" = 0 ] && [ "$rc" -eq 0 ]; } || { [ "$want" != 0 ] && [ "$rc" -ne 0 ]; }; then
			ok "smoke-image load: $label"
		else
			no "smoke-image load: $label" "exit ${rc}: $(cat "${WORK}/load.out")"
		fi
	}
	make_layout
	run_load 0 "loads the amd64 image of the reported index"
	if grep -q '^docker load -i ' "${WORK}/docker.log" && [ "$(cat "${WORK}/docker.state")" = "$CFG" ]; then
		ok "smoke-image load: what reaches docker load is exactly the amd64 config of that index"
	else
		no "smoke-image load: what reaches docker load is exactly the amd64 config of that index" "$(cat "${WORK}/docker.log")"
	fi
	# The rehearsal after it reads the archive, so the load must leave it.
	if cmp -s "${WORK}/oci/release-image.oci.tar" "${WORK}/rt/release-image/release-image.oci.tar"; then
		ok "smoke-image load: leaves the archive in place for the push rehearsal"
	else
		no "smoke-image load: leaves the archive in place for the push rehearsal"
	fi
	make_layout
	ARC="$(printf 'other' | sha256sum | cut -d' ' -f1)"
	run_load 1 "refuses an archive other than the one build-image hashed"
	if ! grep -q '^docker load' "${WORK}/docker.log"; then ok "smoke-image load: nothing is loaded from a refused archive"; else no "smoke-image load: nothing is loaded from a refused archive"; fi
	make_layout
	IDX="sha256:$(printf 'not the index' | sha256sum | cut -d' ' -f1)"
	run_load 1 "refuses an archive without the reported index"
	make_layout 2
	run_load 1 "refuses an index with two amd64 images"
	make_layout
	run_load 1 "refuses a loaded image that is not the amd64 config" "sha256:$(printf 'x' | sha256sum | cut -d' ' -f1)"
	make_layout
	ARC=""
	run_load 1 "refuses an empty archive digest"
	# A tampered blob inside an archive whose outer digest was recomputed to
	# match: the archive check passes, the content checks must not.
	make_layout
	m_blob="$(find "${WORK}/oci/l/blobs/sha256" -type f -exec grep -l '"layers":\[{' {} +)"
	printf '%s' '{"schemaVersion":2,"config":{"digest":"sha256:0000000000000000000000000000000000000000000000000000000000000000"},"layers":[]}' >"$m_blob"
	tar -cf "${WORK}/oci/release-image.oci.tar" -C "${WORK}/oci/l" index.json blobs
	ARC="$(sha256sum "${WORK}/oci/release-image.oci.tar" | cut -d' ' -f1)"
	run_load 1 "refuses a manifest blob swapped inside a re-hashed archive"
	# A layer named by a path rather than a digest, which resolves to a file
	# that exists in the layout: only the digest-format check stops it.
	make_layout 1 'sha256:../../index.json'
	run_load 1 "refuses a manifest whose layer is a path, not a digest"
	if grep -qF "names a config or layer that is not a sha256 digest" "${WORK}/load.out"; then
		ok "smoke-image load: says why it refused the path"
	else
		no "smoke-image load: says why it refused the path" "$(cat "${WORK}/load.out")"
	fi
	# A stray entry first, ahead of more than 64 KiB of valid names, refused
	# before this job unpacks anything (#868 review).
	make_layout
	for i in $(seq 1 1500); do : >"${WORK}/oci/l/blobs/sha256/$(printf '%064d' "$i")"; done
	printf e >"${WORK}/oci/l/zz-stray"
	(cd "${WORK}/oci/l" && tar -cf "${WORK}/oci/release-image.oci.tar" zz-stray index.json blobs)
	ARC="$(sha256sum "${WORK}/oci/release-image.oci.tar" | cut -d' ' -f1)"
	run_load 1 "refuses a stray entry listed first, ahead of thousands of valid ones"
	if [ ! -d "${WORK}/rt/release-image/layout" ]; then ok "smoke-image load: unpacks nothing from that archive"; else no "smoke-image load: unpacks nothing from that archive"; fi
fi
# The standalone archive check publish-docker runs before its login, verbatim.
PVERIFY="$(yq step publish-docker 'Verify the archive')" || PVERIFY=""
if [ -z "$PVERIFY" ]; then
	no "found publish-docker's Verify the archive step"
else
	pv_case() {
		local label="$1" want="$2"
		shift 2
		(cd "$WORK" && env -i PATH="$PATH" "$@" bash -e -c "$PVERIFY") >"${WORK}/pv.log" 2>&1
		local rc=$?
		if { [ "$want" = 0 ] && [ "$rc" -eq 0 ]; } || { [ "$want" != 0 ] && [ "$rc" -ne 0 ]; }; then ok "$label"; else no "$label" "exit ${rc}: $(cat "${WORK}/pv.log")"; fi
	}
	rm -rf "${WORK}/pv" && mkdir -p "${WORK}/pv/release-image" && printf 'archive\n' >"${WORK}/pv/release-image/release-image.oci.tar"
	pvsum="$(sha256sum "${WORK}/pv/release-image/release-image.oci.tar" | cut -d' ' -f1)"
	pv_case "publish-docker verify: accepts the archive build-image hashed" 0 RUNNER_TEMP="${WORK}/pv" ARCHIVE_SHA256="$pvsum"
	pv_case "publish-docker verify: refuses an empty digest" 1 RUNNER_TEMP="${WORK}/pv" ARCHIVE_SHA256=
	printf x >"${WORK}/pv/release-image/extra"
	pv_case "publish-docker verify: refuses an artifact carrying anything else" 1 RUNNER_TEMP="${WORK}/pv" ARCHIVE_SHA256="$pvsum"
	rm "${WORK}/pv/release-image/extra" && printf 'swapped\n' >"${WORK}/pv/release-image/release-image.oci.tar"
	pv_case "publish-docker verify: refuses an archive replaced after build-image hashed it" 1 RUNNER_TEMP="${WORK}/pv" ARCHIVE_SHA256="$pvsum"
fi

echo
echo "one dry-run decision, evaluated, in the three release workflows (#685, #869)"
SIDECAR_WORKFLOW="${SIDECAR_RELEASE_WORKFLOW:-${HERE}/../workflows/sidecar-release.yml}"
INSTALLER_WORKFLOW="${INSTALLER_RELEASE_WORKFLOW:-${HERE}/../workflows/installer-release.yml}"
for f in "$WORKFLOW" "$SIDECAR_WORKFLOW" "$INSTALLER_WORKFLOW"; do
	found="$(YQ_FILE="$f" yq dry-run)" || {
		no "$(basename "$f"): dry-run check ran" "the bun helper failed"
		continue
	}
	if [ -z "$found" ]; then
		ok "$(basename "$f"): every dry-run site reads inputs.dry_run == true and they agree on a push, a real dispatch and a dry dispatch"
	else
		no "$(basename "$f"): one dry-run decision" "$found"
	fi
done
# The evaluator against what GitHub gives (expression docs: mixed types
# compare as numbers, strings case-insensitively, && and || return an
# operand, ! binds tighter than ==). If it were wrong, the agreement check
# above could pass sites that disagree on GitHub.
# shellcheck disable=SC2016 # GitHub expressions, not shell.
for c in \
	'${{ inputs.dry_run == true }}@@null@@false' \
	'${{ inputs.dry_run == false }}@@null@@true' \
	'${{ inputs.dry_run == true }}@@true@@true' \
	"\${{ inputs.dry_run == 'true' }}@@true@@false" \
	"\${{ 'Release' == 'release' }}@@null@@true" \
	"\${{ inputs.dry_run && 'release-dry-run' || 'release' }}@@null@@\"release\"" \
	"\${{ inputs.dry_run && 'release-dry-run' || 'release' }}@@true@@\"release-dry-run\"" \
	'${{ !inputs.dry_run }}@@null@@true' \
	"\${{ !inputs.dry_run == 'release' }}@@false@@false" \
	'${{ !(inputs.dry_run == true) }}@@true@@false' \
	'${{ inputs.dry_run || false }}@@null@@false'; do
	expr="${c%%@@*}"
	rest="${c#*@@}"
	value="${rest%%@@*}"
	want="${rest#*@@}"
	got="$(EVAL_EXPR="$expr" EVAL_VALUE="$value" YQ_FILE="$WORKFLOW" yq dry-run)"
	if [ "$got" = "$want" ]; then
		ok "evaluator: ${expr} with dry_run=${value} is ${want}"
	else
		no "evaluator: ${expr} with dry_run=${value}" "got ${got}, GitHub gives ${want}"
	fi
done
# shellcheck disable=SC2016 # every mutant is literal workflow text.
{
	MUTANT_MODE=dry-run
	mutant 'discord-notify inverted, announcing only dry runs (#685)' \
		'    if: ${{ inputs.dry_run != true }}' '    if: ${{ inputs.dry_run }}'
	mutant 'DRY_RUN compared with the string, so a dry dispatch publishes (#685)' \
		'  DRY_RUN: ${{ inputs.dry_run == true }}' "  DRY_RUN: \${{ inputs.dry_run == 'true' }}"
	mutant 'the sidecar told a constant instead of the input (#685)' \
		'      dry_run: ${{ inputs.dry_run == true }}' '      dry_run: ${{ false }}'
	mutant 'the sidecar dry-run input dropped, so it defaults to a real publish (#685)' \
		$'    with:\n      dry_run: ${{ inputs.dry_run == true }}\n' ''
	mutant 'a real-run environment on a dry dispatch (#685)' \
		"      name: \${{ inputs.dry_run == true && 'release-dry-run' || 'release' }}" "      name: \${{ inputs.dry_run == false && 'release-dry-run' || 'release' }}"
	mutant 'an equivalent but second spelling of the decision (#685)' \
		'    if: ${{ inputs.dry_run != true }}' '    if: ${{ !inputs.dry_run }}'
	mutant 'a step deciding dry run from the event payload (#685)' \
		$'      - name: Dry-run summary\n        if: env.DRY_RUN == \'true\'\n        env:\n          VERSION:' \
		$'      - name: Dry-run summary\n        if: github.event.inputs.dry_run == \'true\'\n        env:\n          VERSION:'
	mutant 'a step testing DRY_RUN for truthiness, which "false" passes (#685)' \
		$'      - name: Dry-run summary\n        if: env.DRY_RUN == \'true\'\n        env:\n          VERSION:' \
		$'      - name: Dry-run summary\n        if: env.DRY_RUN\n        env:\n          VERSION:'
	mutant 'a script testing DRY_RUN some other way (#685)' \
		'if [ "$DRY_RUN" = "true" ]; then flags+=(--dry-run); fi' 'if [ "$DRY_RUN" != false ]; then flags+=(--dry-run); fi'
	mutant 'a job redefining DRY_RUN (#685)' \
		'      GATE_IMAGE_TAG: jarvis:release-gate-' $'      DRY_RUN: "false"\n      GATE_IMAGE_TAG: jarvis:release-gate-'
	MUTANT_FROM="$SIDECAR_WORKFLOW"
	mutant 'sidecar-release.yml: the env decision loosened to truthiness (#685)' \
		'  DRY_RUN: ${{ inputs.dry_run == true }}' '  DRY_RUN: ${{ inputs.dry_run || false }}'
	mutant 'sidecar-release.yml: the environment name inverted (#685)' \
		"      name: \${{ inputs.dry_run == true && 'release-dry-run' || 'release' }}" "      name: \${{ inputs.dry_run != true && 'release-dry-run' || 'release' }}"
	MUTANT_FROM="$INSTALLER_WORKFLOW"
	mutant 'installer-release.yml: the signer told it is a dry run on its own (#869 review)' \
		$'  sign-windows:\n    needs: [resolve, build-windows]\n' $'  sign-windows:\n    needs: [resolve, build-windows]\n    env:\n      DRY_RUN: "true"\n' \
		'sign-windows: redefines DRY_RUN'
	mutant 'installer-release.yml: the env decision loosened to truthiness (#869 review)' \
		'  DRY_RUN: ${{ inputs.dry_run == true }}' '  DRY_RUN: ${{ inputs.dry_run || false }}' \
		'not the one spelling'
	unset MUTANT_MODE MUTANT_FROM
}

echo
echo "sidecar-release.yml and installer-release.yml: no \${{ }} inside run: (#684, #818)"
# The reusable sidecar workflow runs in the same release, and its publish job
# holds id-token too. Its versions come from sidecar/VERSION rather than the
# tag, so the gate above does not cover them; the structure rule does. The
# installer release reads sidecar/installer/VERSION the same way, and its
# publish job holds contents: write (#818).
SIDECAR_WORKFLOW="${SIDECAR_RELEASE_WORKFLOW:-${HERE}/../workflows/sidecar-release.yml}"
INSTALLER_WORKFLOW="${INSTALLER_RELEASE_WORKFLOW:-${HERE}/../workflows/installer-release.yml}"
for f in "$SIDECAR_WORKFLOW" "$INSTALLER_WORKFLOW"; do
	found="$(YQ_FILE="$f" yq run-expressions)" || {
		no "$(basename "$f") run-expression check ran" "the bun helper failed"
		found=""
	}
	if [ -z "$found" ]; then
		ok "$(basename "$f"): every run: takes its values through env:"
	else
		no "$(basename "$f"): every run: takes its values through env:" "$found"
	fi
done
# run_expression_mutant <file> <exact text> <replacement>
run_expression_mutant() {
	local copy="${WORK}/run-expression-mutant.yml"
	rm -f "$copy"
	# shellcheck disable=SC2016 # JavaScript source, not shell.
	FROM="$1" TO="$copy" OLD="$2" NEW="$3" bun -e '
const s = await Bun.file(process.env.FROM).text();
if (!s.includes(process.env.OLD)) process.exit(2);
await Bun.write(process.env.TO, s.replace(process.env.OLD, process.env.NEW));
' || no "the $(basename "$1") mutant could be applied (the workflow no longer has the text it mutates)"
	if [ -f "$copy" ] && [ -n "$(YQ_FILE="$copy" yq run-expressions)" ]; then
		ok "reports: a \${{ }} expression back inside a $(basename "$1") run:"
	else
		no "reports: a \${{ }} expression back inside a $(basename "$1") run:"
	fi
}
# shellcheck disable=SC2016 # literal workflow text, not shell.
{
	run_expression_mutant "$SIDECAR_WORKFLOW" \
		'npm version "${VERSION}" --no-git-tag-version --allow-same-version' \
		'npm version "${{ needs.resolve.outputs.version }}" --no-git-tag-version --allow-same-version'
	run_expression_mutant "$INSTALLER_WORKFLOW" \
		'echo "::notice::DRY RUN -- built and signed installer v${INSTALLER_VERSION} without publishing"' \
		'echo "::notice::DRY RUN -- built and signed installer v${{ needs.resolve.outputs.version }} without publishing"'
}

echo
echo "sidecar artifacts cross into publish-sidecar with their digests (#781)"
found="$(YQ_FILE="$SIDECAR_WORKFLOW" yq sidecar-digests)" || {
	no "sidecar digest structure check ran" "the bun helper failed"
	found=""
}
if [ -z "$found" ]; then
	ok "every build leg and the signer output a digest taken last, and publish-sidecar checks all five first"
else
	no "sidecar artifact digests" "$found"
fi
# shellcheck disable=SC2016 # every mutant is literal workflow text.
{
	MUTANT_MODE=sidecar-digests
	MUTANT_FROM="$SIDECAR_WORKFLOW"
	mutant 'publish-sidecar no longer checking the artifacts it publishes (#781)' \
		'      - name: Verify sidecar artifacts' $'      - run: ls artifacts\n      - name: Verify sidecar artifacts'
	mutant 'one leg left out of the check (#781)' \
		'          SHA_LINUX_ARM64: ${{ needs.build-sidecar-linux-arm64.outputs.sha256 }}' ''
	mutant 'two legs crossed over in the check (#781)' \
		'          SHA_LINUX_ARM64: ${{ needs.build-sidecar-linux-arm64.outputs.sha256 }}' '          SHA_LINUX_ARM64: ${{ needs.build-sidecar-linux-x64.outputs.sha256 }}'
	mutant 'the signed Windows binary unchecked (#781)' \
		'          SHA_WIN32_X64: ${{ needs.sign-sidecar-windows.outputs.sha256 }}' ''
	mutant 'two legs back in one matrix, sharing one outputs block (#781 review)' \
		$'            npm_pkg: linux-x64\n            runner: ubuntu-latest\n            setup: linux\n' \
		$'            npm_pkg: linux-x64\n            runner: ubuntu-latest\n            setup: linux\n          - goos: linux\n            goarch: arm64\n            npm_pkg: linux-arm64\n            runner: ubuntu-24.04-arm\n            setup: linux\n'
	mutant 'a second matrix axis beside the one include entry, two legs again (#781 re-review)' \
		$'            npm_pkg: linux-x64\n            runner: ubuntu-latest\n            setup: linux\n' \
		$'            npm_pkg: linux-x64\n            runner: ubuntu-latest\n            setup: linux\n        shard: [a, b]\n'
	mutant 'a leg job whose output is not its digest step (#781)' \
		$'  build-sidecar-linux-arm64:\n    needs: resolve\n    if: needs.resolve.outputs.should_release == \'true\'\n    runs-on: ${{ matrix.runner }}\n    permissions:\n      contents: read\n    outputs:\n      sha256: ${{ steps.digest.outputs.sha256 }}' \
		$'  build-sidecar-linux-arm64:\n    needs: resolve\n    if: needs.resolve.outputs.should_release == \'true\'\n    runs-on: ${{ matrix.runner }}\n    permissions:\n      contents: read\n    outputs:\n      sha256: ${{ steps.other.outputs.sha256 }}'
	mutant 'publish-sidecar not waiting for one leg, so its digest reads empty (#781)' \
		' build-sidecar-darwin-x64, sign-sidecar-windows]' ' sign-sidecar-windows]'
	mutant 'the digest taken before the bundle is packaged (#781)' \
		'      # tar the bundle before upload' $'      - id: digest\n        run: "true"\n      # tar the bundle before upload'
	mutant 'the signer digest dropped, so the signed binary has none (#781)' \
		$'    outputs:\n      sha256: ${{ steps.digest.outputs.sha256 }}\n      # Whether the signing step ran, so verify-sidecar-windows' $'    outputs:\n      # Whether the signing step ran, so verify-sidecar-windows'
	mutant 'the artifact check switched off on its own (#781)' \
		$'      - name: Verify sidecar artifacts\n        env:' $'      - name: Verify sidecar artifacts\n        if: false\n        env:'
	mutant 'the artifact check allowed to fail (#781 review)' \
		$'      - name: Verify sidecar artifacts\n        env:' $'      - name: Verify sidecar artifacts\n        continue-on-error: true\n        env:'
	unset MUTANT_MODE MUTANT_FROM
}

# The check itself, executed verbatim against artifact fixtures.
VERIFY="$(YQ_FILE="$SIDECAR_WORKFLOW" yq step publish-sidecar 'Verify sidecar artifacts')" || VERIFY=""
if [ -z "$VERIFY" ]; then
	no "found publish-sidecar's 'Verify sidecar artifacts' step"
else
	# fixture: lay out the five artifacts as download-artifact does, and set
	# SUM_<LEG> to each digest.
	fixture() {
		rm -rf "${WORK}/pub" && mkdir -p "${WORK}/pub/artifacts"
		local leg file
		for leg in linux-x64:jarvis linux-arm64:jarvis darwin-arm64:jarvis-app.tar.gz darwin-x64:jarvis-app.tar.gz win32-x64:jarvis.exe; do
			file="${leg#*:}"
			leg="${leg%%:*}"
			mkdir -p "${WORK}/pub/artifacts/sidecar-${leg}"
			printf 'payload for %s\n' "$leg" >"${WORK}/pub/artifacts/sidecar-${leg}/${file}"
		done
		SUM_LINUX_X64="$(sha256sum "${WORK}/pub/artifacts/sidecar-linux-x64/jarvis" | cut -d' ' -f1)"
		SUM_LINUX_ARM64="$(sha256sum "${WORK}/pub/artifacts/sidecar-linux-arm64/jarvis" | cut -d' ' -f1)"
		SUM_DARWIN_ARM64="$(sha256sum "${WORK}/pub/artifacts/sidecar-darwin-arm64/jarvis-app.tar.gz" | cut -d' ' -f1)"
		SUM_DARWIN_X64="$(sha256sum "${WORK}/pub/artifacts/sidecar-darwin-x64/jarvis-app.tar.gz" | cut -d' ' -f1)"
		SUM_WIN32_X64="$(sha256sum "${WORK}/pub/artifacts/sidecar-win32-x64/jarvis.exe" | cut -d' ' -f1)"
	}
	# run_verify: run the step as the runner would; sets RC.
	run_verify() {
		(cd "${WORK}/pub" && env -i PATH="$PATH" SIDECAR_BIN=jarvis \
			SHA_LINUX_X64="$SUM_LINUX_X64" SHA_LINUX_ARM64="$SUM_LINUX_ARM64" \
			SHA_DARWIN_ARM64="$SUM_DARWIN_ARM64" SHA_DARWIN_X64="$SUM_DARWIN_X64" \
			SHA_WIN32_X64="$SUM_WIN32_X64" bash -c "$VERIFY") >"${WORK}/pub.log" 2>&1
		RC=$?
	}
	fixture
	run_verify
	if [ "$RC" -eq 0 ]; then
		ok "the artifact check passes the five artifacts the build jobs hashed"
	else
		no "the artifact check passes the five artifacts the build jobs hashed" "$(cat "${WORK}/pub.log")"
	fi
	# expect_refused <label> <::error:: text or empty>
	expect_refused() {
		run_verify
		if [ "$RC" -eq 0 ]; then
			no "the artifact check refuses ${1}" "exited 0: $(cat "${WORK}/pub.log")"
		elif [ -n "$2" ] && ! grep -qF "$2" "${WORK}/pub.log"; then
			no "the artifact check refuses ${1} with '${2}'" "$(cat "${WORK}/pub.log")"
		else
			ok "the artifact check refuses ${1}"
		fi
	}
	fixture
	printf 'swapped\n' >"${WORK}/pub/artifacts/sidecar-linux-arm64/jarvis"
	expect_refused "a leg replaced after its build hashed it" "FAILED"
	fixture
	printf 'swapped\n' >"${WORK}/pub/artifacts/sidecar-win32-x64/jarvis.exe"
	expect_refused "the signed Windows binary replaced after signing" "FAILED"
	fixture
	SUM_DARWIN_X64=""
	expect_refused "a leg that reported no digest" "::error::no digest was reported for sidecar-darwin-x64/jarvis-app.tar.gz"
	fixture
	mkdir -p "${WORK}/pub/artifacts/sidecar-evil" && printf 'x\n' >"${WORK}/pub/artifacts/sidecar-evil/jarvis"
	expect_refused "an extra sidecar-* artifact in the download" "not exactly the five"
	fixture
	printf 'x\n' >"${WORK}/pub/artifacts/sidecar-linux-x64/extra"
	expect_refused "an extra file inside a leg (Prepare copies the whole directory)" "not exactly the five"
	fixture
	rm "${WORK}/pub/artifacts/sidecar-darwin-arm64/jarvis-app.tar.gz"
	expect_refused "a missing artifact" "not exactly the five"
	fixture
	mv "${WORK}/pub/artifacts/sidecar-linux-x64/jarvis" "${WORK}/pub/real"
	ln -s "${WORK}/pub/real" "${WORK}/pub/artifacts/sidecar-linux-x64/jarvis"
	expect_refused "a link in place of a file" "other than files and directories"
	fixture
	tmp="$SUM_LINUX_X64"
	SUM_LINUX_X64="$SUM_LINUX_ARM64"
	SUM_LINUX_ARM64="$tmp"
	expect_refused "two legs digests crossed over" "FAILED"
fi
# The other three digest checks on the release path, executed verbatim too
# (#781 re-review): the structure rules see their shape, and only running
# them shows a tampered file actually stops the job.
# verbatim_case <label> <0|nonzero> <dir> <script> [VAR=value ...]
verbatim_case() {
	local label="$1" want="$2" dir="$3" script="$4"
	shift 4
	# bash -e, no pipefail: what GitHub runs for a step with no shell: key.
	(cd "$dir" && env -i PATH="$PATH" "$@" bash -e -c "$script") >"${WORK}/v.log" 2>&1
	local rc=$?
	if { [ "$want" = 0 ] && [ "$rc" -eq 0 ]; } || { [ "$want" != 0 ] && [ "$rc" -ne 0 ]; }; then
		ok "$label"
	else
		no "$label" "exit ${rc}: $(cat "${WORK}/v.log")"
	fi
}
# inbox_suite <job> <script> <inbox under RUNNER_TEMP> <file> <copies yes|no> [VAR=value ...]
# The signing inputs arrive in a directory of their own, not the checkout
# (#817 review): the script must take exactly that one regular file, by its
# digest, and copy nothing into the working directory when it refuses. An
# artifact that also carries scripts/sign-windows.sh is the attack this
# exists for.
inbox_suite() {
	local job="$1" script="$2" box="$3" file="$4" copies="$5"
	shift 5
	local d="${WORK}/inbox" sum
	reset_inbox() { rm -rf "$d" && mkdir -p "$d/rt/$box" "$d/cwd" && printf 'payload\n' >"$d/rt/$box/$file"; }
	reset_inbox
	sum="$(sha256sum "$d/rt/$box/$file" | cut -d' ' -f1)"
	verbatim_case "$job accepts the one file it was given the digest of" 0 "$d/cwd" "$script" SHA256="$sum" RUNNER_TEMP="$d/rt" "$@"
	if [ "$copies" = yes ]; then
		if cmp -s "$d/rt/$box/$file" "$d/cwd/$file"; then ok "$job copies the checked file into place"; else no "$job copies the checked file into place"; fi
	fi
	reset_inbox
	verbatim_case "$job refuses an empty digest" 1 "$d/cwd" "$script" SHA256= RUNNER_TEMP="$d/rt" "$@"
	reset_inbox
	printf 'swapped\n' >"$d/rt/$box/$file"
	verbatim_case "$job refuses a file replaced after it was hashed" 1 "$d/cwd" "$script" SHA256="$sum" RUNNER_TEMP="$d/rt" "$@"
	reset_inbox
	mkdir -p "$d/rt/$box/scripts" && printf 'evil\n' >"$d/rt/$box/scripts/sign-windows.sh"
	verbatim_case "$job refuses an artifact that also carries a replacement script" 1 "$d/cwd" "$script" SHA256="$sum" RUNNER_TEMP="$d/rt" "$@"
	if [ -e "$d/cwd/$file" ]; then no "$job copies nothing into place when it refuses"; else ok "$job copies nothing into place when it refuses"; fi
	reset_inbox
	mv "$d/rt/$box/$file" "$d/real" && ln -s "$d/real" "$d/rt/$box/$file"
	verbatim_case "$job refuses a link in place of the file" 1 "$d/cwd" "$script" SHA256="$sum" RUNNER_TEMP="$d/rt" "$@"
}
SIGNV="$(YQ_FILE="$SIDECAR_WORKFLOW" yq step sign-sidecar-windows 'Verify the binary')" || SIGNV=""
BRAINV="$(yq step publish-brain 'Verify the tarball')" || BRAINV=""
RELV="$(yq step github-release 'Verify sidecar binaries')" || RELV=""
if [ -z "$SIGNV" ] || [ -z "$BRAINV" ] || [ -z "$RELV" ]; then
	no "found the three remaining digest checks (sign-sidecar-windows, publish-brain, github-release)"
else
	inbox_suite sign-sidecar-windows "$SIGNV" unsigned jarvis.exe yes SIDECAR_BIN=jarvis
	d="${WORK}/v" && rm -rf "$d" && mkdir -p "$d/tmp/brain-pack" "$d/rel/artifacts/sidecar-linux-x64"

	tgz=usejarvis-brain-1.2.3.tgz
	printf 'tarball\n' >"$d/tmp/brain-pack/$tgz"
	tgz_sum="$(sha256sum "$d/tmp/brain-pack/$tgz" | cut -d' ' -f1)"
	verbatim_case "publish-brain accepts the tarball pack-brain hashed" 0 "$d" "$BRAINV" TARBALL="$tgz" SHA256="$tgz_sum" RUNNER_TEMP="$d/tmp"
	verbatim_case "publish-brain refuses an empty digest" 1 "$d" "$BRAINV" TARBALL="$tgz" SHA256= RUNNER_TEMP="$d/tmp"
	verbatim_case "publish-brain refuses a tarball name outside the package" 1 "$d" "$BRAINV" TARBALL="../evil.tgz" SHA256="$tgz_sum" RUNNER_TEMP="$d/tmp"
	printf 'swapped\n' >"$d/tmp/brain-pack/$tgz"
	verbatim_case "publish-brain refuses a tarball replaced after packing" 1 "$d" "$BRAINV" TARBALL="$tgz" SHA256="$tgz_sum" RUNNER_TEMP="$d/tmp"

	printf 'linux binary\n' >"$d/rel/artifacts/sidecar-linux-x64/jarvis"
	sums="$(cd "$d/rel/artifacts" && sha256sum ./sidecar-linux-x64/jarvis | base64 -w0)"
	verbatim_case "github-release accepts the binaries publish-sidecar published" 0 "$d/rel" "$RELV" SUMS="$sums"
	verbatim_case "github-release refuses when the sidecar reported no digests" 1 "$d/rel" "$RELV" SUMS=
	printf 'swapped\n' >"$d/rel/artifacts/sidecar-linux-x64/jarvis"
	verbatim_case "github-release refuses a binary replaced after publish-sidecar" 1 "$d/rel" "$RELV" SUMS="$sums"
fi
# The leg side, run as the runner would.
LEGDIGEST="$(YQ_FILE="$SIDECAR_WORKFLOW" yq step build-sidecar-darwin-arm64 digest)" || LEGDIGEST=""
if [ -z "$LEGDIGEST" ]; then
	no "found build-sidecar-darwin-arm64's digest step"
else
	rm -rf "${WORK}/leg" && mkdir -p "${WORK}/leg"
	printf 'a darwin bundle\n' >"${WORK}/leg/jarvis-app.tar.gz"
	: >"${WORK}/leg/out"
	(cd "${WORK}/leg" && env -i PATH="$PATH" GITHUB_OUTPUT="${WORK}/leg/out" FILE=jarvis-app.tar.gz LEG=darwin-arm64 bash -c "$LEGDIGEST") >/dev/null 2>&1
	want="sha256=$(sha256sum "${WORK}/leg/jarvis-app.tar.gz" | cut -d' ' -f1)"
	if [ "$(cat "${WORK}/leg/out")" = "$want" ]; then
		ok "a leg job writes exactly its own digest output"
	else
		no "a leg job writes exactly its own digest output" "got: $(cat "${WORK}/leg/out"); want: ${want}"
	fi
fi

echo
echo "installer-release.yml: the signer and the publisher take artifacts only by digest (#779)"
# The installer build was split from its signing like the sidecar (#779),
# so the unsigned installer crosses build-windows -> sign-windows, and the
# signed one and the DMG cross into publish, each by a job-output digest.
# Both checks executed verbatim against fixtures.
INSTALLER_WORKFLOW="${INSTALLER_RELEASE_WORKFLOW:-${HERE}/../workflows/installer-release.yml}"
found="$(YQ_FILE="$INSTALLER_WORKFLOW" yq installer-digests)" || {
	no "installer digest structure check ran" "the bun helper failed"
	found=""
}
if [ -z "$found" ]; then
	ok "build-windows, sign-windows and build-macos output a digest taken last, and each consumer checks the right one first"
else
	no "installer artifact digests" "$found"
fi
# shellcheck disable=SC2016 # every mutant is literal workflow text.
{
	MUTANT_MODE=installer-digests
	MUTANT_FROM="$INSTALLER_WORKFLOW"
	mutant 'publish checking the Windows installer against the UNSIGNED build digest (#779)' \
		'          SHA_WIN32_X64: ${{ needs.sign-windows.outputs.sha256 }}' '          SHA_WIN32_X64: ${{ needs.build-windows.outputs.sha256 }}'
	mutant 'publish not waiting for the signer, so its digest reads empty (#779)' \
		'    needs: [resolve, sign-windows, verify-windows, build-macos]' '    needs: [resolve, build-windows, verify-windows, build-macos]'
	mutant 'the DMG digest dropped from build-macos (#779)' \
		$'    outputs:\n      sha256: ${{ steps.digest.outputs.sha256 }}\n    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n        with:\n          persist-credentials: false\n      - uses: actions/setup-go@b7ad1dad31e06c5925ef5d2fc7ad053ef454303e # v7.0.0\n        with:\n          # The Actions cache is writable by any run on main, and Go reuses\n          # cached modules and build output without re-verifying them (#681).\n          cache: false\n          go-version-file: sidecar/go.mod\n          cache-dependency-path: sidecar/go.sum\n\n      - name: Build universal' \
		$'    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n        with:\n          persist-credentials: false\n      - uses: actions/setup-go@b7ad1dad31e06c5925ef5d2fc7ad053ef454303e # v7.0.0\n        with:\n          # The Actions cache is writable by any run on main, and Go reuses\n          # cached modules and build output without re-verifying them (#681).\n          cache: false\n          go-version-file: sidecar/go.mod\n          cache-dependency-path: sidecar/go.sum\n\n      - name: Build universal'
	mutant 'the signed digest taken before signing (#779)' \
		'      - name: Sign installer (Cloud KMS)' $'      - id: digest\n        run: "true"\n      - name: Sign installer (Cloud KMS)'
	mutant 'a matrix on the macOS installer build, sharing its digest output (#779 re-review)' \
		$'    runs-on: macos-latest\n    env:\n      HAVE_APPLE_SIGNING' $'    runs-on: macos-latest\n    strategy:\n      matrix:\n        include:\n          - arch: universal\n        shard: [a, b]\n    env:\n      HAVE_APPLE_SIGNING'
	mutant 'the signed digest step allowed to fail (#779 re-review)' \
		$'      # The SIGNED installer\'s digest: signing changes the bytes, and publish\n      # takes the artifact only by this.\n      - name: Digest\n        id: digest\n' $'      # The SIGNED installer\'s digest: signing changes the bytes, and publish\n      # takes the artifact only by this.\n      - name: Digest\n        id: digest\n        continue-on-error: true\n'
	mutant 'the publish check switched off on its own (#779)' \
		$'      - name: Verify the installers\n        env:' $'      - name: Verify the installers\n        if: false\n        env:'
	unset MUTANT_MODE MUTANT_FROM
}
SIGNCHECK="$(YQ_FILE="$INSTALLER_WORKFLOW" yq step sign-windows 'Verify the installer')" || SIGNCHECK=""
PUBCHECK="$(YQ_FILE="$INSTALLER_WORKFLOW" yq step publish 'Verify the installers')" || PUBCHECK=""
if [ -z "$SIGNCHECK" ]; then
	no "found installer-release.yml sign-windows step 'Verify the installer'"
else
	inbox_suite sign-windows "$SIGNCHECK" unsigned Jarvis-Setup.exe yes
	# The refusal names what was missing.
	rm -rf "${WORK}/inst" && mkdir -p "${WORK}/inst/rt/unsigned" "${WORK}/inst/cwd"
	(cd "${WORK}/inst/cwd" && env -i PATH="$PATH" SHA256= RUNNER_TEMP="${WORK}/inst/rt" bash -c "$SIGNCHECK") >"${WORK}/inst.log" 2>&1
	if grep -qF "::error::build-windows reported no digest" "${WORK}/inst.log"; then ok "sign-windows names a missing build-windows digest"; else no "sign-windows names a missing build-windows digest" "$(cat "${WORK}/inst.log")"; fi
fi
if [ -z "$PUBCHECK" ]; then
	no "found installer-release.yml publish step 'Verify the installers'"
else
	inst_fixture() {
		rm -rf "${WORK}/ipub" && mkdir -p "${WORK}/ipub/artifacts/installer-win32-x64" "${WORK}/ipub/artifacts/installer-darwin"
		printf 'signed exe\n' >"${WORK}/ipub/artifacts/installer-win32-x64/Jarvis-Setup.exe"
		printf 'dmg\n' >"${WORK}/ipub/artifacts/installer-darwin/Install-Jarvis.dmg"
		SUM_WIN="$(sha256sum "${WORK}/ipub/artifacts/installer-win32-x64/Jarvis-Setup.exe" | cut -d' ' -f1)"
		SUM_DMG="$(sha256sum "${WORK}/ipub/artifacts/installer-darwin/Install-Jarvis.dmg" | cut -d' ' -f1)"
	}
	pub_check() {
		(cd "${WORK}/ipub" && env -i PATH="$PATH" SHA_WIN32_X64="$SUM_WIN" SHA_DARWIN="$SUM_DMG" bash -c "$PUBCHECK") >"${WORK}/ipub.log" 2>&1
		RC=$?
	}
	# pub_refused <label> <expected text>
	pub_refused() {
		pub_check
		if [ "$RC" -ne 0 ] && grep -qF -- "$2" "${WORK}/ipub.log"; then
			ok "publish refuses ${1}"
		else
			no "publish refuses ${1} with '${2}'" "exit ${RC}: $(cat "${WORK}/ipub.log")"
		fi
	}
	inst_fixture
	pub_check
	if [ "$RC" -eq 0 ]; then ok "publish accepts the two installers their jobs hashed"; else no "publish accepts the two installers their jobs hashed" "$(cat "${WORK}/ipub.log")"; fi
	inst_fixture
	printf 'unsigned\n' >"${WORK}/ipub/artifacts/installer-win32-x64/Jarvis-Setup.exe"
	pub_refused "a Windows installer replaced after signing" "FAILED"
	inst_fixture
	printf 'other\n' >"${WORK}/ipub/artifacts/installer-darwin/Install-Jarvis.dmg"
	pub_refused "a DMG replaced after its build" "FAILED"
	inst_fixture
	SUM_DMG=""
	pub_refused "a DMG with no digest" "::error::no digest was reported for DARWIN"
	inst_fixture
	mkdir -p "${WORK}/ipub/artifacts/installer-evil" && printf 'x\n' >"${WORK}/ipub/artifacts/installer-evil/Jarvis-Setup.exe"
	pub_refused "an extra installer-* artifact" "not exactly the two"
	inst_fixture
	rm "${WORK}/ipub/artifacts/installer-darwin/Install-Jarvis.dmg"
	pub_refused "a missing DMG" "not exactly the two"
	inst_fixture
	tmp="$SUM_WIN"; SUM_WIN="$SUM_DMG"; SUM_DMG="$tmp"
	pub_refused "the two digests crossed over" "FAILED"
fi

echo
echo "post-sign verification runs without id-token, on what ships, before publishing (#817)"
for f in "$SIDECAR_WORKFLOW" "$INSTALLER_WORKFLOW"; do
	found="$(YQ_FILE="$f" yq postsign)" || {
		no "$(basename "$f"): post-sign check ran" "the bun helper failed"
		continue
	}
	if [ -z "$found" ]; then
		ok "$(basename "$f"): the signer defers, the verify job holds no token, checks the shipped digest, and gates the publish"
	else
		no "$(basename "$f"): post-sign verification" "$found"
	fi
done
# shellcheck disable=SC2016 # every mutant is literal workflow text.
{
	MUTANT_MODE=postsign
	MUTANT_FROM="$SIDECAR_WORKFLOW"
	mutant 'publish-sidecar not waiting for the signature check (#817)' \
		'    needs: [resolve, verify-sidecar-windows, build-sidecar-linux-x64,' '    needs: [resolve, build-sidecar-linux-x64,'
	mutant 'the sidecar signer verifying in place again, in the job holding id-token (#817)' \
		'scripts/sign-windows.sh --defer-verify "${SIDECAR_BIN}.exe"' 'scripts/sign-windows.sh "${SIDECAR_BIN}.exe"'
	mutant 'the sidecar signature check given id-token (#817)' \
		$'  verify-sidecar-windows:\n    needs: [resolve, sign-sidecar-windows]\n    if: needs.resolve.outputs.should_release == \'true\'\n    runs-on: ubuntu-latest\n    permissions:\n      contents: read\n' \
		$'  verify-sidecar-windows:\n    needs: [resolve, sign-sidecar-windows]\n    if: needs.resolve.outputs.should_release == \'true\'\n    runs-on: ubuntu-latest\n    permissions:\n      contents: read\n      id-token: write\n'
	mutant 'the sidecar signer reporting it never signs, so the check always skips (#817)' \
		'      signed: ${{ steps.winsign.outputs.ready }}' '      signed: "false"'
	mutant 'the sidecar signature check verifying an artifact other than the one that ships (#817)' \
		$'          name: sidecar-win32-x64\n          path: ${{ runner.temp }}/signed\n' $'          name: unsigned-win32-x64\n          path: ${{ runner.temp }}/signed\n'
	mutant 'the sidecar signature check job allowed to fail as a whole (#817 review)' \
		$'  verify-sidecar-windows:\n    needs: [resolve, sign-sidecar-windows]\n' $'  verify-sidecar-windows:\n    needs: [resolve, sign-sidecar-windows]\n    continue-on-error: true\n'
	mutant 'publish-sidecar running past a failed signature check (#817 review)' \
		$'    if: needs.resolve.outputs.should_release == \'true\'\n    runs-on: ubuntu-latest\n    permissions:\n      contents: read\n      id-token: write\n    outputs:\n      sums:' \
		$'    if: ${{ !cancelled() && needs.resolve.outputs.should_release == \'true\' }}\n    runs-on: ubuntu-latest\n    permissions:\n      contents: read\n      id-token: write\n    outputs:\n      sums:'
	mutant 'the sidecar signature check job run under a condition of its own (#817 review)' \
		$'  verify-sidecar-windows:\n    needs: [resolve, sign-sidecar-windows]\n    if: needs.resolve.outputs.should_release == \'true\'\n' $'  verify-sidecar-windows:\n    needs: [resolve, sign-sidecar-windows]\n    if: always()\n'
	mutant 'the sidecar signature check relaxed to an untrusted chain (#817)' \
		$'          SIGN_REQUIRE_TRUSTED_CHAIN: "1"\n        run: |\n          if [ -z "${SIGNING_PUBLISHER_CN}" ]' $'          SIGN_REQUIRE_TRUSTED_CHAIN: "0"\n        run: |\n          if [ -z "${SIGNING_PUBLISHER_CN}" ]'
	MUTANT_FROM="$INSTALLER_WORKFLOW"
	mutant 'the installer publish not waiting for the signature check (#817)' \
		'    needs: [resolve, sign-windows, verify-windows, build-macos]' '    needs: [resolve, sign-windows, build-macos]'
	mutant 'the installer signature check against the UNSIGNED build digest (#817)' \
		'          SHA256: ${{ needs.sign-windows.outputs.sha256 }}' '          SHA256: ${{ needs.build-windows.outputs.sha256 }}'
	mutant 'the installer signature check switched off on its own (#817)' \
		$'      - name: Verify the Authenticode signature\n        if: needs.sign-windows.outputs.signed == \'true\'' $'      - name: Verify the Authenticode signature\n        if: false'
	mutant 'the installer signature check allowed to fail (#817)' \
		$'      - name: Verify the Authenticode signature\n        if: needs.sign-windows.outputs.signed == \'true\'' $'      - name: Verify the Authenticode signature\n        continue-on-error: true\n        if: needs.sign-windows.outputs.signed == \'true\''
	mutant 'the installer signature check given a write scope (#817)' \
		$'  verify-windows:\n    needs: [resolve, sign-windows]\n    if: needs.resolve.outputs.should_release == \'true\'\n    runs-on: ubuntu-latest\n    permissions:\n      contents: read\n' \
		$'  verify-windows:\n    needs: [resolve, sign-windows]\n    if: needs.resolve.outputs.should_release == \'true\'\n    runs-on: ubuntu-latest\n    permissions:\n      contents: write\n'
	mutant 'the installer signature check run without its publisher pin (#817)' \
		$'          SIGNING_PUBLISHER_CN: ${{ vars.SIGNING_PUBLISHER_CN }}\n          # Sectigo' $'          # Sectigo'
	mutant 'the installer signer allowed to fail as a whole (#817 review)' \
		$'  sign-windows:\n    needs: [resolve, build-windows]\n' $'  sign-windows:\n    needs: [resolve, build-windows]\n    continue-on-error: true\n'
	mutant 'the installer publish running after a failure (#817 review)' \
		$'    needs: [resolve, sign-windows, verify-windows, build-macos]\n    if: needs.resolve.outputs.should_release == \'true\'' $'    needs: [resolve, sign-windows, verify-windows, build-macos]\n    if: always() && needs.resolve.outputs.should_release == \'true\''
	mutant 'the installer digest check made skippable (#817)' \
		$'      - name: Verify the signed installer digest\n' $'      - name: Verify the signed installer digest\n        if: false\n'
	unset MUTANT_MODE MUTANT_FROM
}
# The two digest checks, executed verbatim.
SIDEV="$(YQ_FILE="$SIDECAR_WORKFLOW" yq step verify-sidecar-windows 'Verify the signed binary digest')" || SIDEV=""
INSTV="$(YQ_FILE="$INSTALLER_WORKFLOW" yq step verify-windows 'Verify the signed installer digest')" || INSTV=""
if [ -z "$SIDEV" ] || [ -z "$INSTV" ]; then
	no "found the two post-sign digest checks (verify-sidecar-windows, verify-windows)"
else
	inbox_suite verify-sidecar-windows "$SIDEV" signed jarvis.exe no SIDECAR_BIN=jarvis
	inbox_suite verify-windows "$INSTV" signed Jarvis-Setup.exe no
fi

echo
echo "Windows signing readiness fails a real run that would ship unsigned (#869)"
# Both signers decide here whether to sign at all, and every signing and
# verification step follows that decision, so a readiness step that says
# "not ready" on a real run ships an unsigned binary with only a warning.
# Executed verbatim, under bash -e as the runner runs it, against every
# combination of the two preconditions, the dry run and the escape hatch.
# shellcheck disable=SC2016 # the escape hatch text is matched literally.
{
	MUTANT_MODE=postsign
	MUTANT_FROM="$SIDECAR_WORKFLOW"
	mutant 'the sidecar readiness step allowed to fail (#869)' \
		$'      - name: Windows signing readiness\n        id: winsign\n' $'      - name: Windows signing readiness\n        id: winsign\n        continue-on-error: true\n' \
		'the readiness step has continue-on-error'
	mutant 'the sidecar readiness step switched off on its own (#869)' \
		$'      - name: Windows signing readiness\n        id: winsign\n' $'      - name: Windows signing readiness\n        id: winsign\n        if: env.DRY_RUN != \'true\'\n' \
		'the readiness step runs under'
	mutant 'the sidecar escape hatch read from something other than its variable (#869)' \
		$'          ALLOW_UNSIGNED_WINDOWS: ${{ vars.ALLOW_UNSIGNED_WINDOWS }}\n        run: |\n          set -euo pipefail\n          missing=' $'          ALLOW_UNSIGNED_WINDOWS: "true"\n        run: |\n          set -euo pipefail\n          missing=' \
		'the readiness step env must be exactly'
	MUTANT_FROM="$INSTALLER_WORKFLOW"
	mutant 'the installer readiness step allowed to fail (#869)' \
		$'      - name: Windows signing readiness\n        id: winsign\n' $'      - name: Windows signing readiness\n        id: winsign\n        continue-on-error: true\n' \
		'the readiness step has continue-on-error'
	mutant 'the installer escape hatch dropped from the readiness env (#869)' \
		$'          GCP_KMS_KEYRING: ${{ vars.GCP_KMS_KEYRING }}\n          ALLOW_UNSIGNED_WINDOWS: ${{ vars.ALLOW_UNSIGNED_WINDOWS }}\n        run: |\n          set -euo pipefail\n          missing=' $'          GCP_KMS_KEYRING: ${{ vars.GCP_KMS_KEYRING }}\n        run: |\n          set -euo pipefail\n          missing=' \
		'the readiness step env must be exactly'
	mutant 'the installer readiness step handed a token as well (#869)' \
		$'          GCP_KMS_KEYRING: ${{ vars.GCP_KMS_KEYRING }}\n          ALLOW_UNSIGNED_WINDOWS: ${{ vars.ALLOW_UNSIGNED_WINDOWS }}\n        run: |\n          set -euo pipefail\n          missing=' $'          GCP_KMS_KEYRING: ${{ vars.GCP_KMS_KEYRING }}\n          ALLOW_UNSIGNED_WINDOWS: ${{ vars.ALLOW_UNSIGNED_WINDOWS }}\n          GH_TOKEN: ${{ github.token }}\n        run: |\n          set -euo pipefail\n          missing=' \
		'the readiness step env must be exactly'
	mutant 'the installer signer told it is a rehearsal through GITHUB_ENV (#869 review)' \
		'      - name: Windows signing readiness' $'      - run: echo "DRY_RUN=true" >> "$GITHUB_ENV"\n      - name: Windows signing readiness' \
		'a step before readiness writes GITHUB_ENV'
	mutant 'the installer signer job env setting the escape hatch (#869 review)' \
		$'  sign-windows:\n    needs: [resolve, build-windows]\n' $'  sign-windows:\n    needs: [resolve, build-windows]\n    env:\n      ALLOW_UNSIGNED_WINDOWS: "true"\n' \
		'the job env sets ALLOW_UNSIGNED_WINDOWS'
	mutant 'the installer unsigned-binary refusal switched off (#869 review)' \
		$'      - name: Refuse an unsigned binary on a real run\n' $'      - name: Refuse an unsigned binary on a real run\n        if: needs.sign-windows.outputs.signed == \'true\'\n' \
		'the unsigned-binary refusal can be skipped'
	mutant 'the installer unsigned-binary refusal removed (#869 review)' \
		'      - name: Refuse an unsigned binary on a real run' '      - name: Something else' \
		'no step refusing an unsigned binary on a real run'
	MUTANT_FROM="$SIDECAR_WORKFLOW"
	mutant 'the sidecar unsigned-binary refusal told the signer always signed (#869 review)' \
		'          SIGNED: ${{ needs.sign-sidecar-windows.outputs.signed }}' '          SIGNED: "true"' \
		'the unsigned-binary refusal env must be exactly'
	mutant 'the sidecar unsigned-binary refusal allowed to fail (#869 review)' \
		$'      - name: Refuse an unsigned binary on a real run\n' $'      - name: Refuse an unsigned binary on a real run\n        continue-on-error: true\n' \
		'the unsigned-binary refusal can be skipped or allowed to fail'
	unset MUTANT_MODE MUTANT_FROM
}
SREADY="$(YQ_FILE="$SIDECAR_WORKFLOW" yq step sign-sidecar-windows winsign)" || SREADY=""
IREADY="$(YQ_FILE="$INSTALLER_WORKFLOW" yq step sign-windows winsign)" || IREADY=""
if [ -z "$SREADY" ] || [ -z "$IREADY" ]; then
	no "found both Windows signing readiness steps (sign-sidecar-windows, sign-windows)"
else
	# ready_case <job> <script> <want rc 0|1> <want output> <keyring> <chain yes|no> <dry run> <hatch> <label> [text the log must carry]
	ready_case() {
		local job="$1" script="$2" want="$3" wantout="$4" keyring="$5" chain="$6" dry="$7" hatch="$8" label="$9" text="${10:-}"
		local d="${WORK}/ready"
		rm -rf "$d" && mkdir -p "$d/cwd/sidecar/packaging/windows"
		[ "$chain" = yes ] && printf 'chain\n' >"$d/cwd/sidecar/packaging/windows/codesign-chain.pem"
		: >"$d/out"
		(cd "$d/cwd" && env -i PATH="$PATH" GITHUB_OUTPUT="$d/out" GCP_KMS_KEYRING="$keyring" DRY_RUN="$dry" \
			ALLOW_UNSIGNED_WINDOWS="$hatch" bash -e -c "$script") >"$d/log" 2>&1
		local rc=$?
		local got
		got="$(cat "$d/out")"
		if { [ "$want" = 0 ] && [ "$rc" -ne 0 ]; } || { [ "$want" != 0 ] && [ "$rc" -eq 0 ]; }; then
			no "$job: $label" "exit ${rc}, wanted $([ "$want" = 0 ] && echo 0 || echo non-zero): $(cat "$d/log")"
		elif [ "$got" != "$wantout" ]; then
			no "$job: $label" "GITHUB_OUTPUT was '${got}', wanted '${wantout}'; log: $(cat "$d/log")"
		elif [ -n "$text" ] && ! grep -qF -- "$text" "$d/log"; then
			no "$job: $label, saying '${text}'" "$(cat "$d/log")"
		elif [ "$want" != 0 ] && [ "$(grep -c '^::error::' "$d/log")" -ne 1 ]; then
			no "$job: $label, with exactly one ::error::" "$(cat "$d/log")"
		else
			ok "$job: $label"
		fi
	}
	KR=projects/p/locations/global/keyRings/k
	for pair in "sign-sidecar-windows:SREADY" "sign-windows:IREADY"; do
		job="${pair%%:*}"
		var="${pair#*:}"
		script="${!var}"
		ready_case "$job" "$script" 0 "ready=true" "$KR" yes false "" "signs a real run when both preconditions hold"
		ready_case "$job" "$script" 0 "ready=true" "$KR" yes true "" "signs a dry run when both preconditions hold"
		# The real-run refusals: each names its cause and every way forward.
		ready_case "$job" "$script" 1 "" "" yes false "" "refuses a real run with GCP_KMS_KEYRING unset" "::error::Windows signing is not configured (GCP_KMS_KEYRING unset)"
		ready_case "$job" "$script" 1 "" "" yes false "" "names the escape hatch when it refuses" "ALLOW_UNSIGNED_WINDOWS"
		ready_case "$job" "$script" 1 "" "" yes false "" "says to set the keyring variable when it is the one missing" "Set the GCP_KMS_KEYRING repository variable"
		ready_case "$job" "$script" 1 "" "$KR" no false "" "refuses a real run with the certificate chain missing" "::error::GCP_KMS_KEYRING is set but sidecar/packaging/windows/codesign-chain.pem is missing"
		ready_case "$job" "$script" 1 "" "$KR" no false "" "says to commit the chain when it is the one missing" "commit sidecar/packaging/windows/codesign-chain.pem"
		ready_case "$job" "$script" 1 "" "" no false "" "refuses a real run with neither, naming the keyring first" "GCP_KMS_KEYRING unset"
		# A rehearsal needs no signing configuration: it warns, as before.
		ready_case "$job" "$script" 0 "ready=false" "" yes true "" "lets a dry run continue unsigned with the keyring unset" "::warning::Windows signing is not configured (GCP_KMS_KEYRING unset)"
		ready_case "$job" "$script" 0 "ready=false" "$KR" no true "" "lets a dry run continue unsigned with the chain missing" "::warning::GCP_KMS_KEYRING is set but sidecar/packaging/windows/codesign-chain.pem is missing"
		ready_case "$job" "$script" 0 "ready=false" "" yes true "" "tells a dry run that a real release would stop there" "a real release would stop here"
		# The escape hatch: exactly the string true, recorded as a warning.
		ready_case "$job" "$script" 0 "ready=false" "" yes false true "ships unsigned on purpose with ALLOW_UNSIGNED_WINDOWS=true" "because ALLOW_UNSIGNED_WINDOWS is true"
		ready_case "$job" "$script" 0 "ready=false" "$KR" no false true "ships unsigned on purpose with the chain missing and the hatch set" "::warning::GCP_KMS_KEYRING is set but"
		for h in TRUE True 1 yes " true" "true " false; do
			ready_case "$job" "$script" 1 "" "" yes false "$h" "refuses the escape hatch spelled $(printf '%q' "$h")" "::error::"
		done
		# The hatch never turns signing off when signing is possible, and a
		# hatch left set after the config is fixed is pointed out.
		ready_case "$job" "$script" 0 "ready=true" "$KR" yes false true "still signs when the hatch is set but signing is configured" "::warning::ALLOW_UNSIGNED_WINDOWS is set but signing is configured"
		ready_case "$job" "$script" 0 "ready=false" "" yes true true "takes the dry-run branch when a dry run also has the hatch set" "This dry run continues"
	done
fi
# The token-less verify jobs refuse the signer answer on their own (#869
# review), executed verbatim.
SREFUSE="$(YQ_FILE="$SIDECAR_WORKFLOW" yq step verify-sidecar-windows 'Refuse an unsigned binary on a real run')" || SREFUSE=""
IREFUSE="$(YQ_FILE="$INSTALLER_WORKFLOW" yq step verify-windows 'Refuse an unsigned binary on a real run')" || IREFUSE=""
if [ -z "$SREFUSE" ] || [ -z "$IREFUSE" ]; then
	no "found both unsigned-binary refusals (verify-sidecar-windows, verify-windows)"
else
	# refuse_case <job> <script> <want 0|1> <signed> <dry run> <hatch> <label>
	refuse_case() {
		verbatim_case "$1: $7" "$3" "$WORK" "$2" SIGNED="$4" DRY_RUN="$5" ALLOW_UNSIGNED_WINDOWS="$6"
		if [ "$3" != 0 ] && ! grep -qF "::error::" "${WORK}/v.log"; then no "$1: $7, with an ::error::" "$(cat "${WORK}/v.log")"; fi
	}
	for pair in "verify-sidecar-windows:SREFUSE" "verify-windows:IREFUSE"; do
		job="${pair%%:*}"
		var="${pair#*:}"
		script="${!var}"
		refuse_case "$job" "$script" 0 true false "" "passes a signed binary on a real run"
		refuse_case "$job" "$script" 1 false false "" "refuses an unsigned binary on a real run"
		refuse_case "$job" "$script" 1 "" false "" "refuses when the signer reported nothing"
		refuse_case "$job" "$script" 0 false true "" "passes an unsigned binary on a dry run"
		refuse_case "$job" "$script" 0 false false true "passes an unsigned binary under ALLOW_UNSIGNED_WINDOWS=true"
		refuse_case "$job" "$script" 1 false false TRUE "refuses the hatch spelled TRUE"
	done
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
echo "installer version gate (installer-release.yml resolve step, executed verbatim) (#818)"
# The installer version comes from sidecar/installer/VERSION, which no tag gate
# sees. resolve checks it before it becomes an output, as the sidecar resolve
# does (#684); run that script against hostile file contents and check what
# reaches $GITHUB_OUTPUT. A stub gh answers "not released" for the real-run
# cases, so nothing here touches the network.
IRESOLVE="$(YQ_FILE="$INSTALLER_WORKFLOW" yq step resolve v)" || IRESOLVE=""
if [ -z "$IRESOLVE" ]; then
	no "found installer-release.yml's resolve step"
else
	mkdir -p "${WORK}/ibin"
	printf '#!/usr/bin/env bash\nexit 1\n' >"${WORK}/ibin/gh"
	chmod +x "${WORK}/ibin/gh"
	# installer_resolve <file contents> [event] [ref name] [dry run] [locale]: sets RC and OUT.
	installer_resolve() {
		rm -rf "${WORK}/ir" && mkdir -p "${WORK}/ir/sidecar/installer"
		printf '%s' "$1" >"${WORK}/ir/sidecar/installer/VERSION"
		: >"${WORK}/ir/out"
		local -a envs=(PATH="${WORK}/ibin:$PATH" GITHUB_OUTPUT="${WORK}/ir/out" GITHUB_REPOSITORY=o/r
			GITHUB_EVENT_NAME="${2:-workflow_dispatch}" GITHUB_REF_NAME="${3:-main}" DRY_RUN="${4:-true}")
		[ -n "${5:-}" ] && envs+=(LC_ALL="$5" LANG="$5")
		(cd "${WORK}/ir" && env -i "${envs[@]}" bash -e -c "$IRESOLVE") >"${WORK}/ir/log" 2>&1
		RC=$?
		OUT="$(cat "${WORK}/ir/out")"
	}
	for v in 0.3.0 $'0.3.0\n' 1.2.3-rc.1 1.2.3-alpha-1.beta.11 10.20.30; do
		installer_resolve "$v"
		if [ "$RC" -eq 0 ] && [ "$OUT" = "$(printf 'version=%s\nshould_release=true' "${v%$'\n'}")" ]; then
			ok "installer resolve accepts $(printf '%q' "$v")"
		else
			no "installer resolve accepts $(printf '%q' "$v")" "exit ${RC}; output: ${OUT}; log: $(cat "${WORK}/ir/log")"
		fi
	done
	for v in '' '1.2' '01.2.3' '1.2.3+build' $'1.2.3\nshould_release=true' $'1.2.3\nversion=9.9.9' "1.2.3\$(touch ${WORK}/pwned)" \
		"1.2.3\";touch ${WORK}/pwned;\"" '1.2.3|x' '1.2.3/x' '1.2.3-' "1.2.3-rc.1 " '1.2.3-01' '1.2.3-rc..1' $'1.2.3\n::warning::injected'; do
		rm -f "${WORK}/pwned"
		installer_resolve "$v"
		if [ "$RC" -ne 0 ] && [ -z "$OUT" ] && [ ! -e "${WORK}/pwned" ] && grep -qF '::error::sidecar/installer/VERSION is not a plain semver' "${WORK}/ir/log" &&
			[ "$(grep -c '^::' "${WORK}/ir/log")" -eq 1 ]; then
			ok "installer resolve rejects $(printf '%q' "$v") without writing outputs"
		else
			no "installer resolve rejects $(printf '%q' "$v")" "exit ${RC}; output: ${OUT}; log: $(cat "${WORK}/ir/log")"
		fi
	done
	# A tag push must name the version in the file; it is compared only once
	# the file has passed the check above.
	installer_resolve 1.2.3 push installer-v1.2.3 false
	if [ "$RC" -eq 0 ] && [ "$OUT" = "$(printf 'version=1.2.3\nshould_release=true')" ]; then
		ok "installer resolve accepts a tag push that matches the file"
	else
		no "installer resolve accepts a tag push that matches the file" "exit ${RC}; output: ${OUT}; log: $(cat "${WORK}/ir/log")"
	fi
	installer_resolve 1.2.3 push installer-v1.2.4 false
	if [ "$RC" -ne 0 ] && grep -qF 'does not match sidecar/installer/VERSION' "${WORK}/ir/log" && ! grep -q '^should_release=' "${WORK}/ir/out"; then
		ok "installer resolve refuses a tag push that does not match the file"
	else
		no "installer resolve refuses a tag push that does not match the file" "exit ${RC}; output: ${OUT}; log: $(cat "${WORK}/ir/log")"
	fi
	if [ -z "$UTF8_LOCALE" ]; then
		echo "  skip - no en_US.UTF-8 locale on this machine, so the installer locale fixtures cannot run"
	else
		for v in $'1.2.3-é' $'١.2.3' $'1.2.3-ａ'; do
			installer_resolve "$v" workflow_dispatch main true "$UTF8_LOCALE"
			if [ "$RC" -ne 0 ] && [ -z "$OUT" ]; then
				ok "installer resolve rejects $(printf '%q' "$v") under ${UTF8_LOCALE}"
			else
				no "installer resolve rejects $(printf '%q' "$v") under ${UTF8_LOCALE}" "exit ${RC}; output: ${OUT}"
			fi
		done
	fi
fi

echo
echo "${pass} passed, ${fail} failed"
[ "$fail" -eq 0 ]
