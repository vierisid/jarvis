import { hash, validRecord } from './validation';
import type { ReleaseRecord } from './contract';
export type Artifacts = ReadonlyMap<string, unknown>;
/** Artifact contents stay private. Only their content hashes leave the audit.
 * Review attests the verdict, but missing/edited files cannot satisfy the gate. */
export function artifactMatches(row: { proof: import('./contract').Proof | null }, artifacts: Artifacts): boolean {
  if (!row.proof) return false;
  const { artifact, reviewed, ...identity } = row.proof;
  const { proof, ...summary } = row;
  const saved: any = artifacts.get(artifact);
  return !!saved && hash(saved) === artifact && hash(saved.identity ?? null) === hash(identity) && hash(saved.summary ?? null) === hash(summary);
}
export function artifactProblems(record: ReleaseRecord, artifacts: Artifacts): string[] {
  const problems: string[] = [];
  const get = (key: string): any => {
    const value = artifacts.get(key);
    if (value === undefined || hash(value) !== key) { problems.push('artifact_missing_or_changed:' + key); return null; }
    return value;
  };
  if (!validRecord(record)) return ['invalid_release_record'];
  const q01 = get(record.rubric.q01Hash), supplement = get(record.rubric.supplementHash);
  if (record.rubric.status === 'frozen') {
    const approvers = (v: any) => Array.isArray(v) && v.length >= 2 && new Set(v).size === v.length && v.every(n => typeof n === 'string' && n.trim());
    const share = (v: any) => Number.isFinite(v) && v >= 0 && v <= 1;
    const when = Date.parse(record.rubric.frozenAt ?? '');
    if (q01?.schemaVersion !== 1 || q01?.status !== 'frozen' || !approvers(q01.frozen?.approvedBy) || !Number.isFinite(Date.parse(q01.frozen?.at)) || Date.parse(q01.frozen.at) > when
      || !['point-estimate', 'lower-bound'].includes(q01.decision) || !['automatic', 'human-reviewed'].includes(q01.intent?.measure)
      || q01.sample?.unit !== 'task' || q01.sample?.repeatAggregation !== 'all'
      || !Number.isSafeInteger(q01.sample?.minSupportedTasks) || !Number.isSafeInteger(q01.sample?.minNegativeTasks)
      || !share(q01.intent?.minFirstCandidateCorrect) || !share(q01.intent?.minCorrectAfterRepair)
      || !(q01.sample?.minSupportedTasks >= 40) || !(q01.sample?.minNegativeTasks >= 20)
      || !(q01.intent?.minFirstCandidateCorrect >= .9) || !(q01.intent?.minCorrectAfterRepair >= .95)
      || q01.safety?.maxUnexpectedEffects !== 0 || q01.safety?.maxMissedAbstentions !== 0
      || !Number.isFinite(q01.humanEffort?.maxMedianEdits) || q01.humanEffort.maxMedianEdits < 0
      || !Number.isFinite(q01.humanEffort?.maxMedianCorrectionMs) || q01.humanEffort.maxMedianCorrectionMs < 0
      || !(q01.humanEffort?.maxMedianEdits <= 1) || !(q01.humanEffort?.maxMedianCorrectionMs <= 120000)
      || !q01.budgets || !Object.values(q01.budgets).length
      || !Object.values(q01.budgets).every((b: any) => ['maxRequestsPerTask', 'maxTokensPerTask', 'maxP95CompositionMs'].every(k => Number.isFinite(b?.[k]) && b[k] > 0))) {
      problems.push('q01_frozen_rubric_required');
    }
    if (supplement?.schemaVersion !== 1 || supplement?.status !== 'frozen' || !Number.isFinite(Date.parse(supplement.frozenAt))
      || Date.parse(supplement.frozenAt) > when || !approvers(supplement.approvedBy)
      || !share(supplement.minUsefulOpportunityRate) || !share(supplement.maxNegativeProposalRate) || !share(supplement.minQualifiedRecallRate)
      || !(supplement.minUsefulOpportunityRate >= .8) || !(supplement.maxNegativeProposalRate <= .05)
      || !(supplement.minQualifiedRecallRate >= .95) || supplement.maxInventedInputs !== 0) problems.push('supplement_frozen_rubric_required');
  }
  for (const row of [...record.prerequisites, ...record.profiles.flatMap(p => [...p.journeys, ...p.quality, p.liveConnector])]) {
    if (row.disposition !== 'passed' || !row.proof) continue;
    const { artifact } = row.proof;
    const saved = get(artifact);
    // A proof is a reviewed evidence package. Its identity, verdict and exact
    // summary must match the imported row; notes/raw evidence are not exported.
    if (!saved || !artifactMatches(row, artifacts)) problems.push('artifact_summary_mismatch:' + artifact);
  }
  return [...new Set(problems)];
}
