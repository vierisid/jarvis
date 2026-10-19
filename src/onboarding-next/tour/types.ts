import type { TourStep } from './steps.ts';
export type Scope = { actorId: string; projectId: string };
/** Local structural projection: journey is the only durable progress owner. */
export interface Journey {
  schemaVersion: 1; scopeId: string; journeyId: string; revision: number; stepId: string;
  setupState: string; interviewState: string; tourState: 'pending' | 'in_progress' | 'done' | 'skipped';
  tourStepId: string | null; legacyTourStepId: string | null; replayReturnStepId: string | null;
  activationState: string; completion: string;
}
export type JourneyResult = { availability: 'ready'; snapshot: Journey; replayed?: boolean }
  | { availability: 'unavailable' | 'unsupported'; reason: string; snapshot?: Journey };
export type Transition<C> = { journeyId: string; expectedRevision: number; requestId: string; command: C };
export interface JourneyPort {
  read(): Promise<JourneyResult>;
  acknowledge(input: Transition<{ type: 'tour_progress'; stepId: string } | { type: 'tour_finished'; state: 'done' | 'skipped' }>): Promise<JourneyResult>;
  transition(input: Transition<{ type: 'replay_tutorial' }>): Promise<JourneyResult>;
}
export type RoomStatus = 'ready' | 'unsupported' | 'unavailable';
export interface TourSnapshot {
  schemaVersion: 1; scopeId: string; sessionId: string; revision: number;
  active: boolean; stepId: TourStep | null; roomStatus: RoomStatus;
  journey: Journey;
}
export type TourResult = { availability: 'ready'; snapshot: TourSnapshot; replayed?: boolean }
  | { availability: 'unsupported' | 'unavailable'; reason: string };
export type TourAction = 'back' | 'next' | 'skip' | 'finish';
export type TourCommand = { type: 'read' }
  | { type: 'replay'; sessionId: string; revision: number; requestId: string }
  | { type: 'navigate'; sessionId: string; revision: number; requestId: string; from: TourStep; action: TourAction; to?: TourStep | 'first-workflow' };
export interface TourDependencies<C> {
  enabled?: boolean;
  /** Authenticated server context, rechecked before writes and replies. */
  authorize(context: C): Scope | null | Promise<Scope | null>;
  /** Must bind B01 authorization/persistence to this same scope and live context. */
  journeyFor(scope: Scope, context: C): JourneyPort;
  /** Trusted room-adapter capability observation. Absence never means ready. */
  roomStatus?(scope: Scope, step: TourStep): RoomStatus | Promise<RoomStatus>;
}
