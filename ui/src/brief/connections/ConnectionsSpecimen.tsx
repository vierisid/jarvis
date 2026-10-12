import React, { useEffect, useMemo, useState } from "react";
import { useTheme } from "../../v2/shell/useTheme";
import type { BriefShellPort } from "../contracts";
import { NavigationShell } from "../shell/navigation/NavigationShell";
import { UNKNOWN_NAVIGATION } from "../shell/navigation/model";
import { ConversationComposer } from "../chat/composer/ConversationComposer";
import { ConnectedWorkspace } from "./ConnectedWorkspace";
import {
  makeConnectionsFixture,
  CONNECTION_EXAMPLES,
  CONNECTION_SCOPE,
  type ConnectionExample,
} from "./fixtures";
import "../today/preview/specimen.css";

export function ConnectionsSpecimen() {
  const [theme, setTheme] = useTheme(),
    [sidebar, setSidebar] = useState<"expanded" | "rail">("expanded"),
    [chatOpen, setChatOpen] = useState(false),
    [draft, setDraft] = useState("");
  const [example, setExample] = useState<ConnectionExample>("ready"),
    [mount, setMount] = useState(0);
  const fixture = useMemo(
    () => makeConnectionsFixture(example, 140),
    [example],
  );
  useEffect(() => () => fixture.controller.retire(), [fixture]);
  const shell = useMemo<BriefShellPort>(
    () => ({
      mode: "preview",
      theme,
      setTheme,
      sidebar,
      setSidebar,
      chatOpen,
      setChatOpen,
      route: { room: "connected-workspace", selection: {} },
      navigate() {},
    }),
    [theme, setTheme, sidebar, chatOpen],
  );
  return (
    <div className="brief-root brief-today-specimen" data-brief-theme={theme}>
      <div
        className="brief-today-review-toolbar"
        aria-label="Isolated review controls"
      >
        <span>D-27 · Connected workspace</span>
        <button onClick={() => setTheme(theme === "light" ? "dark" : "light")}>
          Switch to {theme === "light" ? "dark" : "light"}
        </button>
        <label>
          Example{" "}
          <select
            aria-label="Connection example"
            value={example}
            onChange={(e) => setExample(e.target.value as ConnectionExample)}
          >
            {CONNECTION_EXAMPLES.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        <button onClick={() => void fixture.controller.check()}>
          Return without confirmation
        </button>
        <button
          onClick={() => {
            fixture.confirm();
            void fixture.controller.check();
          }}
        >
          Simulate verified account
        </button>
        <button onClick={() => setMount((value) => value + 1)}>
          Remount room
        </button>
        <small>
          Fake accounts only. Browser and device handoffs are simulated.
        </small>
      </div>
      <div className="brief-today-review-viewport" style={{ width: "100%" }}>
        <NavigationShell
          shell={shell}
          rooms={{
            "connected-workspace": {
              id: "connected-workspace",
              title: "Connected workspace",
            },
          }}
          binding={{
            capabilities: null,
            view: {
              source: "fixture",
              state: {
                status: "ready",
                data: {
                  ...UNKNOWN_NAVIGATION,
                  workspaceName: "Preview workspace",
                  connection: "connected",
                  account: {
                    name: "Preview owner",
                    plan: { status: "ready", data: "Preview" },
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
                    scopeId: "d27-preview-chat",
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
                      cancel() {},
                    },
                  }}
                />
              </>
            ),
          }}
        >
          <ConnectedWorkspace
            key={mount}
            shell={shell}
            binding={{
              controller: fixture.controller,
              source: "fixture",
              scopeId: CONNECTION_SCOPE,
            }}
          />
        </NavigationShell>
      </div>
    </div>
  );
}
