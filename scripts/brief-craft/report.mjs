import { requiredCases, ROOMS } from "./matrix.mjs";

/** Fail closed: missing, duplicate, unknown, skipped, stale and fixture evidence
 * must never produce a release pass. This is a verifier, not an activation flag. */
export function assessReport(report, expectedHead) {
  const errors = [];
  if (!/^[a-f0-9]{40}$/.test(expectedHead ?? "")) errors.push("Expected a full Git revision.");
  if (report?.schema !== "brief-craft-v1") errors.push("Unknown report schema.");
  if (report?.head !== expectedHead) errors.push("Evidence is for a different revision.");
  if (!Number.isFinite(Date.parse(report?.capturedAt ?? ""))) errors.push("Missing capture time.");
  const expected = requiredCases(), byId = new Map();
  for (const row of Array.isArray(report?.cases) ? report.cases : []) {
    if (!expected.some(test => test.id === row?.id)) errors.push(`Unknown case: ${row?.id}`);
    if (byId.has(row?.id)) errors.push(`Duplicate case: ${row?.id}`);
    byId.set(row?.id, row);
    if (!["passed", "failed", "blocked"].includes(row?.status)) errors.push(`Invalid status: ${row?.id}`);
    if (row?.status === "passed" && (!Array.isArray(row.evidence) || !row.evidence.length || row.evidence.some(path => !validEvidencePath(path)))) errors.push(`Missing or invalid evidence: ${row.id}`);
    if (row?.status !== "passed" && (typeof row?.reason !== "string" || !row.reason.trim())) errors.push(`Missing reason: ${row?.id}`);
  }
  const missing = expected.filter(test => !byId.has(test.id)).map(test => test.id);
  const failed = expected.filter(test => byId.get(test.id)?.status === "failed").map(test => test.id);
  const blocked = expected.filter(test => byId.get(test.id)?.status === "blocked").map(test => test.id);
  const passed = expected.filter(test => byId.get(test.id)?.status === "passed").length;
  const releaseBlocks = [];
  if (report?.source !== "live") releaseBlocks.push("Fixture evidence does not establish enabled runtime behavior.");
  for (const room of ROOMS) {
    const evidence = (Array.isArray(report?.capabilities) ? report.capabilities : []).filter(row => row?.room === room.id);
    if (evidence.length !== 1 || evidence[0].head !== expectedHead || evidence[0].enabled !== true || !validEvidencePath(evidence[0].evidence)) releaseBlocks.push(`Enabled capability evidence missing: ${room.id}`);
  }
  return { required: expected.length, passed, missing, failed, blocked, errors, releaseBlocks,
    releaseReady: !errors.length && !missing.length && !failed.length && !blocked.length && !releaseBlocks.length };
}

export function validEvidencePath(path) {
  return typeof path === "string" && !!path.trim() && !path.startsWith("/") && !path.includes("\\") && !path.split("/").includes("..") && !path.includes(":");
}

export function completeReport(report) {
  const present = new Set(report.cases.map(row => row.id));
  return { ...report, cases: [...report.cases, ...requiredCases().filter(test => !present.has(test.id)).map(test => ({ id: test.id, status: "blocked", reason: "Not executed on this revision/runtime.", evidence: [] }))] };
}
