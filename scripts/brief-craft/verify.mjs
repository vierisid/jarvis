import { readFile, stat, realpath } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { assessReport, validEvidencePath } from "./report.mjs";
const [path, head] = process.argv.slice(2);
if (!path || !head) {
  console.error("Usage: bun scripts/brief-craft/verify.mjs report.json <full-git-head>");
  process.exitCode = 2;
} else {
  try {
    const report = JSON.parse(await readFile(path, "utf8"));
    const assessment = assessReport(report, head);
    const root = await realpath(dirname(resolve(path)));
    const artifacts = new Set([
      ...(report.cases ?? []).flatMap(row => row.evidence ?? []),
      ...(report.capabilities ?? []).map(row => row.evidence),
    ]);
    for (const artifact of artifacts) {
      try {
        if (!validEvidencePath(artifact)) throw Error("Invalid path");
        const file = await realpath(resolve(root, artifact));
        if (!file.startsWith(root + sep) || !(await stat(file)).isFile() || !(await stat(file)).size) throw Error("Missing artifact");
      } catch { assessment.errors.push(`Missing, empty or external artifact: ${artifact}`); }
    }
    assessment.releaseReady &&= !assessment.errors.length;
    console.log(JSON.stringify(assessment, null, 2));
    process.exitCode = assessment.releaseReady ? 0 : 1;
  } catch (error) {
    console.error(`Invalid evidence: ${error.message}`);
    process.exitCode = 2;
  }
}
