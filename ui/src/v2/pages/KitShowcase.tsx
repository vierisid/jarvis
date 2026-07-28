import React, { useState } from "react";
import {
  StatusChip, StatsStrip, Tabs, Toolbar, FilterBar, FLabel, FilterChip, Segmented, LiveToggle,
  Table, Row, StatusIcon, Drawer, DrawerLabel, DrawerText, DeepLink, Shape, EmptyState, Skeleton,
  Toast, Input, Select, Switch, Check, type ShapeKind,
} from "../ui/roomkit";

/**
 * Phase 3 — room-kit gallery. A live showcase of every shared primitive so
 * the kit can be QA'd in both themes before Phase-4 rooms consume it.
 * Route: #/_kit
 */

const SHAPES: { kind: ShapeKind; label: string }[] = [
  { kind: "circle", label: "person" }, { kind: "drop", label: "project" }, { kind: "square", label: "tool" },
  { kind: "peak", label: "place" }, { kind: "ring", label: "concept" }, { kind: "diamond", label: "event" },
];

function Section({ label, children, span2 }: { label: string; children: React.ReactNode; span2?: boolean }) {
  return (
    <section className="kit-sec" style={span2 ? { gridColumn: "span 2" } : undefined}>
      <div className="kit-sec__label">{label}</div>
      <div className="kit-sec__body">{children}</div>
    </section>
  );
}

export function KitShowcase(): React.ReactElement {
  const [tab, setTab] = useState("board");
  const [status, setStatus] = useState("all");
  const [win, setWin] = useState("24h");
  const [live, setLive] = useState(true);
  const [sw, setSw] = useState(true);
  const [chk, setChk] = useState(true);
  const [sel, setSel] = useState("a2");

  return (
    <div className="kit-page">
      <style>{KIT_CSS}</style>
      <header className="kit-head">
        <div className="kit-head__eyebrow">Brand Book III · room kit</div>
        <h1 className="kit-head__title">One vocabulary, every room.</h1>
        <p className="kit-head__sub">The shared composites Phase-4 rooms inherit. Chroma is the five state tones only; ink carries every primary action; the drop's sharp corner sits top-right.</p>
      </header>

      <div className="kit-grid">
        <Section label="Status chips · five tones, nothing else">
          <div className="kit-row">
            <StatusChip tone="run" dot>running</StatusChip>
            <StatusChip tone="ok" dot>succeeded</StatusChip>
            <StatusChip tone="hold" dot>awaiting you</StatusChip>
            <StatusChip tone="fail" dot>failed</StatusChip>
            <StatusChip tone="mut" dot>queued</StatusChip>
          </div>
        </Section>

        <Section label="Tabs">
          <Tabs
            tabs={[{ key: "board", label: "Board" }, { key: "list", label: "List" }, { key: "archive", label: "Archive" }]}
            active={tab} onChange={setTab}
          />
        </Section>

        <Section label="Stats strip · KPIs" span2>
          <StatsStrip items={[
            { k: "active", n: 4 },
            { k: "completed today", n: 3, tone: "ok" },
            { k: "overdue", n: 1, tone: "amber" },
            { k: "failed", n: 0, tone: "alert" },
            { k: "total", n: <>11<small> tasks</small></> },
          ]} />
        </Section>

        <Section label="Toolbar + filters" span2>
          <div className="kit-frame">
            <Toolbar title="Tasks">
              <Tabs tabs={[{ key: "board", label: "Board" }, { key: "list", label: "List" }]} active={tab} onChange={setTab} />
              <span className="rk-toolbar__spacer" />
              <Input mono placeholder="search tasks…" style={{ width: 150 }} />
            </Toolbar>
            <FilterBar>
              <FLabel>status</FLabel>
              {["all", "pending", "completed"].map((s) => <FilterChip key={s} on={status === s} onClick={() => setStatus(s)}>{s}</FilterChip>)}
              <span style={{ width: 10 }} />
              <FLabel>window</FLabel>
              <Segmented options={[{ key: "1h", label: "1h" }, { key: "24h", label: "24h" }, { key: "7d", label: "7d" }]} value={win} onChange={setWin} />
              <span className="rk-toolbar__spacer" />
              <LiveToggle on={live} onClick={() => setLive((v) => !v)} />
            </FilterBar>
          </div>
        </Section>

        <Section label="Table grammar" span2>
          <div className="kit-frame">
            <Table>
              <Row cols="26px 1fr 90px 70px" head><span /><span>event</span><span className="rk-num">tokens</span><span className="rk-num">when</span></Row>
              {[
                { id: "a1", tone: "ok", t: "morning brief", s: "delivered to Telegram", n: "3.1k", w: "07:00" },
                { id: "a2", tone: "run", t: "inbox triage", s: "14 overnight emails", n: "8.4k", w: "2m" },
                { id: "a3", tone: "hold", t: "make_payment", s: "routed to your approval", n: "—", w: "9m" },
                { id: "a4", tone: "fail", t: "backup sync", s: "failed · retrying 14:00", n: "—", w: "12:40" },
              ].map((r) => (
                <Row key={r.id} cols="26px 1fr 90px 70px" selected={sel === r.id} onClick={() => setSel(r.id)}>
                  <StatusIcon tone={r.tone as any} />
                  <span><span className="rk-cell-strong">{r.t}</span> <span className="rk-cell-mut">· {r.s}</span></span>
                  <span className="rk-num">{r.n}</span>
                  <span className="rk-num">{r.w}</span>
                </Row>
              ))}
            </Table>
          </div>
        </Section>

        <Section label="Detail drawer">
          <div className="kit-frame" style={{ height: 240 }}>
            <Drawer
              title="authority · approval required"
              meta={<><StatusChip tone="hold">authority</StatusChip><span>Jun 13, 12:58</span></>}
              actions={<DeepLink>→ open in Authority</DeepLink>}
            >
              <DrawerLabel>detail</DrawerLabel>
              <DrawerText>personal-assistant requested make_payment; routed to your approval.</DrawerText>
              <DrawerLabel>raw</DrawerLabel>
              <div className="rk-drawer__raw"><span className="k">decision</span>: "approval_required",{"\n"}<span className="k">amount</span>: "€128.40"</div>
            </Drawer>
          </div>
        </Section>

        <Section label="Empty state · teaches, never apologises">
          <EmptyState title="No flows yet" action={<button className="v2-btn v2-btn--primary v2-btn--sm">New flow</button>}>
            Describe one to Jarvis: “every weekday at 8, summarise my email,” or build it by hand.
          </EmptyState>
        </Section>

        <Section label="Shape grammar · entities & goals" span2>
          <div className="kit-row" style={{ gap: 20 }}>
            {SHAPES.map((s) => (
              <span key={s.kind} style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--ink2)" }}>
                <Shape kind={s.kind} />{s.label} · {s.kind}
              </span>
            ))}
          </div>
        </Section>

        <Section label="Loading · skeleton, never spinners">
          <Skeleton widths={["72%", "88%", "55%"]} />
          <div style={{ marginTop: 16 }}><Toast tone="ok">flow saved · morning brief</Toast></div>
        </Section>

        <Section label="Toasts · the five tones">
          <div className="kit-row" style={{ flexDirection: "column", alignItems: "flex-start", gap: 8 }}>
            <Toast tone="run">research-analyst started</Toast>
            <Toast tone="hold">waiting on you · Lufthansa €128.40</Toast>
            <Toast tone="fail">backup sync failed</Toast>
          </div>
        </Section>

        <Section label="Form controls" span2>
          <div className="kit-row" style={{ gap: 18 }}>
            <Input placeholder="search the vault…" />
            <Select defaultValue="marin"><option value="marin">marin</option><option value="native">native</option></Select>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--ink2)" }}>
              <Switch on={sw} onClick={() => setSw((v) => !v)} label="TTS" /> voice replies
            </span>
            <Check on={chk} onClick={() => setChk((v) => !v)}>errors only</Check>
          </div>
        </Section>
      </div>
    </div>
  );
}

const KIT_CSS = `
.kit-page { min-height: 100vh; background: var(--bg); color: var(--ink); font-family: var(--sans); padding: 40px 44px 80px; box-sizing: border-box; }
.kit-head { max-width: 760px; margin: 0 auto 32px; }
.kit-head__eyebrow { font-family: var(--mono); font-size: 10px; letter-spacing: .18em; text-transform: uppercase; color: var(--ink3); margin-bottom: 12px; }
.kit-head__title { font-size: 34px; font-weight: 700; letter-spacing: -.025em; margin: 0 0 10px; line-height: 1.08; }
.kit-head__sub { font-size: 14px; color: var(--ink2); line-height: 1.6; max-width: 66ch; margin: 0; }
.kit-grid { max-width: 1080px; margin: 0 auto; display: grid; grid-template-columns: 1fr 1fr; gap: 18px; align-items: start; }
.kit-sec { border: 1px solid var(--rule); border-radius: var(--corner); background: var(--raise); box-shadow: var(--sh-sm); overflow: hidden; }
.kit-sec__label { font-family: var(--mono); font-size: 9px; letter-spacing: .14em; text-transform: uppercase; color: var(--ink3); padding: 12px 16px 0; }
.kit-sec__body { padding: 16px; }
.kit-row { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.kit-frame { border: 1px solid var(--rule); border-radius: var(--corner-sm); overflow: hidden; background: var(--bg); }
@media (max-width: 760px){ .kit-grid { grid-template-columns: 1fr; } .kit-sec[style] { grid-column: span 1 !important; } }
`;
