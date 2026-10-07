import React, { useMemo, useState, useEffect } from "react";
import { useTheme } from "../../../v2/shell/useTheme";
import type { BriefRoute, BriefShellPort } from "../../contracts";
import { NavigationShell } from "../../shell/navigation/NavigationShell";
import {
  UNKNOWN_NAVIGATION,
  type BriefNavigationBinding,
} from "../../shell/navigation/model";
import { ConversationComposer } from "../../chat/composer/ConversationComposer";
import { WorkflowCanvasRoom } from "../canvas/WorkflowCanvasRoom";
import { makeCanvasFixture } from "../canvas/fixtures";
import { WorkflowRunsRoom } from "../runs/WorkflowRunsRoom";
import { WorkflowContextRoom } from "./WorkflowContextRoom";
import { makeContextFixture, type ContextExample } from "./fixtures";
import type { ContextSource } from "./model";
import { BriefButton } from "../../components/controls";
import { makeRunsFixture, RUN_SCOPE, RUN_CAPABILITY } from "../runs/fixtures";
import "../../today/preview/specimen.css";
export function WorkflowContextSpecimen() {
  const [theme, setTheme] = useTheme(),
    [sidebar, setSidebar] = useState<"expanded" | "rail">("expanded"),
    [chatOpen, setChatOpen] = useState(false),
    [draft, setDraft] = useState("");
  const [revision, setRevision] = useState(0),
    [mode, setMode] = useState("normal");
  const [route, setRoute] = useState<BriefRoute>({
    room: "workflow-context",
    selection: {
      flowId: RUN_SCOPE.flowId,
      versionId: RUN_SCOPE.versionId,
      runId: "meeting-run-012",
    },
  });
  const fixture = useMemo(() => makeRunsFixture(), [revision]),
    canvas = useMemo(() => makeCanvasFixture(), [revision]),
    context = useMemo(() => makeContextFixture(fixture), [fixture]);
  const [source, setSource] = useState<ContextSource | null>(null);
  useEffect(
    () => () => {
      context.controller.retire();
      fixture.controller.retire();
    },
    [context, fixture],
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
      navigate: setRoute,
    }),
    [theme, setTheme, sidebar, chatOpen, route],
  );
  const binding = {
    ...RUN_SCOPE,
    source: "fixture" as const,
    title: "Meeting follow-ups",
    capabilities: RUN_CAPABILITY,
    controller: fixture.controller,
  };
  const nav: BriefNavigationBinding = {
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
          objectTitle: "Meeting follow-ups",
          badges: { workflows: 4 },
        },
      },
    },
  };
  return (
    <div className="brief-root brief-today-specimen" data-brief-theme={theme}>
      <div
        className="brief-today-review-toolbar"
        aria-label="Isolated review controls"
      >
        <span>D-20 · Context &amp; rules</span>
        <button onClick={() => setTheme(theme === "light" ? "dark" : "light")}>
          Switch to {theme === "light" ? "dark" : "light"}
        </button>
        <label>
          Example{" "}
          <select
            aria-label="Workflow context example"
            value={mode}
            onChange={(e) => {
              const value = e.target.value;
              setMode(value);
              context.setMode(value as ContextExample);
              const basis = context.controller.getSnapshot().mode;
              void context.controller.refresh(
                basis === "recorded" && route.selection.runId
                  ? { basis, runId: route.selection.runId }
                  : { basis: "configured" },
              );
            }}
          >
            <option value="normal">Normal</option>
            <option value="missing">Missing and stale sources</option>
            <option value="partial">Partial context</option>
            <option value="long">Long values</option>
            <option value="slow">Slow context reads</option>
            <option value="unavailable">Unavailable</option>
            <option value="unsupported">Unsupported</option>
            <option value="empty">No recorded context</option>
          </select>
        </label>
        <button
          onClick={() => {
            fixture.controller.retire();
            setRevision((v) => v + 1);
            setMode("normal");
            setRoute({
              room: "workflow-context",
              selection: {
                flowId: RUN_SCOPE.flowId,
                versionId: RUN_SCOPE.versionId,
                runId: "meeting-run-012",
              },
            });
          }}
        >
          Reset example
        </button>
        <small>
          Illustrative context and runs. No accounts, permissions or workflows
          are changed.
        </small>
      </div>
      <div className="brief-today-review-viewport" style={{ width: "100%" }}>
        <NavigationShell
          shell={shell}
          binding={nav}
          rooms={{
            "workflow-runs": { id: "workflow-runs", title: "Workflows" },
            workflow: { id: "workflow", title: "Workflows" },
            "workflow-context": { id: "workflow-context", title: "Workflows" },
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
                    scopeId: "runs-preview-chat",
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
          {route.room === "workflow-runs" ? (
            <WorkflowRunsRoom key={revision} shell={shell} binding={binding} />
          ) : route.room === "workflow" ? (
            <WorkflowCanvasRoom
              shell={shell}
              binding={{
                ...RUN_SCOPE,
                source: "fixture",
                capabilities: RUN_CAPABILITY,
                request: canvas.request,
              }}
            />
          ) : (
            <WorkflowContextRoom
              shell={shell}
              binding={{
                ...binding,
                controller: context.controller,
                runs: fixture.controller,
                openSource: setSource,
              }}
            />
          )}
        </NavigationShell>
        {source && (
          <SourcePreview source={source} close={() => setSource(null)} />
        )}
      </div>
    </div>
  );
}

function SourcePreview({
  source,
  close,
}: {
  source: ContextSource;
  close: () => void;
}) {
  const dialog = React.useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = dialog.current!;
    const origin =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    el.showModal();
    return () => {
      el.close();
      if (origin?.isConnected) origin.focus();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className="brief-context-source-preview"
      onCancel={close}
      aria-label="Illustrative source preview"
    >
      <h2>Source preview</h2>
      <p>
        {source.kind} · {source.id}
      </p>
      <p>
        This fixture verifies the selected source ID. Its live destination is
        supplied by the host.
      </p>
      <BriefButton onClick={close}>Back to context</BriefButton>
    </dialog>
  );
}
