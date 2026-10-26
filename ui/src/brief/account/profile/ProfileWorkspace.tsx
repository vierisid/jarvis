import React, {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
} from "react";
import { UserRound } from "lucide-react";
import { isBriefCapabilityEnabled } from "../../../../../src/brief/capabilities";
import type { BriefRoomModule, BriefShellPort } from "../../contracts";
import {
  BriefButton,
  BriefInput,
  BriefTextarea,
} from "../../components/controls";
import { ProfileController } from "./controller";
import { PROFILE_FIELDS } from "./model";
import { hasProfileNavigationGuard } from "./navigation";
import "./profile.css";

export interface ProfileBinding {
  controller: ProfileController;
  source: "fixture" | "live";
  scopeId: string;
  capabilities?: unknown;
}
export function profileAvailable(
  shell: BriefShellPort,
  binding?: ProfileBinding,
) {
  return (
    !!binding &&
    binding.source === binding.controller.source &&
    binding.scopeId === binding.controller.scopeId &&
    hasProfileNavigationGuard(shell, binding.controller) &&
    (shell.mode === "preview"
      ? binding.source === "fixture"
      : binding.source === "live" &&
        isBriefCapabilityEnabled(binding.capabilities, "profileSettings"))
  );
}
export function ProfileWorkspace({
  shell,
  binding,
}: {
  shell: BriefShellPort;
  binding?: ProfileBinding;
}) {
  const allowed = profileAvailable(shell, binding),
    previous = useRef<ProfileController | undefined>(undefined);
  useLayoutEffect(() => {
    if (previous.current !== binding?.controller)
      previous.current?.setAccess(false);
    previous.current = binding?.controller;
    binding?.controller.setAccess(allowed);
  }, [allowed, binding?.controller]);
  if (!allowed || !binding)
    return (
      <section className="brief-profile">
        <h1 className="brief-type-room-title">Profile</h1>
        <p role="status">Profile is unavailable here.</p>
      </section>
    );
  return (
    <ProfileBody
      key={`${binding.source}:${binding.scopeId}`}
      controller={binding.controller}
    />
  );
}
const FIELD_ERROR = "Use 4,000 characters or fewer.";
const RESERVE_STATUS =
  "Profile changed elsewhere. Cancel edits to load the current values.";
function ProfileBody({ controller }: { controller: ProfileController }) {
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.snapshot,
    controller.snapshot,
  );
  const dialog = useRef<HTMLDialogElement>(null),
    returnFocus = useRef<HTMLElement | null>(null),
    id = useId();
  useEffect(() => {
    void controller.refresh(); // A return through the account menu reads canonical data.
    const refresh = () => {
      if (document.visibilityState !== "hidden") void controller.refresh();
    };
    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (controller.hasEdits()) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    const timer = setInterval(refresh, 5000);
    window.addEventListener("focus", refresh);
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("beforeunload", beforeUnload);
    };
  }, [controller]);
  useLayoutEffect(() => {
    if (state.prompt && dialog.current && !dialog.current.open) {
      returnFocus.current = document.activeElement as HTMLElement;
      dialog.current.showModal();
    } else if (!state.prompt && dialog.current?.open) {
      dialog.current.close();
      if (returnFocus.current?.isConnected)
        returnFocus.current.focus({ preventScroll: true });
    }
  }, [state.prompt]);
  const field = (item: (typeof PROFILE_FIELDS)[number]) => {
    const value = item.questionId ? controller.value(item.questionId) : "";
    const shared = {
      label: item.label,
      value,
      disabled: !item.questionId || !controller.canWrite || state.discarding,
      readOnly: !controller.editable(),
      onChange: (
        e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
      ) => {
        if (item.questionId) controller.edit(item.questionId, e.target.value);
      },
      hint: item.questionId
        ? undefined
        : "Managed by your sign-in provider. Not available here.",
      error: value.length > 4000 ? FIELD_ERROR : undefined,
      reserveMessage: item.questionId ? FIELD_ERROR : undefined,
      autoComplete: "off",
    };
    // All canonical answers may contain legacy line breaks. Keep the element
    // type stable while editing or polling, with compact fields still at 44px.
    return item.questionId ? (
      <BriefTextarea
        key={item.id}
        {...shared}
        rows={item.multiline ? 3 : 1}
        className={
          item.multiline
            ? "brief-profile-multiline"
            : "brief-profile-singleline"
        }
      />
    ) : (
      <BriefInput key={item.id} {...shared} />
    );
  };
  const invalid = Object.values(state.draft).some((v) => v!.length > 4000);
  return (
    <section
      className="brief-profile"
      aria-busy={state.availability === "loading"}
    >
      <h1 className="brief-type-room-title">Profile</h1>
      <div className="brief-profile-identity">
        <span aria-hidden="true">
          <UserRound size={23} />
        </span>
        <div>
          <strong>Your profile</strong>
          <p>Account identity is managed by your sign-in provider.</p>
        </div>
      </div>
      {state.base ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void controller.save();
          }}
        >
          {!!state.base.interviewFacts?.length && <section aria-labelledby={`${id}-interview`}>
            <h2 id={`${id}-interview`}>From your interview</h2>
            <p className="brief-profile-interview-help">Saved during onboarding. You can correct or forget these details in Memory.</p>
            <dl className="brief-profile-interview">
              {state.base.interviewFacts.map((fact, index) => <div key={`${fact.theme}:${index}`}>
                <dt>{fact.theme}</dt><dd>{fact.summary}</dd>
              </div>)}
            </dl>
          </section>}
          <section aria-labelledby={`${id}-about`}>
            <h2 id={`${id}-about`}>About you</h2>
            <div className="brief-profile-fields">
              {PROFILE_FIELDS.slice(0, 4).map(field)}
            </div>
          </section>
          <section aria-labelledby={`${id}-context`}>
            <h2 id={`${id}-context`}>Your context</h2>
            <div className="brief-profile-context">
              {PROFILE_FIELDS.slice(4).map(field)}
            </div>
          </section>
          <div className="brief-profile-save">
            <div className="brief-profile-feedback">
              <span aria-hidden="true">
                Read-only profile. {RESERVE_STATUS}
              </span>
              <p role="status" aria-live="polite">
                {!controller.canWrite && "Read-only profile. "}
                {state.message}
              </p>
            </div>
            <div className="brief-profile-actions">
              <BriefButton
                variant="text"
                disabled={state.phase === "saving" || state.reading}
                onClick={() => controller.cancel()}
              >
                {controller.hasEdits() ? "Cancel" : "Reload profile"}
              </BriefButton>
              <BriefButton
                type="submit"
                variant="primary"
                disabled={
                  !controller.canWrite ||
                  state.availability !== "ready" ||
                  invalid ||
                  state.discarding ||
                  !["dirty", "error", "unknown", "saving"].includes(state.phase)
                }
                state={
                  state.phase === "saving"
                    ? "pending"
                    : state.phase === "saved"
                      ? "success"
                      : state.phase === "error" || state.phase === "unknown"
                        ? "error"
                        : "idle"
                }
                stateLabels={{
                  pending: "Saving…",
                  success: "Saved",
                  error: "Retry save",
                }}
              >
                Save changes
              </BriefButton>
            </div>
          </div>
          {state.availability === "stale" && (
            <BriefButton
              variant="text"
              disabled={state.reading}
              onClick={() => void controller.refresh()}
            >
              Refresh profile
            </BriefButton>
          )}
        </form>
      ) : (
        <div className="brief-profile-empty">
          <p role="status">
            {state.availability === "loading"
              ? "Loading profile…"
              : state.availability === "unsupported"
                ? "This connection does not support Profile yet."
                : state.availability === "unavailable"
                  ? "Profile is unavailable."
                  : "Could not load your profile."}
          </p>
          {state.availability !== "loading" && (
            <BriefButton
              disabled={state.reading}
              onClick={() => void controller.refresh()}
            >
              Retry
            </BriefButton>
          )}
        </div>
      )}
      <dialog
        ref={dialog}
        className="brief-profile-dialog"
        aria-labelledby={`${id}-confirm`}
        onCancel={(e) => {
          e.preventDefault();
          void controller.resolvePrompt(false);
        }}
      >
        <h2 id={`${id}-confirm`}>Discard unsaved changes?</h2>
        <p>
          Your edits have not been confirmed.{" "}
          {state.phase === "unknown"
            ? "A previous save may already have applied. "
            : ""}
          {state.prompt === "leave"
            ? "Leaving discards only your local edits."
            : "Current saved values will replace this draft after a successful reload."}
        </p>
        <div>
          <BriefButton
            autoFocus
            variant="secondary"
            onClick={() => void controller.resolvePrompt(false)}
          >
            Keep editing
          </BriefButton>
          <BriefButton
            variant="primary"
            onClick={() => void controller.resolvePrompt(true)}
          >
            {state.prompt === "leave"
              ? "Leave without saving"
              : "Discard edits"}
          </BriefButton>
        </div>
      </dialog>
    </section>
  );
}
export function profileRegistration(
  useBinding: (shell: BriefShellPort) => ProfileBinding | undefined,
): BriefRoomModule {
  return {
    id: "profile",
    title: "Profile",
    legacyRoom: "settings",
    Body: ({ shell }) => (
      <ProfileWorkspace shell={shell} binding={useBinding(shell)} />
    ),
  };
}
