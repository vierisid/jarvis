import {
  ACTION_CATEGORIES,
  type ActionCategory,
} from "../../v2/rooms/authority/useAuthorityData";
export { ACTION_CATEGORIES, type ActionCategory };

export const CATEGORY_LABELS: Record<ActionCategory, string> = {
  read_data: "Read data",
  write_data: "Write data",
  delete_data: "Delete data",
  send_message: "Send messages",
  send_email: "Send email",
  execute_command: "Run commands",
  install_software: "Install software",
  make_payment: "Make payments",
  modify_settings: "Change settings",
  spawn_agent: "Create agents",
  terminate_agent: "Stop agents",
  access_browser: "Use browser",
  control_app: "Control apps",
};
export interface AuthorityValues {
  default_level: number;
  // Preserve additive categories from newer servers, even though this view only edits the known thirteen.
  governed_categories: string[];
}
export interface AuthoritySettings extends AuthorityValues {
  emergency_state: "normal" | "paused" | "killed";
}
export type AuthorityDestination = "advanced-authority" | "emergency-controls";
export type ReadResult =
  | { state: "ready"; data: AuthoritySettings }
  | { state: "error" | "unavailable" | "unsupported" };
export type SaveResult =
  | { state: "confirmed" | "conflict"; data: AuthoritySettings }
  | { state: "unknown" | "unavailable" | "unsupported" };
export type NavigationResult = { state: "opened" | "unavailable" };
export interface AuthorityPort {
  scopeId: string;
  source: "live" | "fixture";
  canWrite: boolean;
  destinations: Readonly<Record<AuthorityDestination, boolean>>;
  read(signal: AbortSignal): Promise<ReadResult>;
  save(
    base: AuthorityValues,
    draft: AuthorityValues,
    signal: AbortSignal,
  ): Promise<SaveResult>;
  navigate(
    destination: AuthorityDestination,
    signal: AbortSignal,
  ): Promise<NavigationResult>;
}
export const validLevel = (value: unknown): value is number =>
  Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 10;
export function readSettings(value: unknown): AuthoritySettings | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Partial<AuthoritySettings>;
  if (
    !validLevel(v.default_level) ||
    !Array.isArray(v.governed_categories) ||
    v.governed_categories.length > 200 ||
    v.governed_categories.some(
      (s) => typeof s !== "string" || !/^[a-z][a-z0-9_]{0,99}$/.test(s),
    ) ||
    new Set(v.governed_categories).size !== v.governed_categories.length ||
    !["normal", "paused", "killed"].includes(v.emergency_state ?? "")
  )
    return null;
  return {
    default_level: v.default_level,
    governed_categories: [...v.governed_categories],
    emergency_state: v.emergency_state!,
  };
}
export const sameCategories = (a: string[], b: string[]) =>
  a.length === b.length && a.every((v) => b.includes(v));
export const sameValues = (a: AuthorityValues, b: AuthorityValues) =>
  a.default_level === b.default_level &&
  sameCategories(a.governed_categories, b.governed_categories);
export function changedValues(
  base: AuthorityValues,
  draft: AuthorityValues,
): Partial<AuthorityValues> {
  return {
    ...(base.default_level !== draft.default_level
      ? { default_level: draft.default_level }
      : {}),
    ...(!sameCategories(base.governed_categories, draft.governed_categories)
      ? { governed_categories: [...draft.governed_categories] }
      : {}),
  };
}
export function matchesPatch(
  data: AuthorityValues,
  patch: Partial<AuthorityValues>,
) {
  return (
    (patch.default_level === undefined ||
      data.default_level === patch.default_level) &&
    (patch.governed_categories === undefined ||
      sameCategories(data.governed_categories, patch.governed_categories))
  );
}
