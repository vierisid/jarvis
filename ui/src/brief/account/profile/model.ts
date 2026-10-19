/** Profile form model for F-23 contract v1 (#945). Only a ProfilePort reaches the owner; no second profile store. */
export const PROFILE_FIELDS = [
  { id: "full_name", label: "Full name", questionId: null, multiline: false },
  {
    id: "preferred_name",
    label: "What should Jarvis call you?",
    questionId: "preferred_name",
    multiline: false,
  },
  { id: "company", label: "Company", questionId: "company", multiline: false },
  { id: "role", label: "Role", questionId: "work_role", multiline: false },
  {
    id: "projects",
    label: "What are you building?",
    questionId: "current_projects",
    multiline: true,
  },
  {
    id: "working_style",
    label: "How you like to work",
    questionId: "communication_preferences",
    multiline: true,
  },
] as const;
export type ProfileField = Exclude<
  (typeof PROFILE_FIELDS)[number]["questionId"],
  null
>;
export type ProfilePatch = Partial<Record<ProfileField, string | null>>;
export type ProfileDraft = Partial<Record<ProfileField, string>>;
export interface ProfileValue {
  revision: string;
  answers: Record<string, string>;
}
export type ProfileRead =
  | { state: "ready"; data: ProfileValue }
  | { state: "error" | "unavailable" | "unsupported" };
export type ProfileSave =
  | { state: "confirmed"; data: ProfileValue }
  | {
      state: "conflict" | "unknown" | "invalid" | "unavailable" | "unsupported";
    };
export interface ProfilePort {
  scopeId: string;
  source: "live" | "fixture";
  canWrite: boolean;
  read(signal: AbortSignal): Promise<ProfileRead>;
  save(
    revision: string,
    patch: ProfilePatch,
    signal: AbortSignal,
  ): Promise<ProfileSave>;
}
export const isField = (id: string): id is ProfileField =>
  PROFILE_FIELDS.some((f) => f.questionId === id);
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
export function readProfile(value: unknown): ProfileValue | null {
  if (
    !record(value) ||
    typeof value.revision !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.revision) ||
    !record(value.answers)
  )
    return null;
  if (
    Object.entries(value.answers).some(
      ([key, answer]) =>
        !/^[a-z][a-z0-9_]{0,99}$/.test(key) ||
        typeof answer !== "string" ||
        answer.length > 4000,
    ) ||
    JSON.stringify(value.answers).length > 256000
  )
    return null;
  return {
    revision: value.revision,
    answers: { ...value.answers } as Record<string, string>,
  };
}
export function draftPatch(draft: ProfileDraft): ProfilePatch {
  return Object.fromEntries(
    Object.entries(draft).map(([key, value]) => [key, value.trim() || null]),
  );
}
export function validPatch(value: ProfilePatch) {
  const keys = Object.keys(value);
  return (
    keys.length > 0 &&
    keys.every(
      (key) =>
        isField(key) &&
        (value[key] === null ||
          (typeof value[key] === "string" && value[key].length <= 4000)),
    )
  );
}
export function matchesProfilePatch(value: ProfileValue, patch: ProfilePatch) {
  return Object.entries(patch).every(
    ([key, answer]) => (value.answers[key] ?? "") === (answer?.trim() ?? ""),
  );
}
