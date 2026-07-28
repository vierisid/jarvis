import React from "react";
import "./roomkit.css";

/**
 * Room kit — the shared vocabulary every Phase-4 room is built from.
 * Brand Book III / Monochrome Lab. Thin, composable wrappers over `roomkit.css`.
 * Chroma is the five state tones only; ink carries primary actions.
 */

export type Tone = "run" | "ok" | "hold" | "fail" | "mut";

/* ── Status chip ── */
export function StatusChip({ tone, dot, children }: { tone: Tone; dot?: boolean; children: React.ReactNode }) {
  return (
    <span className={`rk-chip rk-chip--${tone}`}>
      {dot && <span className="rk-chip__dot" />}
      {children}
    </span>
  );
}

/* ── Stats strip ── */
export function StatsStrip({ items }: { items: { k: string; n: React.ReactNode; tone?: "amber" | "alert" | "ok" }[] }) {
  return (
    <div className="rk-stats">
      {items.map((s, i) => (
        <div className="rk-stats__cell" key={i}>
          <div className="rk-stats__k">{s.k}</div>
          <div className={`rk-stats__n${s.tone ? ` rk-stats__n--${s.tone}` : ""}`}>{s.n}</div>
        </div>
      ))}
    </div>
  );
}

/* ── Tabs ── */
export function Tabs({ tabs, active, onChange }: { tabs: { key: string; label: string }[]; active: string; onChange: (k: string) => void }) {
  return (
    <div className="rk-tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.key} role="tab" aria-selected={t.key === active} className={`rk-tab${t.key === active ? " rk-tab--on" : ""}`} onClick={() => onChange(t.key)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

/* ── Toolbar + filters ── */
export function Toolbar({ title, children }: { title?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="rk-toolbar">
      {title && <span className="rk-toolbar__title">{title}</span>}
      {children}
    </div>
  );
}
export function FilterBar({ children }: { children: React.ReactNode }) { return <div className="rk-filterbar">{children}</div>; }
export function FLabel({ children }: { children: React.ReactNode }) { return <span className="rk-flabel">{children}</span>; }
export function FilterChip({ on, onClick, children }: { on?: boolean; onClick?: () => void; children: React.ReactNode }) {
  return <button className={`rk-filterchip${on ? " rk-filterchip--on" : ""}`} onClick={onClick}>{children}</button>;
}
export function Segmented({ options, value, onChange }: { options: { key: string; label: string }[]; value: string; onChange: (k: string) => void }) {
  return (
    <div className="rk-seg">
      {options.map((o) => <button key={o.key} className={o.key === value ? "rk-seg--on" : ""} onClick={() => onChange(o.key)}>{o.label}</button>)}
    </div>
  );
}
export function LiveToggle({ on, onClick, children = "live tail" }: { on?: boolean; onClick?: () => void; children?: React.ReactNode }) {
  return <button className={`rk-live${on ? " rk-live--on" : ""}`} onClick={onClick}><span className="rk-live__dot" />{children}</button>;
}

/* ── Table grammar ── */
/* Div grids visually, but announced as real tables: Table/Row carry ARIA table
   semantics, and cells should be Cell/HCell (columnheader in head rows) so
   screen readers get the same navigation the old <table> markup provided. */
export function Table({ children, label }: { children: React.ReactNode; label?: string }) {
  return <div className="rk-table" role="table" aria-label={label}>{children}</div>;
}
export function Row({ cols, head, selected, onClick, children }: { cols: string; head?: boolean; selected?: boolean; onClick?: () => void; children: React.ReactNode }) {
  return (
    <div
      className={`rk-row${head ? " rk-row--head" : ""}${selected ? " rk-row--sel" : ""}${onClick ? " rk-row--link" : ""}`}
      style={{ gridTemplateColumns: cols }}
      role="row"
      onClick={onClick}
    >
      {children}
    </div>
  );
}
export function Cell({ className, children, title }: { className?: string; children?: React.ReactNode; title?: string }) {
  return <span role="cell" className={className} title={title}>{children}</span>;
}
export function HCell({ className, children }: { className?: string; children?: React.ReactNode }) {
  return <span role="columnheader" className={className}>{children}</span>;
}
export function StatusIcon({ tone }: { tone: Tone }) { return <span className={`rk-statico rk-statico--${tone}`}><i /></span>; }

/* ── Detail drawer ── */
export function Drawer({ title, meta, children, actions, empty }: { title?: React.ReactNode; meta?: React.ReactNode; children?: React.ReactNode; actions?: React.ReactNode; empty?: React.ReactNode }) {
  if (empty) return <div className="rk-drawer"><div className="rk-drawer__empty">{empty}</div></div>;
  return (
    <div className="rk-drawer">
      {title && <div className="rk-drawer__head"><div className="rk-drawer__title">{title}</div>{meta && <div className="rk-drawer__meta">{meta}</div>}</div>}
      <div className="rk-drawer__body">{children}</div>
      {actions && <div className="rk-drawer__actions">{actions}</div>}
    </div>
  );
}
export function DrawerLabel({ children }: { children: React.ReactNode }) { return <div className="rk-drawer__label">{children}</div>; }
export function DrawerText({ children }: { children: React.ReactNode }) { return <div className="rk-drawer__text">{children}</div>; }
export function DeepLink({ onClick, children }: { onClick?: () => void; children: React.ReactNode }) {
  return <button className="rk-deeplink" onClick={onClick}>{children}</button>;
}

/* ── Shape grammar ── */
export type ShapeKind = "circle" | "drop" | "square" | "peak" | "ring" | "diamond";
export function Shape({ kind }: { kind: ShapeKind }) { return <span className={`rk-shape rk-shape--${kind}`} aria-hidden="true" />; }

/* ── Empty state ── */
export function EmptyState({ title, children, action }: { title: string; children?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="rk-empty">
      <div className="rk-empty__drop" />
      <div className="rk-empty__t">{title}</div>
      {children && <div className="rk-empty__s">{children}</div>}
      {action}
    </div>
  );
}

/* ── Skeleton ── */
export function Skeleton({ lines = 3, widths }: { lines?: number; widths?: string[] }) {
  const ws = widths ?? Array.from({ length: lines }, (_, i) => `${[72, 88, 55, 80, 64][i % 5]}%`);
  return <div className="rk-skeleton">{ws.map((w, i) => <span className="rk-skeleton__bar" key={i} style={{ width: w }} />)}</div>;
}

/* ── Toast ── */
export function Toast({ tone = "ok", children }: { tone?: Tone; children: React.ReactNode }) {
  const hue: Record<Tone, string> = { run: "var(--speak)", ok: "var(--ok)", hold: "var(--hold)", fail: "var(--listen)", mut: "var(--faint)" };
  return <span className="rk-toast" role="status" aria-live="polite"><span className="rk-toast__dot" style={{ background: hue[tone] }} aria-hidden="true" />{children}</span>;
}

/* ── Form controls ── */
export function Input({ mono, className, ...rest }: React.InputHTMLAttributes<HTMLInputElement> & { mono?: boolean }) {
  return <input className={`rk-input${mono ? " rk-input--mono" : ""}${className ? " " + className : ""}`} {...rest} />;
}
export function Select({ className, ...rest }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={`rk-select${className ? " " + className : ""}`} {...rest} />;
}
export function Switch({ on, onClick, label }: { on?: boolean; onClick?: () => void; label?: string }) {
  return <button role="switch" aria-checked={!!on} aria-label={label} className={`rk-switch${on ? "" : " rk-switch--off"}`} onClick={onClick}><i /></button>;
}
export function Check({ on, onClick, children }: { on?: boolean; onClick?: () => void; children: React.ReactNode }) {
  return (
    <button className={`rk-check${on ? " rk-check--on" : ""}`} onClick={onClick} role="checkbox" aria-checked={!!on} style={{ border: "none", background: "none", fontFamily: "var(--sans)" }}>
      <span className="rk-check__bx" />{children}
    </button>
  );
}
