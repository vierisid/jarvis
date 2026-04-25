import React from "react";
import { ArrowRight, Check, Mic, Search, Send, Sparkles } from "lucide-react";
import { Button, Chip, Icon, KBD, Meta, Rule } from "../ui";
import { navigateV2 } from "../router";
import "./primitives.css";

export function PrimitivesPage() {
  return (
    <div className="v2-primitives">
      <header className="v2-primitives__topbar">
        <div className="v2-primitives__brand">
          <span className="v2-primitives__brand-dot" aria-hidden="true" />
          <h1 className="v2-primitives__title">Primitives</h1>
        </div>
        <Button variant="ghost" size="sm" onClick={() => navigateV2({ kind: "home" })}>
          ← Back to shell
        </Button>
      </header>

      <div className="v2-primitives__content">
        <div className="v2-primitives__grid">

          <Section
            title="Button"
            note="Primary uses --accent and only appears once per surface. Ghost is the workhorse. Danger uses --warn for destructive standalone actions (system-altering intents still route through ApprovalCard)."
          >
            <div className="v2-demo v2-demo--col">
              <div className="v2-demo__row">
                <span className="v2-demo__label">Primary</span>
                <Button variant="primary" size="sm">Approve</Button>
                <Button variant="primary" size="md">
                  Send
                  <Icon icon={Send} size="sm" />
                </Button>
              </div>
              <div className="v2-demo__row">
                <span className="v2-demo__label">Ghost</span>
                <Button variant="ghost" size="sm">Cancel</Button>
                <Button variant="ghost" size="md">
                  <Icon icon={ArrowRight} size="sm" />
                  Open
                </Button>
              </div>
              <div className="v2-demo__row">
                <span className="v2-demo__label">Danger</span>
                <Button variant="danger" size="sm">Revoke</Button>
                <Button variant="danger" size="md">Delete workflow</Button>
              </div>
              <div className="v2-demo__row">
                <span className="v2-demo__label">Disabled</span>
                <Button variant="primary" size="sm" disabled>Send</Button>
                <Button variant="ghost" size="sm" disabled>Cancel</Button>
              </div>
            </div>
          </Section>

          <Section
            title="Chip"
            note="Status indicators. Accent tone is rare — same accent discipline as Button."
          >
            <div className="v2-demo">
              <Chip tone="neutral">Idle</Chip>
              <Chip tone="ok">Running</Chip>
              <Chip tone="warn">Awaiting approval</Chip>
              <Chip tone="accent">Live</Chip>
              <Chip tone="neutral" dot={false}>No dot</Chip>
            </div>
          </Section>

          <Section
            title="KBD"
            note="Keyboard keys. Used in the palette trigger and tooltips."
          >
            <div className="v2-demo">
              <KBD>⌘K</KBD>
              <KBD>/</KBD>
              <KBD>Esc</KBD>
              <KBD>Enter</KBD>
              <KBD>⇧⌘P</KBD>
            </div>
          </Section>

          <Section
            title="Rule"
            note="Hairline separator. Bold variant for page sections."
          >
            <div className="v2-demo v2-demo--col" style={{ alignItems: "stretch" }}>
              <span className="v2-demo__label">Default</span>
              <Rule />
              <span className="v2-demo__label" style={{ marginTop: "var(--s-3)" }}>Bold</span>
              <Rule bold />
            </div>
          </Section>

          <Section
            title="Meta"
            note="Timestamps and attribution lines. Mono, uppercase, tertiary ink."
          >
            <div className="v2-demo v2-demo--col">
              <Meta>Today · 13:42 · Researcher</Meta>
              <Meta inline>
                <Icon icon={Sparkles} size="sm" />
                4 sources · 18 minutes in
              </Meta>
              <Meta as="time" dateTime="2026-04-23T13:42:00Z">
                13:42 · 4 minutes ago
              </Meta>
            </div>
          </Section>

          <Section
            title="Icon"
            note="Wrapper around lucide-react. Sizes sm (14) / md (16) / lg (20), or any number. Inherits color from parent via currentColor."
          >
            <div className="v2-demo">
              <Icon icon={Mic} size="sm" label="Microphone" />
              <Icon icon={Search} size="md" label="Search" />
              <Icon icon={Check} size="lg" label="Confirmed" />
              <Icon icon={Send} size={24} label="Send" />
              <span style={{ color: "var(--accent)" }}>
                <Icon icon={Sparkles} size="md" label="Suggested" />
              </span>
              <span style={{ color: "var(--warn)" }}>
                <Icon icon={Mic} size="md" label="Muted" />
              </span>
            </div>
          </Section>

        </div>
      </div>
    </div>
  );
}

function Section({
  title,
  note,
  children,
}: {
  title: string;
  note: string;
  children: React.ReactNode;
}) {
  return (
    <section className="v2-section">
      <div className="v2-section__head">
        <h2 className="v2-section__title">{title}</h2>
      </div>
      <p className="v2-section__note">{note}</p>
      {children}
    </section>
  );
}
