import React, { useMemo, useState } from "react";
import { useTheme } from "../../v2/shell/useTheme";
import { BriefButton } from "../components/controls";
import { bindBriefView, unavailableView } from "../adapters/view";
import type { BriefRoomProps, BriefShellPort } from "../contracts";
import { legacyHref } from "../entry/route";

interface PreviewModel { note: string }
const PreviewBody = bindBriefView<PreviewModel>(() => ({ ...unavailableView<PreviewModel>("No live provider is connected in this preview."), source: "fixture" }),
  function PreviewBody({ shell, view }: BriefRoomProps<PreviewModel>) {
    return <>
      <div className="brief-foundation__controls">
        <BriefButton aria-pressed={shell.sidebar === "rail"} onClick={() => shell.setSidebar(shell.sidebar === "rail" ? "expanded" : "rail")}>Toggle sidebar state</BriefButton>
        <BriefButton aria-pressed={shell.chatOpen} onClick={() => shell.setChatOpen(!shell.chatOpen)}>Toggle chat state</BriefButton>
        <BriefButton onClick={() => shell.setTheme(shell.theme === "light" ? "dark" : "light")}>Switch to {shell.theme === "light" ? "dark" : "light"}</BriefButton>
      </div>
      <dl className="brief-foundation__values" aria-label="Preview shell state">
        <div><dt>Sidebar</dt><dd>{shell.sidebar}</dd></div>
        <div><dt>Conversation</dt><dd>{shell.chatOpen ? "open" : "closed"}</dd></div>
        <div><dt>Appearance</dt><dd>{shell.theme}</dd></div>
      </dl>
      <div role="status" className="brief-foundation__availability">
        {view.state.status === "unsupported" ? view.state.reason : view.state.status}
      </div>
    </>;
  });

/** Explicit fixture-only URL. Never used as the fallback for real business data. */
export function FoundationPreview() {
  const [sidebar, setSidebar] = useState<"expanded" | "rail">("expanded");
  const [chatOpen, setChatOpen] = useState(false);
  const [theme, setTheme] = useTheme();
  const shell = useMemo<BriefShellPort>(() => ({
    mode: "preview", route: { room: "today", selection: {} }, sidebar, setSidebar,
    chatOpen, setChatOpen, theme, setTheme,
    navigate: () => { /* This isolated fixture never navigates into a live room. */ },
  }), [sidebar, chatOpen, theme, setTheme]);
  return <main className="brief-foundation">
    <section className="brief-foundation__notice" aria-labelledby="brief-preview-title">
      <p className="brief-foundation__label">D-01 · Isolated development preview</p>
      <h1 id="brief-preview-title">Brief foundation</h1>
      <p>This checks the dashboard boundary and shared controls. It is not the finished dashboard. It does not connect to your brain, voice, or workflows.</p>
      <PreviewBody shell={shell} />
      <a className="brief-foundation__return" href={legacyHref(window.location.href)}>Return to current dashboard</a>
    </section>
  </main>;
}
