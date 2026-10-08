import React, { useEffect, useMemo, useState } from "react";
import { useTheme } from "../../v2/shell/useTheme";
import type { BriefRoute, BriefShellPort } from "../contracts";
import { NavigationShell } from "../shell/navigation/NavigationShell";
import { UNKNOWN_NAVIGATION } from "../shell/navigation/model";
import { BriefButton } from "../components/controls";
import { ConversationComposer } from "../chat/composer/ConversationComposer";
import { DecisionsRoom } from "../decisions/DecisionsRoom";
import { makeDecisionsFixture, DECISIONS_SCOPE } from "../decisions/fixtures";
import { GoalsRoom } from "./GoalsRoom";
import {
  makeGoalsFixture,
  GOALS_SCOPE,
  GOAL_EXAMPLES,
  type GoalExample,
} from "./fixtures";
import "../today/preview/specimen.css";

export function GoalsSpecimen() {
  const [theme, setTheme] = useTheme(),
    [sidebar, setSidebar] = useState<"expanded" | "rail">("expanded"),
    [chatOpen, setChatOpen] = useState(false),
    [draft, setDraft] = useState("");
  const [example, setExample] = useState<GoalExample>("ready"),
    [route, setRoute] = useState<BriefRoute>({ room: "goals", selection: {} });
  const fixture = useMemo(() => makeGoalsFixture(example), [example]);
  const decisions = useMemo(() => makeDecisionsFixture("ready", 160), []);
  useEffect(() => () => fixture.controller.retire(), [fixture]);
  useEffect(() => () => decisions.controller.retire(), [decisions]);
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
  const selectedGoal = fixture.controller.snapshot().selectedId;
  return (
    <div className="brief-root brief-today-specimen" data-brief-theme={theme}>
      <div
        className="brief-today-review-toolbar"
        aria-label="Isolated review controls"
      >
        <span>D-24 · Goals</span>
        <button onClick={() => setTheme(theme === "light" ? "dark" : "light")}>
          Switch to {theme === "light" ? "dark" : "light"}
        </button>
        <label>
          Example{" "}
          <select
            aria-label="Goal example"
            value={example}
            onChange={(e) => {
              setRoute({ room: "goals", selection: {} });
              setExample(e.target.value as GoalExample);
            }}
          >
            {GOAL_EXAMPLES.map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
        </label>
        <button
          onClick={() => {
            fixture.update();
            void fixture.controller.refresh();
          }}
        >
          Update 6 to 7
        </button>
        <button
          onClick={() => {
            fixture.reorder();
            void fixture.controller.refresh();
          }}
        >
          Reorder goals
        </button>
        <small>
          Illustrative goals only. No live goal or approval is changed.
        </small>
      </div>
      <div className="brief-today-review-viewport" style={{ width: "100%" }}>
        <NavigationShell
          shell={shell}
          rooms={{
            goals: { id: "goals", title: "Goals" },
            "completed-goals": {
              id: "completed-goals",
              title: "Completed goals",
            },
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
                    scopeId: "d24-preview-chat",
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
          {route.room === "needs-you" ? (
            <>
              <BriefButton
                variant="text"
                onClick={() =>
                  setRoute({
                    room: "goals",
                    selection: selectedGoal ? { goalId: selectedGoal } : {},
                  })
                }
              >
                Back to goals
              </BriefButton>
              <DecisionsRoom
                shell={shell}
                binding={{
                  source: "fixture",
                  scopeId: DECISIONS_SCOPE,
                  controller: decisions.controller,
                }}
              />
            </>
          ) : (
            <GoalsRoom
              shell={shell}
              binding={{
                source: "fixture",
                scopeId: GOALS_SCOPE,
                controller: fixture.controller,
              }}
            />
          )}
        </NavigationShell>
      </div>
    </div>
  );
}
