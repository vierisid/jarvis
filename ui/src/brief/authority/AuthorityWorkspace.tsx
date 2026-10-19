import React, {
  useEffect,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
} from "react";
import { ArrowUpRight } from "lucide-react";
import { isBriefCapabilityEnabled } from "../../../../src/brief/capabilities";
import type { BriefRoomModule, BriefShellPort } from "../contracts";
import { BriefButton, BriefSwitch } from "../components/controls";
import { AuthorityController } from "./controller";
import { ACTION_CATEGORIES, CATEGORY_LABELS } from "./model";
import { AuthoritySlider } from "./AuthoritySlider";
import "./authority.css";

export interface AuthorityBinding {
  controller: AuthorityController;
  scopeId: string;
  source: "live" | "fixture";
  capabilities?: unknown;
}
export function authorityAvailable(
  shell: BriefShellPort,
  binding?: AuthorityBinding,
) {
  return (
    !!binding &&
    binding.scopeId === binding.controller.scopeId &&
    binding.source === binding.controller.source &&
    (shell.mode === "preview"
      ? binding.source === "fixture"
      : binding.source === "live" &&
        isBriefCapabilityEnabled(
          binding.capabilities,
          "navigationCompatibility",
        ) &&
        binding.controller.destinations["advanced-authority"] &&
        binding.controller.destinations["emergency-controls"])
  );
}
export function AuthorityWorkspace({
  shell,
  binding,
}: {
  shell: BriefShellPort;
  binding?: AuthorityBinding;
}) {
  const allowed = authorityAvailable(shell, binding);
  const previous = useRef<AuthorityController | undefined>(undefined);
  useLayoutEffect(() => {
    if (previous.current !== binding?.controller)
      previous.current?.setAccess(false);
    previous.current = binding?.controller;
    binding?.controller.setAccess(allowed);
  }, [allowed, binding?.controller]);
  if (!binding || !allowed)
    return (
      <section className="brief-authority">
        <h1 className="brief-type-room-title">Authority</h1>
        <p role="status">Authority settings are unavailable here.</p>
      </section>
    );
  return (
    <AuthorityBody
      key={`${binding.source}:${binding.scopeId}`}
      controller={binding.controller}
    />
  );
}
function AuthorityBody({ controller }: { controller: AuthorityController }) {
  const room = useRef<HTMLElement>(null);
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.snapshot,
    controller.snapshot,
  );
  useEffect(() => {
    const refresh = () => {
      // A background read disables writes while it runs. Do not blur a focused
      // control just because the polling timer or browser focus fired.
      if (
        document.visibilityState !== "hidden" &&
        !room.current?.contains(document.activeElement)
      )
        void controller.refresh();
    };
    const timer = setInterval(refresh, 5000);
    window.addEventListener("focus", refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [controller]);
  const disabled = !controller.editable();
  const uncertain = state.phase === "unknown" || state.phase === "conflict";
  return (
    <section
      ref={room}
      className="brief-authority"
      aria-busy={state.availability === "loading"}
    >
      <h1 className="brief-type-room-title">Authority</h1>
      {state.saved && state.draft ? (
        <>
          {state.saved.emergency_state !== "normal" && (
            <p className="brief-authority-notice" role="status">
              {state.saved.emergency_state === "paused"
                ? "Paused: tool actions are held until you resume."
                : "Emergency stop is active: tools are refused and agent runs are stopped until you reset."}{" "}
              Use Emergency controls to review the current state.
            </p>
          )}
          <section
            className="brief-authority-level"
            aria-labelledby="authority-level-heading"
          >
            <h2 id="authority-level-heading">Default authority level</h2>
            <AuthoritySlider
              value={state.draft.default_level}
              disabled={disabled}
              beginInteraction={controller.beginInteraction}
              endInteraction={controller.endInteraction}
              onChange={(level) => controller.setLevel(level)}
            />
          </section>
          <section
            className="brief-authority-governed"
            aria-labelledby="authority-governed-heading"
          >
            <h2 id="authority-governed-heading">Governed actions</h2>
            <p className="brief-authority-legend">
              On asks for approval before these actions, even when the level
              allows them. Off uses the authority level and other rules:
              overrides, context rules and the approval asked after Jarvis reads
              outside content still apply.
            </p>
            <div className="brief-authority-categories">
              {[ACTION_CATEGORIES.slice(0, 7), ACTION_CATEGORIES.slice(7)].map(
                (categories, index) => (
                  <ul key={index}>
                    {categories.map((category) => (
                      <li key={category}>
                        <span>{CATEGORY_LABELS[category]}</span>
                        <BriefSwitch
                          label={CATEGORY_LABELS[category]}
                          checked={state.draft!.governed_categories.includes(
                            category,
                          )}
                          disabled={disabled}
                          onCheckedChange={(on) =>
                            controller.toggle(category, on)
                          }
                        />
                      </li>
                    ))}
                  </ul>
                ),
              )}
            </div>
          </section>
          <div className="brief-authority-save">
            <p role="status" aria-live="polite">
              {!controller.canWrite && "Read-only settings. "}
              {state.message}
            </p>
            <div>
              <BriefButton
                variant="text"
                disabled={state.phase === "saving" || state.reading}
                onClick={() => void controller.refresh(true)}
              >
                {state.phase === "dirty"
                  ? state.retryFields.length
                    ? "Discard retry"
                    : "Discard changes"
                  : "Reload settings"}
              </BriefButton>
              <BriefButton
                variant="primary"
                disabled={state.phase !== "dirty" || !controller.editable()}
                state={
                  state.phase === "saving"
                    ? "pending"
                    : state.phase === "saved"
                      ? "success"
                      : "idle"
                }
                stateLabels={{ pending: "Saving…", success: "Saved" }}
                onClick={() => void controller.save()}
              >
                {state.retryFields.length ? "Retry save" : "Save changes"}
              </BriefButton>
            </div>
          </div>
          {uncertain && (
            <p className="brief-authority-note">
              Your edits remain visible for comparison. No further save will run
              until current settings are reloaded.
            </p>
          )}
        </>
      ) : (
        <div className="brief-authority-empty" role="status">
          <p>
            {state.availability === "loading"
              ? "Loading authority settings…"
              : state.availability === "unsupported"
                ? "Authority settings are not supported by this connection."
                : state.availability === "unavailable"
                  ? "Authority settings are unavailable."
                  : "Could not load authority settings."}
          </p>
          {state.availability !== "loading" && (
            <BriefButton
              disabled={state.reading}
              onClick={() => void controller.refresh(true)}
            >
              Retry
            </BriefButton>
          )}
        </div>
      )}
      <nav
        className="brief-authority-advanced"
        aria-label="Advanced authority controls"
      >
        <BriefButton
          variant="text"
          disabled={!controller.destinations["advanced-authority"]}
          onClick={() => void controller.navigate("advanced-authority")}
        >
          Advanced overrides <ArrowUpRight size={14} aria-hidden="true" />
        </BriefButton>
        <BriefButton
          variant="text"
          disabled={!controller.destinations["emergency-controls"]}
          onClick={() => void controller.navigate("emergency-controls")}
        >
          Emergency controls <ArrowUpRight size={14} aria-hidden="true" />
        </BriefButton>
      </nav>
      <p className="brief-authority-note" role="status">
        {state.navigationMessage ||
          (!controller.destinations["advanced-authority"] ||
          !controller.destinations["emergency-controls"]
            ? "Advanced controls are unavailable in this connection."
            : "")}
      </p>
    </section>
  );
}
export function authorityRegistration(
  useBinding: (shell: BriefShellPort) => AuthorityBinding | undefined,
): BriefRoomModule {
  return {
    id: "authority",
    title: "Authority",
    legacyRoom: "authority",
    Body: ({ shell }) => (
      <AuthorityWorkspace shell={shell} binding={useBinding(shell)} />
    ),
  };
}
