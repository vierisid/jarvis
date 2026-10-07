import React, {
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { useTheme } from "../../v2/shell/useTheme";
import type { BriefRoute, BriefShellPort } from "../contracts";
import { NavigationShell } from "../shell/navigation/NavigationShell";
import { UNKNOWN_NAVIGATION } from "../shell/navigation/model";
import { ConversationComposer } from "../chat/composer/ConversationComposer";
import { OpportunitiesRoom } from "./OpportunitiesRoom";
import {
  makeOpportunitiesFixture,
  OPPORTUNITIES_SCOPE,
  OPPORTUNITY_EXAMPLES,
  type OpportunityExample,
} from "./fixtures";
import "../today/preview/specimen.css";

/** Fixture entry only. Production mounts the room through its optional registration. */
export function OpportunitiesSpecimen() {
  const [theme, setTheme] = useTheme(),
    [sidebar, setSidebar] = useState<"expanded" | "rail">("expanded"),
    [chatOpen, setChatOpen] = useState(false),
    [draft, setDraft] = useState("");
  const [example, setExample] = useState<OpportunityExample>("ready"),
    [reset, setReset] = useState(0),
    [route, setRoute] = useState<BriefRoute>({
      room: "opportunities",
      selection: {},
    });
  const fixture = useMemo(
    () => makeOpportunitiesFixture(example, 180),
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
      navigate: setRoute,
    }),
    [theme, setTheme, sidebar, chatOpen, route],
  );
  return (
    <div className="brief-root brief-today-specimen" data-brief-theme={theme}>
      <div
        className="brief-today-review-toolbar"
        aria-label="Isolated review controls"
      >
        <span>D-22 · Opportunities</span>
        <button onClick={() => setTheme(theme === "light" ? "dark" : "light")}>
          Switch to {theme === "light" ? "dark" : "light"}
        </button>
        <label>
          Example{" "}
          <select
            aria-label="Opportunity example"
            value={example}
            onChange={(e) => setExample(e.target.value as OpportunityExample)}
          >
            {OPPORTUNITY_EXAMPLES.map((x) => (
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
          Reorder proposals
        </button>
        <small>
          Illustrative proposals only. No workflow is enabled on your account.
        </small>
      </div>
      <div className="brief-today-review-viewport" style={{ width: "100%" }}>
        <NavigationShell
          shell={shell}
          rooms={{
            opportunities: { id: "opportunities", title: "Opportunities" },
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
                    opportunities:
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
                    scopeId: "d22-preview-chat",
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
          <OpportunitiesRoom
            shell={shell}
            binding={{
              source: "fixture",
              scopeId: OPPORTUNITIES_SCOPE,
              controller: fixture.controller,
            }}
          />
        </NavigationShell>
      </div>
    </div>
  );
}
