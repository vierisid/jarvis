import React, {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useTheme } from "../../v2/shell/useTheme";
import type { BriefRoute, BriefShellPort } from "../contracts";
import { NavigationShell } from "../shell/navigation/NavigationShell";
import { UNKNOWN_NAVIGATION } from "../shell/navigation/model";
import { BriefButton } from "../components/controls";
import { ConversationComposer } from "../chat/composer/ConversationComposer";
import { DecisionsRoom } from "./DecisionsRoom";
import {
  makeDecisionsFixture,
  DECISIONS_SCOPE,
  DECISION_EXAMPLES,
  type DecisionExample,
} from "./fixtures";
import "../today/preview/specimen.css";

/** Fixture entry only. Production mounts the room through its optional registration. */
export function DecisionsSpecimen() {
  const [theme, setTheme] = useTheme(),
    [sidebar, setSidebar] = useState<"expanded" | "rail">("expanded"),
    [chatOpen, setChatOpen] = useState(false),
    [draft, setDraft] = useState("");
  const [example, setExample] = useState<DecisionExample>("ready"),
    [reset, setReset] = useState(0),
    [route, setRoute] = useState<BriefRoute>({
      room: "needs-you",
      selection: {},
    });
  const [destination, setDestination] = useState<BriefRoute | null>(null);
  const fixture = useMemo(
    () => makeDecisionsFixture(example, 180),
    [example, reset],
  );
  useEffect(() => () => fixture.controller.retire(), [fixture]);
  const state = useSyncExternalStore(
    fixture.controller.subscribe,
    fixture.controller.snapshot,
    fixture.controller.snapshot,
  );
  const shell = useMemo<BriefShellPort>(
    () => ({
      mode: "preview",
      theme,
      setTheme,
      sidebar,
      setSidebar,
      chatOpen,
      setChatOpen,
      route,
      navigate: (next) =>
        next.room === "workflow" ? setDestination(next) : setRoute(next),
    }),
    [theme, setTheme, sidebar, chatOpen, route],
  );
  return (
    <div className="brief-root brief-today-specimen" data-brief-theme={theme}>
      <div
        className="brief-today-review-toolbar"
        aria-label="Isolated review controls"
      >
        <span>D-23 · Decisions</span>
        <button onClick={() => setTheme(theme === "light" ? "dark" : "light")}>
          Switch to {theme === "light" ? "dark" : "light"}
        </button>
        <label>
          Example{" "}
          <select
            aria-label="Decision example"
            value={example}
            onChange={(e) => setExample(e.target.value as DecisionExample)}
          >
            {DECISION_EXAMPLES.map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
        </label>
        <button onClick={() => setReset((n) => n + 1)}>Reset example</button>
        <button
          onClick={() => {
            fixture.reorder();
            void fixture.controller.refresh();
          }}
        >
          Reorder decisions
        </button>
        <small>
          Illustrative decisions only. Nothing is sent or changed on your
          account.
        </small>
      </div>
      <div className="brief-today-review-viewport" style={{ width: "100%" }}>
        <NavigationShell
          shell={shell}
          rooms={{
            "needs-you": { id: "needs-you", title: "Needs you" },
          }}
          binding={{
            capabilities: null,
            view: {
              source: "fixture",
              state: {
                status: "ready",
                data: {
                  ...UNKNOWN_NAVIGATION,
                  workspaceName: "Vieri’s workspace",
                  connection: "connected",
                  account: {
                    name: "Vieri Balboni",
                    plan: { status: "ready", data: "Pro plan" },
                  },
                  badges: {
                    "needs-you":
                      state.read.status === "ready"
                        ? state.rows.length
                        : undefined,
                  },
                },
              },
            },
          }}
          conversation={{
            source: "fixture",
            content: (
              <>
                <div className="sample-conversation-tabs">General</div>
                <div className="sample-conversation-thread">
                  <h2 className="brief-type-section-heading">
                    What are we moving forward?
                  </h2>
                </div>
                <ConversationComposer
                  mode="preview"
                  binding={{
                    source: "fixture",
                    scopeId: "d23-preview-chat",
                    conversationId: "general",
                    mode: "scoped",
                    connected: true,
                    metadataPending: false,
                    draft,
                    turn: null,
                    pendingAcceptance: false,
                    error: null,
                    actions: {
                      setDraft,
                      send: () => setDraft(""),
                      cancel: () => {},
                    },
                  }}
                />
              </>
            ),
          }}
        >
          <DecisionsRoom
            shell={shell}
            binding={{
              source: "fixture",
              scopeId: DECISIONS_SCOPE,
              controller: fixture.controller,
            }}
          />
        </NavigationShell>
        {destination && (
          <WorkflowDestination
            route={destination}
            close={() => setDestination(null)}
          />
        )}
      </div>
    </div>
  );
}

function WorkflowDestination({
  route,
  close,
}: {
  route: BriefRoute;
  close: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const node = ref.current!;
    const origin =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    node.showModal();
    return () => {
      node.close();
      origin?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="brief-decision-destination"
      aria-label="Illustrative workflow destination"
      onCancel={close}
    >
      <h2>Workflow destination</h2>
      <p>
        This isolated preview verifies the source identity. The live host opens
        the matching workflow canvas.
      </p>
      <dl>
        <dt>Workflow</dt>
        <dd>{route.selection.flowId}</dd>
        <dt>Version</dt>
        <dd>{route.selection.versionId || "Current authorized version"}</dd>
        {route.selection.runId && (
          <>
            <dt>Run</dt>
            <dd>{route.selection.runId}</dd>
          </>
        )}
      </dl>
      <BriefButton variant="secondary" onClick={close}>
        Back to decision
      </BriefButton>
    </dialog>
  );
}
