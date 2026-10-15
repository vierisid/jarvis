import React, { useEffect, useId, useRef, useState } from "react";
import { BookOpen, Copy, ExternalLink, X } from "lucide-react";
import { providerSetupGuide, type ProviderSetupGuide } from "./provider-setup-guides";
import "./ProviderSetupGuide.css";

/** A separate help action: opening it never selects, saves or tests a provider. */
export function ProviderSetupGuideButton({ kind }: { kind: string }) {
  const guide = providerSetupGuide(kind);
  return guide ? <GuideButton key={kind} guide={guide} /> : null;
}

function GuideButton({ guide }: { guide: ProviderSetupGuide }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return <>
    <button ref={trigger} type="button" className="provider-guide-link" aria-haspopup="dialog"
      aria-label={`${guide.name} setup guide`} onClick={() => setOpen(true)}>
      <BookOpen size={15} aria-hidden="true" /> Setup guide
    </button>
    {open && <GuideDialog guide={guide} onClose={() => {
      setOpen(false);
      trigger.current?.focus();
    }} />}
  </>;
}

function CopyBlock({ text, label }: { text: string; label: string }) {
  const [status, setStatus] = useState("");
  return <div className="provider-guide-code">
    <div className="provider-guide-code__label">
      <span>{label}</span>
      <button type="button" aria-label={`Copy ${label}`} onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setStatus("Copied");
        } catch {
          setStatus("Could not copy. Select the text and copy it manually.");
        }
      }}><Copy size={13} aria-hidden="true" /> Copy</button>
    </div>
    <pre><code>{text}</code></pre>
    <span className="provider-guide-copy-status" role="status">{status}</span>
  </div>;
}

function GuideDialog({ guide, onClose }: { guide: ProviderSetupGuide; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useId();
  const description = useId();
  const closeGuide = () => {
    // Remove native inertness before the caller returns focus to its trigger.
    dialog.current?.close();
    onClose();
  };
  useEffect(() => {
    const element = dialog.current!;
    const overflow = document.body.style.overflow;
    element.showModal();
    document.body.style.overflow = "hidden";
    return () => {
      element.close();
      document.body.style.overflow = overflow;
    };
  }, []);

  return <dialog ref={dialog} className="provider-guide" aria-labelledby={title} aria-describedby={description}
    onKeyDown={(event) => {
      if (event.key === "Escape") { event.stopPropagation(); return; }
      if (event.key !== "Tab") return;
      const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("button, a[href], summary"))
        .filter((item) => item.getClientRects().length > 0);
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault(); last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first?.focus();
      }
    }}
    onCancel={(event) => { event.preventDefault(); closeGuide(); }}
    onClick={(event) => {
      // A click in the backdrop targets the dialog. Padding inside it does not dismiss.
      if (event.target !== event.currentTarget) return;
      const rect = event.currentTarget.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeGuide();
    }}>
    <header className="provider-guide__header">
      <div><span className="provider-guide__eyebrow">Connect your provider</span><h2 id={title}>{guide.name}</h2><p id={description}>{guide.description}</p></div>
      <button type="button" className="provider-guide__close" aria-label="Close setup guide" onClick={closeGuide} autoFocus><X size={19} aria-hidden="true" /></button>
    </header>
    <div className="provider-guide__body">
      <ol className="provider-guide__steps">
        {guide.steps.map((step) => <li key={step.title}>
          <h3>{step.title}</h3><p>{step.text}</p>
          {step.code && <CopyBlock text={step.code} label={step.codeLabel!} />}
        </li>)}
      </ol>
      <section className="provider-guide__connection" aria-label="Connection details">
        <h3>Use these details in Jarvis</h3>
        <CopyBlock text={guide.baseUrl} label="Base URL on the same machine" />
        <dl><div><dt>Model</dt><dd>{guide.model}</dd></div><div><dt>API key</dt><dd>{guide.key}</dd></div></dl>
      </section>
      <p className="provider-guide__processing"><strong>Where requests go.</strong> {guide.processing}</p>
      <details><summary>Jarvis is in Docker or on another machine</summary>
        <p>The URL is reached by the Jarvis server, not your browser. localhost refers to the machine or container running Jarvis.</p>
        <p>With Docker Desktop and a provider on your host, use host.docker.internal in place of localhost. On Linux Docker, configure a host-gateway mapping first, or use a service name on a shared Docker network. For another computer, use its reachable LAN address.</p>
        <p>The provider must listen on an interface Jarvis can reach, and the firewall must allow it. Use a trusted private network with authentication; do not expose an unauthenticated model server to the public internet.</p>
      </details>
      <details><summary>Connection troubleshooting</summary><p>{guide.troubleshooting}</p><p>A successful connection test checks basic generation. It does not guarantee tool calling, vision or enough context for every Jarvis task.</p></details>
      <nav className="provider-guide__sources" aria-label="Official provider documentation">
        {guide.links.map((link) => <a key={link.href} href={link.href} target="_blank" rel="noopener noreferrer">{link.label}<ExternalLink size={12} aria-hidden="true" /></a>)}
      </nav>
    </div>
    <footer className="provider-guide__footer"><span>Your setup stays as you left it.</span><button type="button" onClick={closeGuide}>Back to setup</button></footer>
  </dialog>;
}
