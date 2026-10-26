import React, { useMemo, useState } from "react";
import { useTheme } from "../../../v2/shell/useTheme";
import type { BriefRoute, BriefShellPort } from "../../contracts";
import { NavigationShell } from "../../shell/navigation/NavigationShell";
import { UNKNOWN_NAVIGATION } from "../../shell/navigation/model";
import { ConversationComposer } from "../../chat/composer/ConversationComposer";
import { BillingWorkspace } from "./BillingWorkspace";
import {
  BILLING_EXAMPLES,
  makeBillingFixture,
  type BillingExample,
} from "./fixtures";
import "../../today/preview/specimen.css";

export function BillingSpecimen() {
  const [theme, setTheme] = useTheme();
  const [sidebar, setSidebar] = useState<"expanded" | "rail">("expanded");
  const [chatOpen, setChatOpen] = useState(false),
    [draft, setDraft] = useState("");
  const [example, setExample] = useState<BillingExample>("active");
  const [route, setRoute] = useState<BriefRoute>({
    room: "billing",
    selection: {},
  });
  const [opened, setOpened] = useState(""),
    [blocked, setBlocked] = useState(false);
  const [reads, setReads] = useState(0);
  const fixture = useMemo(
    () =>
      makeBillingFixture(
        example,
        (url) => {
          setOpened(url);
          return !blocked;
        },
        () => setReads((n) => n + 1),
      ),
    [example, blocked],
  );
  const shell: BriefShellPort = {
    mode: "preview",
    theme,
    setTheme,
    sidebar,
    setSidebar,
    chatOpen,
    setChatOpen,
    route,
    navigate: setRoute,
  };
  return (
    <div className="brief-root brief-today-specimen" data-brief-theme={theme}>
      <div
        className="brief-today-review-toolbar"
        aria-label="Isolated review controls"
      >
        <span>D-31 · Billing</span>
        <button onClick={() => setTheme(theme === "light" ? "dark" : "light")}>
          Switch to {theme === "light" ? "dark" : "light"}
        </button>
        <label>
          Example{" "}
          <select
            aria-label="Billing example"
            value={example}
            onChange={(e) => {
              setExample(e.target.value as BillingExample);
              setRoute({ room: "billing", selection: {} });
              setOpened("");
            }}
          >
            {BILLING_EXAMPLES.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={blocked}
            onChange={(e) => setBlocked(e.target.checked)}
          />{" "}
          Simulate blocked browser
        </label>
        <small>
          Isolated examples. No billing requests or browser handoffs. Refreshes:{" "}
          {reads}
        </small>
        {opened && <small role="status">Preview destination: {opened}</small>}
      </div>
      <div className="brief-today-review-viewport" style={{ width: "100%" }}>
        <NavigationShell
          shell={shell}
          rooms={{
            today: { id: "today", title: "Today" },
            billing: { id: "billing", title: "Billing" },
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
                    scopeId: "d31-preview-chat",
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
          {route.room === "billing" ? (
            <BillingWorkspace key={example} shell={shell} fixture={fixture} />
          ) : (
            <section>
              <h1 className="brief-type-room-title">Preview destination</h1>
              <p>Use the account menu to return to Billing.</p>
            </section>
          )}
        </NavigationShell>
      </div>
    </div>
  );
}
