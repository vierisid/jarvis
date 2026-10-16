import type { Inventory } from './discovery';
export interface Candidate { backend: string; frontend: string; sidecar: string; tree: string; dirty: boolean; }
export type Outcome = 'passed' | 'failed' | 'blocked' | 'not_run';
export interface Artifact { path: string; sha256: string; }
export interface Row { id: string; outcome: Outcome; reason: string; evidence: Artifact[]; }
export interface Observation { schemaVersion: 1; candidate: Candidate; caseId: string; kind: 'mocked' | 'manual' | 'real-provider'; checks: { id: string; passed: boolean }[]; details: unknown;
  artifacts: Artifact[]; observedAt: string; environment?: string;
  profiles?: { id: string; version: string; outcome: 'passed' | 'failed'; spendUsd: number }[]; }
export interface Profile { id: string; version: string; }
export interface Report { schemaVersion: 1; candidate: Candidate; inventory: Inventory; cases: Row[];
  visual?: Artifact; gates: { owner: string; receipt: Artifact }[];
  staging?: { profiles: Profile[]; registry: Artifact; spendApproval: Artifact };
}
