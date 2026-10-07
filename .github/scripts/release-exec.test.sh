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
# mutant <label> <exact text> <replacement>: the text must occur exactly once.
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
	local found
	found="$(YQ_FILE="$copy" yq "${MUTANT_MODE:-structure}")"
	if [ -n "$found" ]; then
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
		'needs: [validate-tag, pack-brain, build-docker, sidecar]' 'needs: [pack-brain, build-docker, sidecar]'
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
echo "one dry-run decision, evaluated, in both release workflows (#685)"
SIDECAR_WORKFLOW="${SIDECAR_RELEASE_WORKFLOW:-${HERE}/../workflows/sidecar-release.yml}"
for f in "$WORKFLOW" "$SIDECAR_WORKFLOW"; do
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
	unset MUTANT_MODE MUTANT_FROM
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
		$'    outputs:\n      sha256: ${{ steps.digest.outputs.sha256 }}\n    steps:\n      # For scripts/sign-windows.sh' $'    steps:\n      # For scripts/sign-windows.sh'
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
SIGNV="$(YQ_FILE="$SIDECAR_WORKFLOW" yq step sign-sidecar-windows 'Verify the binary')" || SIGNV=""
BRAINV="$(yq step publish-brain 'Verify the tarball')" || BRAINV=""
RELV="$(yq step github-release 'Verify sidecar binaries')" || RELV=""
if [ -z "$SIGNV" ] || [ -z "$BRAINV" ] || [ -z "$RELV" ]; then
	no "found the three remaining digest checks (sign-sidecar-windows, publish-brain, github-release)"
else
	d="${WORK}/v" && rm -rf "$d" && mkdir -p "$d/sidecar" "$d/tmp/brain-pack" "$d/rel/artifacts/sidecar-linux-x64"
	printf 'unsigned exe\n' >"$d/sidecar/jarvis.exe"
	exe_sum="$(sha256sum "$d/sidecar/jarvis.exe" | cut -d' ' -f1)"
	verbatim_case "sign-sidecar-windows accepts the binary its build hashed" 0 "$d/sidecar" "$SIGNV" SHA256="$exe_sum" SIDECAR_BIN=jarvis
	verbatim_case "sign-sidecar-windows refuses an empty digest" 1 "$d/sidecar" "$SIGNV" SHA256= SIDECAR_BIN=jarvis
	printf 'swapped\n' >"$d/sidecar/jarvis.exe"
	verbatim_case "sign-sidecar-windows refuses a binary replaced after the build" 1 "$d/sidecar" "$SIGNV" SHA256="$exe_sum" SIDECAR_BIN=jarvis

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
		'    needs: [resolve, sign-windows, build-macos]' '    needs: [resolve, build-windows, build-macos]'
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
	rm -rf "${WORK}/inst" && mkdir -p "${WORK}/inst/sidecar"
	printf 'unsigned installer\n' >"${WORK}/inst/sidecar/Jarvis-Setup.exe"
	good="$(sha256sum "${WORK}/inst/sidecar/Jarvis-Setup.exe" | cut -d' ' -f1)"
	# sign_check <digest>: sets RC.
	sign_check() {
		(cd "${WORK}/inst/sidecar" && env -i PATH="$PATH" SHA256="$1" bash -c "$SIGNCHECK") >"${WORK}/inst.log" 2>&1
		RC=$?
	}
	sign_check "$good"
	if [ "$RC" -eq 0 ]; then ok "sign-windows accepts the installer build-windows hashed"; else no "sign-windows accepts the installer build-windows hashed" "$(cat "${WORK}/inst.log")"; fi
	sign_check ""
	if [ "$RC" -ne 0 ] && grep -qF "::error::build-windows reported no digest" "${WORK}/inst.log"; then ok "sign-windows refuses when build-windows reported no digest"; else no "sign-windows refuses when build-windows reported no digest" "$(cat "${WORK}/inst.log")"; fi
	printf 'swapped\n' >"${WORK}/inst/sidecar/Jarvis-Setup.exe"
	sign_check "$good"
	if [ "$RC" -ne 0 ]; then ok "sign-windows refuses an installer replaced after the build hashed it"; else no "sign-windows refuses an installer replaced after the build hashed it"; fi
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
