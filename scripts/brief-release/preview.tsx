/** Test-only entry; not imported by the production dashboard. These attestations
 * simulate gate inputs and do not certify any deployment or release candidate. */
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { DashboardEntry } from "../../ui/src/brief/entry/DashboardEntry";
import { releaseExample } from "../../ui/src/brief/entry/release.test-support";
import { assessBriefRelease, BRIEF_RELEASE } from "../../ui/src/brief/entry/release";
import { BRIEF_ROOM_IDS, type BriefShellPort } from "../../ui/src/brief/contracts";
import { getV2Route, useV2Route } from "../../ui/src/v2/router";
import { UNKNOWN_NAVIGATION, type BriefNavigationBinding } from "../../ui/src/brief/shell/navigation/model";
import "../../ui/src/styles/globals.css";
import "./preview.css";

function Draft() {
  const [saved, setSaved] = useState(() => sessionStorage.getItem("d33-demo-saved") ?? "Synthetic saved work");
  const [draft, setDraft] = useState(saved);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (draft !== saved) { event.preventDefault(); event.returnValue = ""; }
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [draft, saved]);
  return <div className="release-test-draft"><label>Fixture draft<textarea value={draft} onChange={e => setDraft(e.target.value)} /></label>
    <button onClick={() => { sessionStorage.setItem("d33-demo-saved", draft); setSaved(draft); }}>Save fixture draft</button>
    <p>Saved fixture value: {saved}</p></div>;
}
function Legacy() {
  useV2Route();
  return <section className="release-test-room"><h1>Legacy route owner</h1><pre>{JSON.stringify(getV2Route())}</pre><Draft /></section>;
}
function Body({ shell }: { shell: BriefShellPort }) {
  return <section className="release-test-room"><h1>Brief test room: {shell.route.room}</h1>
    <pre>{JSON.stringify(shell.route.selection)}</pre><Draft />
    <button onClick={() => shell.navigate({ room: "memory-detail", selection: { factId: "test-fact-123" } })}>Open test fact</button></section>;
}
const rooms = Object.fromEntries(BRIEF_ROOM_IDS.map(id => [id, { id, title: id, Body }]));
const PassGate = ({ children }: { children: React.ReactNode }) => <>{children}</>;
const navigation: BriefNavigationBinding = {
  capabilities: { contractVersion: 1, asOf: 1, capabilities: { navigationCompatibility: {
    supported: true, ready: true, enabled: true, state: "ready", reason: null,
  } } },
  view: { source: "live", state: { status: "ready", data: UNKNOWN_NAVIGATION } },
};
function TestPage() {
  const scenario = new URL(location.href).searchParams.get("scenario") ?? "off";
  const [{ config, runtime }] = useState(() => {
    const example = releaseExample();
    if (scenario === "off") example.config = BRIEF_RELEASE;
    if (scenario === "released") example.config.rollout = "released";
    if (scenario === "old-brain") example.runtime.brain = "unverified-old-brain";
    if (scenario === "missing-proof") delete example.config.gates["Q-22"];
    return example;
  });
  const [disabled, setDisabled] = useState(false);
  const current = disabled ? BRIEF_RELEASE : config;
  const assessment = assessBriefRelease(current, runtime);
  const links = [
    ["Switch off", "?scenario=off&brief=1#/brief/memory-detail?factId=test-fact-123"],
    ["Opt-in cohort", "?scenario=cohort&brief=1#/_room_memory"],
    ["Cohort without opt-in", "?scenario=cohort#/_room_memory"],
    ["Released foreground", "?scenario=released#/"],
    ["Unknown brain", "?scenario=old-brain&brief=1#/_room_memory"],
    ["Missing Q22 proof", "?scenario=missing-proof&brief=1#/_room_memory"],
    ["Sidecar panel", "?scenario=released&brief=1#/_panel_settings"],
    ["Older maintenance link", "?scenario=released&briefMaintenance=1&settingsTab=sidecar&sidecarId=test-device#/_room_settings"],
  ];
  return <><header className="release-test-header"><strong>Synthetic D33 switch test · no live account or release evidence</strong>
    <nav>{links.map(([label, href]) => <a key={label} href={href}>{label}</a>)}</nav>
    <p>Configured decision: {assessment.rollout}; blockers: {assessment.blockers.join(", ") || "none (synthetic inputs only)"}</p>
    <button onClick={() => setDisabled(true)}>Simulate configuration rollback</button>{" "}
    <button onClick={() => location.assign(`?scenario=off&brief=1${location.hash}`)}>Reload with switch off</button>
    <span> Configuration changes apply to the next document; save your draft before reloading.</span>
  </header><div className="release-test-dashboard"><DashboardEntry legacy={<Legacy />} rooms={rooms}
    Gate={PassGate} navigation={navigation}
    conversation={{ source: "live", content: <p>Synthetic conversation owner</p> }}
    release={current} runtime={runtime} /></div></>;
}
createRoot(document.getElementById("release-test")!).render(<TestPage />);
