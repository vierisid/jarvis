import React, { useEffect, useMemo, useState } from "react";
import { useTheme } from "../../v2/shell/useTheme";
import type { BriefShellPort } from "../contracts";
import { NavigationShell } from "../shell/navigation/NavigationShell";
import { UNKNOWN_NAVIGATION } from "../shell/navigation/model";
import { ConversationComposer } from "../chat/composer/ConversationComposer";
import { AuthorityWorkspace } from "./AuthorityWorkspace";
import {
  makeAuthorityFixture,
  AUTHORITY_EXAMPLES,
  AUTHORITY_SCOPE,
  type AuthorityExample,
} from "./fixtures";
import "../today/preview/specimen.css";

export function AuthoritySpecimen() {
  const [theme, setTheme] = useTheme(),
    [sidebar, setSidebar] = useState<"expanded" | "rail">("expanded"),
    [chatOpen, setChatOpen] = useState(false),
    [draft, setDraft] = useState("");
  const [example, setExample] = useState<AuthorityExample>("ready"),
    [mount, setMount] = useState(0);
  const fixture = useMemo(() => makeAuthorityFixture(example, 140), [example]);
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
      route: { room: "authority", selection: {} },
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
        <span>D-28 · Authority</span>
        <button onClick={() => setTheme(theme === "light" ? "dark" : "light")}>
          Switch to {theme === "light" ? "dark" : "light"}
        </button>
        <label>
          Example{" "}
          <select
            aria-label="Authority example"
            value={example}
            onChange={(e) => setExample(e.target.value as AuthorityExample)}
          >
            {AUTHORITY_EXAMPLES.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        <button
          onClick={() => {
            fixture.failReads(true);
            void fixture.controller.refresh();
          }}
        >
          Simulate stale read
        </button>
        <button
          onClick={() => {
            fixture.failReads(false);
            void fixture.controller.refresh(true);
          }}
        >
          Restore reads
        </button>
        <button
          onClick={() => {
            fixture.change({ default_level: 8 });
            void fixture.controller.refresh();
          }}
        >
          Simulate external level
        </button>
        <button onClick={() => setMount((value) => value + 1)}>
          Remount room
        </button>
        <button onClick={() => fixture.recoverWrites()}>Restore saves</button>
        <button
          onClick={() => {
            fixture.changeEmergency("paused");
            void fixture.controller.refresh();
          }}
        >
          Simulate runtime pause
        </button>
        <button
          onClick={() => {
            fixture.changeEmergency("normal");
            void fixture.controller.refresh();
          }}
        >
          Simulate runtime resume
        </button>
        <small>
          Isolated settings only. Saves and advanced navigation are simulated.
        </small>
      </div>
      <div className="brief-today-review-viewport" style={{ width: "100%" }}>
        <NavigationShell
          shell={shell}
          rooms={{
            authority: {
              id: "authority",
              title: "Authority",
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
                    scopeId: "d28-preview-chat",
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
          <AuthorityWorkspace
            key={mount}
            shell={shell}
            binding={{
              controller: fixture.controller,
              source: "fixture",
              scopeId: AUTHORITY_SCOPE,
            }}
          />
        </NavigationShell>
      </div>
    </div>
  );
}
