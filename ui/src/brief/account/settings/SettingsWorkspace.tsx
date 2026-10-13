import React, {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
} from "react";
import { ArrowRight } from "lucide-react";
import { isBriefCapabilityEnabled } from "../../../../../src/brief/capabilities";
import type { BriefRoomModule, BriefShellPort } from "../../contracts";
import {
  BriefButton,
  BriefSelect,
  BriefSegments,
} from "../../components/controls";
import { AppearanceSelector } from "./AppearanceSelector";
import { SettingsController } from "./controller";
import type { SettingsDestination } from "./model";
import "./settings.css";
export interface SettingsBinding {
  controller: SettingsController;
  scopeId: string;
  source: "live" | "fixture";
  capabilities?: unknown;
}
export function settingsAvailable(
  shell: BriefShellPort,
  binding?: SettingsBinding,
) {
  return (
    !!binding &&
    binding.scopeId === binding.controller.scopeId &&
    binding.source === binding.controller.source &&
    (shell.mode === "preview"
      ? binding.source === "fixture"
      : binding.source === "live" &&
        isBriefCapabilityEnabled(binding.capabilities, "profileSettings") &&
        isBriefCapabilityEnabled(
          binding.capabilities,
          "navigationCompatibility",
        ) &&
        binding.controller.destinations.authority &&
        binding.controller.destinations.connections &&
        binding.controller.destinations["voice-settings"] &&
        binding.controller.destinations["advanced-settings"])
  );
}
export function SettingsWorkspace({
  shell,
  binding,
}: {
  shell: BriefShellPort;
  binding?: SettingsBinding;
}) {
  const allowed = settingsAvailable(shell, binding),
    previous = useRef<SettingsController | undefined>(undefined);
  useLayoutEffect(() => {
    if (previous.current !== binding?.controller)
      previous.current?.setAccess(false);
    previous.current = binding?.controller;
    binding?.controller.setAccess(allowed);
  }, [allowed, binding?.controller]);
  if (!allowed || !binding)
    return (
      <section className="brief-settings">
        <h1 className="brief-type-room-title">Settings</h1>
        <p role="status">Settings are unavailable here.</p>
      </section>
    );
  return (
    <SettingsBody
      key={`${binding.source}:${binding.scopeId}`}
      controller={binding.controller}
    />
  );
}
function SettingsBody({ controller }: { controller: SettingsController }) {
  const state = useSyncExternalStore(
      controller.subscribe,
      controller.snapshot,
      controller.snapshot,
    ),
    id = useId();
  const dialog = useRef<HTMLDialogElement>(null),
    returnFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    void controller.refresh();
    const refresh = () => {
      if (document.visibilityState !== "hidden") void controller.refresh();
    };
    const timer = setInterval(refresh, 5000);
    window.addEventListener("focus", refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [controller]);
  const confirming = state.replay === "confirm";
  useLayoutEffect(() => {
    if (confirming && dialog.current && !dialog.current.open) {
      returnFocus.current = document.activeElement as HTMLElement;
      dialog.current.showModal();
    } else if (!confirming && dialog.current?.open) {
      dialog.current.close();
      if (returnFocus.current?.isConnected)
        returnFocus.current.focus({ preventScroll: true });
    }
  }, [confirming]);
  const data = state.base,
    voice = data?.voice,
    value = controller.value(),
    pending = state.phase === "saving";
  const retry = ["unknown", "error"].includes(state.phase);
  const link = (
    destination: SettingsDestination,
    label: string,
    description: string,
  ) => (
    <button
      type="button"
      className="brief-settings-destination"
      disabled={
        !controller.destinations[destination] || state.replay === "pending"
      }
      onClick={() => void controller.navigate(destination)}
    >
      <span>
        <strong>{label}</strong>
        <small>
          {description}
          {!controller.destinations[destination] && " · Unavailable here"}
        </small>
      </span>
      <ArrowRight size={17} aria-hidden="true" />
    </button>
  );
  return (
    <section
      className="brief-settings"
      aria-busy={state.availability === "loading"}
    >
      <header>
        <h1 className="brief-type-room-title">Settings</h1>
        <AppearanceSelector />
      </header>
      <section aria-labelledby={`${id}-conversation`}>
        <h2 id={`${id}-conversation`}>Conversation</h2>
        <div className="brief-settings-row">
          <div>
            <h3>Natural realtime voice</h3>
            <p>Live conversation voice is managed separately.</p>
          </div>
          <BriefButton
            variant="text"
            disabled={!controller.destinations["voice-settings"]}
            onClick={() => void controller.navigate("voice-settings")}
          >
            Open voice settings
          </BriefButton>
        </div>
        <div className="brief-settings-row brief-settings-voice">
          <div>
            <h3>Voice</h3>
            <p>
              {voice?.state === "editable"
                ? voice.enabled
                  ? "Voice for spoken responses."
                  : "Voice for spoken responses. Spoken responses are currently off."
                : voice?.reason === "settings_unreadable"
                  ? "Voice settings could not be read."
                  : "Voice selection is unavailable here."}
            </p>
          </div>
          <BriefSelect
            label="Voice"
            value={value}
            disabled={!controller.editable()}
            onChange={(e) => void controller.selectVoice(e.target.value)}
            aria-describedby={`${id}-voice-status`}
          >
            {!voice?.choices.some((c) => c.id === value) && (
              <option value={value}>
                {value
                  ? "Current voice unavailable"
                  : state.availability === "loading"
                    ? "Loading…"
                    : "Unavailable"}
              </option>
            )}
            {voice?.choices.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </BriefSelect>
        </div>
        <div className="brief-settings-feedback">
          <p id={`${id}-voice-status`} role="status" aria-live="polite">
            {state.availability === "loading"
              ? "Loading settings…"
              : ["unsupported", "unavailable"].includes(state.availability)
                ? "Settings are unavailable from this connection."
                : state.message ||
                  (!controller.canWrite ? "Read-only settings." : "")}
          </p>
          <div>
            <BriefButton
              variant="text"
              disabled={pending || state.reading}
              onClick={() => void controller.refresh(state.draft !== null)}
            >
              {state.draft !== null
                ? "Discard change and reload"
                : "Refresh settings"}
            </BriefButton>
            <BriefButton
              variant="primary"
              className={
                !retry && !pending ? "brief-settings-retry-hidden" : ""
              }
              aria-hidden={!retry && !pending}
              tabIndex={!retry && !pending ? -1 : undefined}
              disabled={!controller.editable() || !retry}
              state={pending ? "pending" : "idle"}
              onClick={() => void controller.save()}
            >
              Retry save
            </BriefButton>
          </div>
        </div>
      </section>
      <section aria-labelledby={`${id}-checkins`}>
        <h2 id={`${id}-checkins`}>Check-ins</h2>
        <p>How often Jarvis brings you a useful next step.</p>
        <BriefSegments
          label="Check-in frequency — unavailable"
          value=""
          options={[
            { value: "less", label: "Less often", disabled: true },
            { value: "balanced", label: "Balanced", disabled: true },
            { value: "more", label: "More often", disabled: true },
          ]}
          onValueChange={() => {}}
        />
        <p className="brief-settings-unavailable">
          Check-in preferences are not supported yet.
        </p>
        <div className="brief-settings-row">
          <h3>Active hours</h3>
          <span className="brief-settings-unavailable">Unavailable</span>
        </div>
      </section>
      <section aria-labelledby={`${id}-workspace`}>
        <h2 id={`${id}-workspace`}>Workspace controls</h2>
        {link("authority", "Authority", "Permissions & approvals")}
        {link("connections", "Connected workspace", "Devices & services")}
        {link(
          "advanced-settings",
          "Advanced settings",
          data?.setup.deployment === "hosted"
            ? "Provider setup is managed by your hosted service."
            : data?.setup.deployment === "self_hosted"
              ? "Local configuration & support"
              : "Configuration & support",
        )}
        <div className="brief-settings-row">
          <div>
            <h3>Replay the tutorial</h3>
            <p>Your profile and provider setup stay unchanged.</p>
          </div>
          <BriefButton
            disabled={
              !controller.canWrite ||
              !controller.canReplayTutorial ||
              !data?.replay.includes("tutorial") ||
              state.availability !== "ready" ||
              state.draft !== null ||
              ["pending", "unknown", "replayed"].includes(state.replay)
            }
            state={state.replay === "pending" ? "pending" : "idle"}
            onClick={() => controller.requestReplay()}
          >
            Replay
          </BriefButton>
        </div>
        <p
          role="status"
          aria-live="polite"
          className="brief-settings-action-status"
        >
          {state.actionMessage ||
            (!controller.canReplayTutorial
              ? "Tutorial replay is unavailable here."
              : "")}
        </p>
      </section>
      <dialog
        ref={dialog}
        className="brief-settings-dialog"
        aria-labelledby={`${id}-replay-title`}
        onCancel={(e) => {
          e.preventDefault();
          void controller.confirmReplay(false);
        }}
      >
        <h2 id={`${id}-replay-title`}>Replay the tutorial?</h2>
        <p>
          The page will reload to the tutorial. Your profile and provider setup
          stay unchanged.
        </p>
        <div>
          <BriefButton
            autoFocus
            variant="text"
            onClick={() => void controller.confirmReplay(false)}
          >
            Keep settings
          </BriefButton>
          <BriefButton
            variant="primary"
            onClick={() => void controller.confirmReplay(true)}
          >
            Replay tutorial
          </BriefButton>
        </div>
      </dialog>
    </section>
  );
}
export function settingsRegistration(
  binding?: SettingsBinding,
): BriefRoomModule {
  return {
    id: "settings",
    title: "Settings",
    legacyRoom: "settings",
    Body: ({ shell }) => <SettingsWorkspace shell={shell} binding={binding} />,
  };
}
