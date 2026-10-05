import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Exercise the real shell orchestration/parser without an image build. The
// Docker CI job still performs the real BuildKit cache comparison.
const script = resolve(dirname(fileURLToPath(import.meta.url)), "../.github/scripts/version-stamp-cache.sh");
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});

const manifest = { name: "cache-check-fixture", version: "1.2.3", dependencies: { example: "2.0.0" } };
const vertices = [
  ["manifest", "RUN normalize manifest", "DONE 0.1s"],
  ["deps", "RUN bun install", "CACHED"],
  ["build", "RUN bun run build:ui", "CACHED"],
  ["build", "RUN echo 'VERSION build-arg is required'", "DONE 0.1s"],
  ["workflows", "RUN bun run build:workflow-pieces", "CACHED"],
  ["production", "COPY --from=workflows /app/dist ./dist", "CACHED"],
  ["production", "COPY --from=build /app/package.json ./package.json", "DONE 0.1s"],
  ["production", "RUN validate version", "DONE 0.1s"],
] as const;

function buildLog(change?: { index: number; status?: string; omit?: boolean }, platform = "") {
  return vertices.flatMap(([stage, label, status], index) => {
    if (change?.index === index && change.omit) return [];
    const id = `#${index + 1}`;
    return [
      `${id} [${platform}${stage} ${index + 1}/8] ${label}`,
      `${id} ${change?.index === index ? change.status ?? status : status}`,
    ];
  }).join("\n") + "\n";
}

function run(log = buildLog(), failBuild = false) {
  const directory = mkdtempSync(join(tmpdir(), "jarvis-cache-test-"));
  directories.push(directory);
  const repo = join(directory, "repo");
  const bin = join(directory, "bin");
  mkdirSync(repo);
  mkdirSync(bin);
  const source = JSON.stringify(manifest) + "\n";
  writeFileSync(join(repo, "package.json"), source);
  writeFileSync(join(repo, "untracked.txt"), "must not enter the context");
  // Git hooks export index/worktree variables. The fixture must use its own
  // repository even when this test is invoked by the normal pre-commit hook.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  for (const args of [["init", "--quiet"], ["add", "package.json"]]) {
    const result = Bun.spawnSync(["git", "-C", repo, ...args], { env });
    expect(result.exitCode).toBe(0);
  }
  writeFileSync(join(directory, "build.log"), log);
  // Model only the jq invocation the script owns. CI's Docker job uses real jq.
  writeFileSync(join(bin, "jq"), `#!/usr/bin/env bun
const args = process.argv.slice(2);
if (args.length !== 5 || args[0] !== '--arg' || args[1] !== 'v' || args[3] !== '.version = $v') process.exit(2);
const value = await Bun.file(args[4]).json();
value.version = args[2];
console.log(JSON.stringify(value, null, 2));
`, { mode: 0o755 });
  writeFileSync(join(bin, "docker"), `#!/usr/bin/env bun
import { appendFileSync, existsSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] !== 'buildx' || args[1] !== 'build') process.exit(2);
const context = args.at(-1);
const manifest = await Bun.file(context + '/package.json').json();
appendFileSync(process.env.RECORD, JSON.stringify({
  manifest, version: args[args.indexOf('--build-arg') + 1].slice('VERSION='.length),
  untracked: existsSync(context + '/untracked.txt'), context
}) + '\\n');
if (process.env.FAIL_BUILD === '1') { console.error('fixture build failure'); process.exit(17); }
console.log(await Bun.file(process.env.BUILD_LOG).text());
`, { mode: 0o755 });
  const result = Bun.spawnSync(["bash", script, repo], {
    env: {
      ...env,
      PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH}`,
      STAMP_CACHE_TAG: "regression",
      RECORD: join(directory, "record"),
      BUILD_LOG: join(directory, "build.log"),
      FAIL_BUILD: failBuild ? "1" : "0",
    },
  });
  const output = result.stdout.toString() + result.stderr.toString();
  if (!existsSync(join(directory, "record"))) throw new Error(`No build was invoked: ${output}`);
  const records = readFileSync(join(directory, "record"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  // The caller's manifest and untracked files never get mutated or copied.
  expect(readFileSync(join(repo, "package.json"), "utf8")).toBe(source);
  expect(records.every(record => record.untracked === false)).toBe(true);
  return { code: result.exitCode, output, records };
}

describe("release cache check", () => {
  test("warms a fresh manifest as well as VERSION before the version-only comparison", () => {
    const result = run();
    expect(result.code).toBe(0);
    expect(result.records).toHaveLength(2);
    expect(result.records.map(record => record.version)).toEqual([
      "0.0.0-stamp-check.warm.regression", "0.0.0-stamp-check.regression",
    ]);
    for (const record of result.records) {
      expect(record.manifest).toEqual({ ...manifest, version: record.version });
    }
    expect(result.records[0].context).toBe(result.records[1].context);
  });

  test("accepts platform-prefixed BuildKit output", () => {
    expect(run(buildLog(undefined, "linux/amd64 ")).code).toBe(0);
  });

  for (const index of [1, 2, 4, 5] as const) {
    test(`rejects an uncached ${vertices[index][0]} step`, () => {
      const result = run(buildLog({ index, status: "DONE 0.1s" }));
      expect(result.code).toBe(1);
      expect(result.output).toContain("re-ran steps that should be cache hits");
      expect(result.output).toContain(vertices[index][1]);
    });
  }

  test("rejects an unknown step outcome", () => {
    expect(run(buildLog({ index: 1, status: "waiting" })).code).toBe(1);
  });

  test("requires the version stamp to execute", () => {
    const result = run(buildLog({ index: 3, status: "CACHED" }));
    expect(result.code).toBe(1);
    expect(result.output).toContain("stamp step did not run");
  });

  for (const index of [1, 2, 3, 4, 6]) {
    test(`fails closed when required vertex ${index + 1} is missing`, () => {
      expect(run(buildLog({ index, omit: true })).code).toBe(1);
    });
  }

  test("surfaces a build failure and stops before comparison", () => {
    const result = run(buildLog(), true);
    expect(result.code).toBe(1);
    expect(result.records).toHaveLength(1);
    expect(result.output).toContain("fixture build failure");
  });
});
