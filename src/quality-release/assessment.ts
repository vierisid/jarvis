import { CONDITIONS, DISPOSITIONS, JOURNEYS, PREREQUISITES, QUALITY_CHECKS, SAFETY_KEYS, TASK_DISPOSITIONS, type Disposition, type Proof } from './contract';
import { hash, profileHash, sha, validRecord } from './validation';
import { artifactMatches, artifactProblems, type Artifacts } from './artifacts';
import { measurementMet, measurementSummary } from './measurements';
export { hash, validRecord } from './validation';

function matchingProof(p: Proof | null, candidate: string, identity: string, now: number, kind?: Proof['kind']): boolean {
  return !!p && p.reviewed && p.candidate === candidate && p.runtimeHash === identity
    && Date.parse(p.finishedAt) <= now && (!kind || p.kind === kind);
}
export function assessProductQuality(input: unknown, expectedCandidate: string, now = new Date(), artifacts: Artifacts = new Map()) {
  if (!sha(expectedCandidate) || !Number.isFinite(now.getTime()) || !validRecord(input)) {
    return { schemaVersion: 1, status: 'blocked', deploymentAuthorized: false,
      blockers: ['invalid_release_record'], profiles: [], prerequisites: [] };
  }
  const r = input, blockers: string[] = artifactProblems(input, artifacts);
  if (r.candidate !== expectedCandidate) blockers.push('candidate_mismatch');
  const frozen = !blockers.includes('q01_frozen_rubric_required') && !blockers.includes('supplement_frozen_rubric_required') && r.rubric.status === 'frozen' && r.rubric.approved && r.rubric.budgetsAgreed
    && r.rubric.frozenAt !== null && Date.parse(r.rubric.frozenAt) <= now.getTime();
  if (!frozen) blockers.push('rubric_not_frozen');
  // A supplement covers opportunity/recall dimensions not encoded by Q01's
  // workflow-only rubric. Both must be frozen before any release measurement.
  const rubricHash = hash({ q01: r.rubric.q01Hash, supplement: r.rubric.supplementHash });
  for (const deployment of ['local', 'hosted']) if (!r.profiles.some(p => p.deployment === deployment)) blockers.push(`${deployment}_profile_missing`);
  const prerequisites = PREREQUISITES.map(card => {
    const row = r.prerequisites.find(p => p.card === card);
    // Integration evidence uses a candidate-wide identity, not one profile's hash.
    const passed = row?.disposition === 'passed' && artifactMatches(row, artifacts) && matchingProof(row.proof, expectedCandidate, hash({ candidate: expectedCandidate }), now.getTime(), 'deterministic');
    if (!passed) blockers.push(`prerequisite_not_passed:${card}`);
    return { card, disposition: row?.disposition === 'passed' && !passed ? 'blocked' : row?.disposition ?? 'not_run',
      integratedHead: row?.integratedHead ?? null, artifact: row?.proof?.artifact ?? null };
  });
  const profiles = r.profiles.map(p => {
    const reasons: string[] = [];
    const identity = profileHash(p);
    if (p.runtime.brain !== expectedCandidate || (p.deployment === 'hosted' ? !p.runtime.hosting : p.runtime.hosting !== null)) reasons.push('runtime_mismatch');
    if (!p.jobs.length) reasons.push('job_scope_missing');
    if (!p.runtime.model || !p.runtime.profileRevision) reasons.push('profile_unresolved');
    const journeys = JOURNEYS.flatMap(journey => CONDITIONS.map(condition => {
      const row = p.journeys.find(v => v.journey === journey && v.condition === condition);
      let status: Disposition = row?.disposition ?? 'not_run';
      if (row?.safety && SAFETY_KEYS.some(k => row.safety![k] > 0)) status = 'failed';
      else if (status === 'passed' && (!artifactMatches(row!, artifacts) || !matchingProof(row!.proof, expectedCandidate, identity, now.getTime(), 'deterministic') || !row!.safety)) status = 'blocked';
      if (status !== 'passed') reasons.push(`journey:${journey}/${condition}:${status}`);
      return { journey, condition, disposition: status, safety: row?.safety ? Object.fromEntries(SAFETY_KEYS.map(k => [k, row.safety![k]])) : null,
        artifact: row?.proof?.artifact ?? null };
    }));
    const quality = QUALITY_CHECKS.map(check => {
      const row = p.quality.find(v => v.check === check);
      let status: Disposition = row?.disposition ?? 'not_run';
      if (row?.verdict === 'not_met' || (row?.taskDispositions.missed_abstention ?? 0) > 0 || row?.safety && SAFETY_KEYS.some(k => row.safety![k] > 0)) status = 'failed';
      else if (status === 'passed' && (!artifactMatches(row!, artifacts) || !frozen || row!.rubricHash !== rubricHash || row!.verdict !== 'met'
        || !matchingProof(row!.proof, expectedCandidate, identity, now.getTime(), 'heldout')
        || Date.parse(r.rubric.frozenAt!) > Date.parse(row!.proof!.startedAt)
        || !row!.measurement || !row!.safety
        || row!.supportedTasks < (artifacts.get(r.rubric.q01Hash) as any)?.sample?.minSupportedTasks || row!.negativeTasks < (artifacts.get(r.rubric.q01Hash) as any)?.sample?.minNegativeTasks || row!.measured !== row!.scheduled)) status = 'blocked';
      else if (status === 'passed' && !measurementMet(row!, artifacts.get(r.rubric.q01Hash), artifacts.get(r.rubric.supplementHash), p.id)) status = 'failed';
      if (status !== 'passed') reasons.push(`quality:${check}:${status}`);
      return { check, disposition: status, scheduled: row?.scheduled ?? 0, measured: row?.measured ?? 0,
        safety: row?.safety ? Object.fromEntries(SAFETY_KEYS.map(k => [k, row.safety![k]])) : null, taskDispositions: Object.fromEntries(TASK_DISPOSITIONS.map(s => [s, row?.taskDispositions[s] ?? 0])), measurement: measurementSummary(row), supportedTasks: row?.supportedTasks ?? 0, negativeTasks: row?.negativeTasks ?? 0, artifact: row?.proof?.artifact ?? null };
    });
    let live = p.liveConnector.disposition;
    if (live === 'passed' && (!artifactMatches(p.liveConnector, artifacts) || !matchingProof(p.liveConnector.proof, expectedCandidate, identity, now.getTime(), 'live_sandbox'))) live = 'blocked';
    if (live === 'failed') reasons.push('live_connector_failed');
    // Live checks are reported independently. A missing optional connector run
    // cannot be called passed; deterministic coverage never upgrades it.
    const counts = Object.fromEntries(DISPOSITIONS.map(s => [s, [...journeys, ...quality].filter(v => v.disposition === s).length]));
    return { id: p.id, deployment: p.deployment, runtimeHash: identity, status: reasons.length || blockers.length ? 'blocked' : 'passed',
      supportedJobs: reasons.length || blockers.length ? [] : [...p.jobs], declaredJobs: [...p.jobs], blockers: reasons, counts, journeys, quality,
      liveConnector: { disposition: live, artifact: p.liveConnector.proof?.artifact ?? null } };
  });
  return { schemaVersion: 1, candidate: expectedCandidate, status: blockers.length || profiles.some(p => p.status !== 'passed') ? 'blocked' : 'passed',
    deploymentAuthorized: false, rubricHash, blockers, prerequisites, profiles,
    limitations: ['Reviewed evidence attestations are not cryptographic proof of their contents.',
      'This assessment does not enable features, approve deployment, or certify unlisted profiles or jobs.',
      'Live connector checks are separate from deterministic journeys and heldout quality measurements.'] };
}
