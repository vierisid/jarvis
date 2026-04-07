import { deleteSetting, getSetting, setSetting } from '../vault/settings.ts';
import {
  USER_PROFILE_QUESTIONS,
  type UserProfileQuestion,
  type UserProfileQuestionId,
} from './profile.ts';
import { getUserProfile, saveUserProfile } from '../vault/user-profile.ts';

const USER_PROFILE_FOLLOWUP_STATE_KEY = 'user.profile.followup.v1';
const MIN_MESSAGES_BEFORE_FIRST_ASK = 6;
const MIN_MESSAGES_BETWEEN_ASKS = 8;
const MIN_MS_BETWEEN_ASKS = 45 * 60 * 1000;

type UserProfileFollowupState = {
  version: 1;
  pending_question_id: UserProfileQuestionId | null;
  total_user_messages: number;
  asked_at_user_message_count: number | null;
  last_asked_at: number | null;
  last_answered_at: number | null;
};

type FollowupTurnResult = {
  answeredQuestion?: UserProfileQuestion;
  skippedQuestion?: UserProfileQuestion;
};

const DEFAULT_STATE: UserProfileFollowupState = {
  version: 1,
  pending_question_id: null,
  total_user_messages: 0,
  asked_at_user_message_count: null,
  last_asked_at: null,
  last_answered_at: null,
};

const QUESTION_PRIORITY: UserProfileQuestionId[] = [
  'communication_preferences',
  'current_projects',
  'goals_next_90_days',
  'tools_stack',
  'routines_constraints',
  'pet_peeves',
  'important_people',
  'work_role',
  'location_timezone',
  'interests',
  'pronouns',
  'anything_else',
  'preferred_name',
];

export function recordUserProfileTurn(text: string): FollowupTurnResult {
  const state = getFollowupState();
  state.total_user_messages += 1;

  const pendingQuestion = state.pending_question_id
    ? USER_PROFILE_QUESTIONS.find((question) => question.id === state.pending_question_id) ?? null
    : null;

  if (!pendingQuestion) {
    saveFollowupState(state);
    return {};
  }

  if (isSkipResponse(text)) {
    state.pending_question_id = null;
    saveFollowupState(state);
    return { skippedQuestion: pendingQuestion };
  }

  if (!looksLikeProfileAnswer(text)) {
    saveFollowupState(state);
    return {};
  }

  const existing = getUserProfile();
  const answers = {
    ...(existing?.answers ?? {}),
    [pendingQuestion.id]: text.trim(),
  };
  saveUserProfile(answers);

  state.pending_question_id = null;
  state.last_answered_at = Date.now();
  saveFollowupState(state);
  return { answeredQuestion: pendingQuestion };
}

export function maybeCreateUserProfileFollowupPrompt(): string | null {
  const profile = getUserProfile();
  if (!profile) return null;

  const state = getFollowupState();
  if (state.pending_question_id) return null;

  const unanswered = getUnansweredQuestions(profile.answers);
  if (unanswered.length === 0) return null;

  const now = Date.now();
  if (state.last_asked_at && now - state.last_asked_at < MIN_MS_BETWEEN_ASKS) {
    return null;
  }

  if (state.asked_at_user_message_count === null) {
    if (state.total_user_messages < MIN_MESSAGES_BEFORE_FIRST_ASK) {
      return null;
    }
  } else if (state.total_user_messages - state.asked_at_user_message_count < MIN_MESSAGES_BETWEEN_ASKS) {
    return null;
  }

  const question = unanswered[0]!;
  state.pending_question_id = question.id;
  state.asked_at_user_message_count = state.total_user_messages;
  state.last_asked_at = now;
  saveFollowupState(state);

  return [
    'One quick question so I can personalize better:',
    question.prompt,
    '',
    `${question.description} You can answer briefly, or say "skip" if you do not want to answer right now.`,
  ].join('\n');
}

export function clearUserProfileFollowupState(): void {
  deleteSetting(USER_PROFILE_FOLLOWUP_STATE_KEY);
}

function getFollowupState(): UserProfileFollowupState {
  const raw = getSetting(USER_PROFILE_FOLLOWUP_STATE_KEY);
  if (!raw) return { ...DEFAULT_STATE };

  try {
    const parsed = JSON.parse(raw) as Partial<UserProfileFollowupState>;
    return {
      version: 1,
      pending_question_id: isQuestionId(parsed.pending_question_id) ? parsed.pending_question_id : null,
      total_user_messages: typeof parsed.total_user_messages === 'number' ? parsed.total_user_messages : 0,
      asked_at_user_message_count: typeof parsed.asked_at_user_message_count === 'number' ? parsed.asked_at_user_message_count : null,
      last_asked_at: typeof parsed.last_asked_at === 'number' ? parsed.last_asked_at : null,
      last_answered_at: typeof parsed.last_answered_at === 'number' ? parsed.last_answered_at : null,
    };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

function saveFollowupState(state: UserProfileFollowupState): void {
  setSetting(USER_PROFILE_FOLLOWUP_STATE_KEY, JSON.stringify(state));
}

function isQuestionId(value: unknown): value is UserProfileQuestionId {
  return typeof value === 'string' && USER_PROFILE_QUESTIONS.some((question) => question.id === value);
}

function getUnansweredQuestions(
  answers: Partial<Record<UserProfileQuestionId, string>>,
): UserProfileQuestion[] {
  const unansweredIds = new Set(
    USER_PROFILE_QUESTIONS
      .filter((question) => !answers[question.id]?.trim())
      .map((question) => question.id),
  );

  return QUESTION_PRIORITY
    .filter((questionId) => unansweredIds.has(questionId))
    .map((questionId) => USER_PROFILE_QUESTIONS.find((question) => question.id === questionId))
    .filter((question): question is UserProfileQuestion => Boolean(question));
}

function looksLikeProfileAnswer(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed.length > 600) return false;
  if (trimmed.includes('?')) return false;
  if (/^(can you|could you|would you|please|what|why|how|when|where|who)\b/i.test(trimmed)) return false;
  if (/\b(run|open|read|write|edit|check|search|find|look up|browse|visit|show me)\b/i.test(trimmed)) return false;
  return true;
}

function isSkipResponse(text: string): boolean {
  return /^(skip|not now|maybe later|later|no thanks|no thank you|pass)$/i.test(text.trim());
}
