export type UserProfileQuestionId =
  | 'preferred_name'
  | 'pronouns'
  | 'location_timezone'
  | 'work_role'
  | 'interests'
  | 'current_projects'
  | 'goals_next_90_days'
  | 'communication_preferences'
  | 'pet_peeves'
  | 'routines_constraints'
  | 'tools_stack'
  | 'important_people'
  | 'anything_else';

export type UserProfileQuestion = {
  id: UserProfileQuestionId;
  step: number;
  step_title: string;
  label: string;
  prompt: string;
  description: string;
  placeholder?: string;
  multiline?: boolean;
};

/**
 * One structured fact captured by the conversational onboarding
 * interviewer (Phase B). Themes match the 9 topics the interviewer
 * agent is told to cover (identity / work / projects / goals /
 * ambitions / communication / rhythm / tools / what-jarvis-does).
 *
 * Stored separately from the wizard `answers` map so the two surfaces
 * coexist cleanly: the wizard is the structured-edit surface, the
 * interview is the conversational capture path. Both feed the same
 * "About the user" markdown block injected into Jarvis's system prompt.
 */
export type UserProfileFact = {
  theme: string;
  summary: string;
  raw_quote?: string;
  recorded_at: number;
};

export type UserProfileRecord = {
  version: 1;
  answers: Partial<Record<UserProfileQuestionId, string>>;
  /** Structured facts from the Phase B conversational interview. */
  interview_facts?: UserProfileFact[];
  created_at: number;
  updated_at: number;
  completed_at: number | null;
};

export const USER_PROFILE_SETTING_KEY = 'user.profile.v1';

export const USER_PROFILE_QUESTIONS: UserProfileQuestion[] = [
  {
    id: 'preferred_name',
    step: 1,
    step_title: 'Identity',
    label: 'Preferred Name',
    prompt: 'What should JARVIS call you?',
    description: 'Use the name you actually want the assistant to use in conversation.',
    placeholder: 'e.g. Alex',
  },
  {
    id: 'pronouns',
    step: 1,
    step_title: 'Identity',
    label: 'Pronouns',
    prompt: 'What pronouns do you want JARVIS to use, if any?',
    description: 'Optional, but useful for natural and respectful replies.',
    placeholder: 'e.g. she/her, he/him, they/them',
  },
  {
    id: 'location_timezone',
    step: 1,
    step_title: 'Identity',
    label: 'Location / Timezone',
    prompt: 'What location or timezone should JARVIS keep in mind?',
    description: 'This helps with scheduling, recommendations, and time references.',
    placeholder: 'e.g. Miami, FL / America/New_York',
  },
  {
    id: 'work_role',
    step: 1,
    step_title: 'Identity',
    label: 'Work / Role',
    prompt: 'What do you do, or what roles do you usually operate in?',
    description: 'Career, studies, side hustles, and the kinds of responsibilities you handle.',
    placeholder: 'e.g. founder, student, engineer, creator',
    multiline: true,
  },
  {
    id: 'interests',
    step: 2,
    step_title: 'Interests',
    label: 'Interests',
    prompt: 'What are you genuinely interested in?',
    description: 'Topics, hobbies, communities, subjects, and rabbit holes you care about.',
    placeholder: 'e.g. AI, fitness, cars, anime, startups',
    multiline: true,
  },
  {
    id: 'current_projects',
    step: 2,
    step_title: 'Interests',
    label: 'Current Projects',
    prompt: 'What are you actively working on right now?',
    description: 'Projects, businesses, classes, routines, or personal efforts already in motion.',
    placeholder: 'What is already on your plate?',
    multiline: true,
  },
  {
    id: 'goals_next_90_days',
    step: 2,
    step_title: 'Interests',
    label: 'Goals',
    prompt: 'What do you want to accomplish over the next 30 to 90 days?',
    description: 'Short-term outcomes that JARVIS should optimize around.',
    placeholder: 'What should JARVIS help push forward?',
    multiline: true,
  },
  {
    id: 'communication_preferences',
    step: 3,
    step_title: 'Working Style',
    label: 'Communication Preferences',
    prompt: 'How do you want JARVIS to communicate with you?',
    description: 'Tone, directness, detail level, structure, reminders, and how much pushback you want.',
    placeholder: 'e.g. blunt, concise, actionable, no fluff',
    multiline: true,
  },
  {
    id: 'pet_peeves',
    step: 3,
    step_title: 'Working Style',
    label: 'Pet Peeves',
    prompt: 'What annoys you or wastes your time?',
    description: 'Patterns to avoid in planning, writing, or collaboration.',
    placeholder: 'What should JARVIS not do?',
    multiline: true,
  },
  {
    id: 'routines_constraints',
    step: 3,
    step_title: 'Working Style',
    label: 'Routines & Constraints',
    prompt: 'What routines, limits, or constraints should JARVIS know?',
    description: 'Schedule constraints, health habits, budget limits, availability, or boundaries.',
    placeholder: 'Anything that should shape reminders or recommendations',
    multiline: true,
  },
  {
    id: 'tools_stack',
    step: 4,
    step_title: 'Context',
    label: 'Tools & Stack',
    prompt: 'What tools, apps, or technical stack do you use most?',
    description: 'Software, devices, languages, frameworks, and workflows JARVIS should assume.',
    placeholder: 'e.g. GitHub, Bun, React, Notion, Telegram, Windows',
    multiline: true,
  },
  {
    id: 'important_people',
    step: 4,
    step_title: 'Context',
    label: 'Important People',
    prompt: 'Who are the important people, teams, or audiences around you?',
    description: 'Managers, cofounders, clients, family, friends, or communities that matter in your context.',
    placeholder: 'Who should JARVIS keep in mind?',
    multiline: true,
  },
  {
    id: 'anything_else',
    step: 4,
    step_title: 'Context',
    label: 'Anything Else',
    prompt: 'What else should JARVIS know to be useful from day one?',
    description: 'Any extra context that does not fit the earlier prompts.',
    placeholder: 'Anything important you want carried forward',
    multiline: true,
  },
];

export function createEmptyUserProfile(): UserProfileRecord {
  const now = Date.now();
  return {
    version: 1,
    answers: {},
    created_at: now,
    updated_at: now,
    completed_at: null,
  };
}

export function normalizeUserProfileAnswers(
  input: Record<string, unknown>,
): Partial<Record<UserProfileQuestionId, string>> {
  const answers: Partial<Record<UserProfileQuestionId, string>> = {};

  for (const question of USER_PROFILE_QUESTIONS) {
    const raw = input[question.id];
    if (typeof raw !== 'string') continue;
    const value = raw.trim();
    if (!value) continue;
    answers[question.id] = value;
  }

  return answers;
}

export function countAnsweredUserProfileQuestions(profile: UserProfileRecord | null): number {
  if (!profile) return 0;
  return USER_PROFILE_QUESTIONS.filter((question) => Boolean(profile.answers[question.id]?.trim())).length;
}

export function hasUserProfile(profile: UserProfileRecord | null): boolean {
  return (
    countAnsweredUserProfileQuestions(profile) > 0 ||
    (profile?.interview_facts?.length ?? 0) > 0
  );
}

/**
 * Render the user profile (wizard answers + Phase B interview facts) as
 * a prompt block. Wizard answers come first as a YAML-ish list (existing
 * format kept verbatim for backwards compatibility); interview facts
 * follow as a per-theme markdown section. Returns undefined when neither
 * source has any data so the caller can omit the block entirely.
 *
 * Called by the chat agent's `buildPromptContext` AND by the voice
 * intent classifier — both paths get the same context so Jarvis is
 * consistent across modalities.
 */
export function formatUserProfileForPrompt(profile: UserProfileRecord | null): string | undefined {
  if (!profile) return undefined;

  const lines: string[] = [];

  for (const question of USER_PROFILE_QUESTIONS) {
    const answer = profile.answers[question.id]?.trim();
    if (!answer) continue;
    lines.push(`- ${question.label}: |`);
    lines.push(indentPromptValue(answer));
  }

  // Interview facts grouped by theme. Sorted alphabetically by theme so
  // the output is stable across saves (helps with prompt caching and
  // makes diffs reviewable).
  const facts = profile.interview_facts ?? [];
  if (facts.length > 0) {
    const byTheme = new Map<string, UserProfileFact[]>();
    for (const f of facts) {
      const arr = byTheme.get(f.theme) ?? [];
      arr.push(f);
      byTheme.set(f.theme, arr);
    }
    const themes = [...byTheme.keys()].sort();

    if (lines.length > 0) lines.push('');
    lines.push('## From the onboarding interview');
    for (const theme of themes) {
      lines.push('');
      lines.push(`### ${capitalize(theme)}`);
      for (const f of byTheme.get(theme)!) {
        lines.push(`- ${f.summary}`);
      }
    }
  }

  if (lines.length === 0) return undefined;
  return lines.join('\n');
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

function indentPromptValue(value: string): string {
  return value
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');
}
