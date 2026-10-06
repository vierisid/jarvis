import React, { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { BriefTooltip } from "../../components/controls";
import { useBriefMotion, useBriefReducedMotion } from "../../motion";
import { composerAvailability, draftError, prefillSuggestion, type ComposerBinding, type ComposerSuggestion } from "./model";
import { SendPebble } from "./SendPebble";
import "./composer.css";

interface Props {
  mode: "live" | "preview";
  binding?: ComposerBinding;
  suggestions?: readonly ComposerSuggestion[];
  label?: string;
  placeholder?: string;
  reducedMotion?: boolean;
  /** D-14 supplies its 44px attachment entry; no upload or menu is invented here. */
  attachmentControl?: React.ReactNode;
}
export function ConversationComposer(props: Props) {
  const availability = composerAvailability(props.mode, props.binding);
  if (availability !== "ready") return <div className="brief-composer-unavailable" role="status" data-composer-mode={availability}>
    {availability === "empty" ? "Open a conversation to write." : availability === "loading" ? "Loading conversation…"
      : availability === "legacy" ? "Use the current chat to continue." : "Writing is unavailable."}
  </div>;
  return <ScopedComposer key={JSON.stringify([props.binding!.scopeId, props.binding!.conversationId])} {...props} binding={props.binding!} />;
}

function ScopedComposer({ binding, suggestions = [], label = "Message Jarvis", placeholder = "Ask Jarvis…", reducedMotion, attachmentControl }: Props & { binding: ComposerBinding }) {
  const id = useId(), input = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false), compositionEnded = useRef(-Infinity);
  const lock = useRef(false), mounted = useRef(true);
  const actionEpoch = useRef(0);
  const [pending, setPending] = useState<"send" | "cancel" | null>(null), [error, setError] = useState<string | null>(null);
  const [stopIntent, setStopIntent] = useState<{ turnKey: string; ownerError: string | null } | null>(null);
  const [inputHeight, setInputHeight] = useState(44);
  const reduced = useBriefReducedMotion(reducedMotion);
  const surface = useBriefMotion<HTMLDivElement>({ height: inputHeight + 12 }, { kind: "selection", active: true, reduced });
  const invalid = draftError(binding.draft, binding.maxBytes);
  const working = !!binding.turn;
  const turnKey = binding.turn ? JSON.stringify([binding.turn.conversationId, binding.turn.turnId, binding.turn.requestId]) : null;
  const stopping = !!stopIntent && stopIntent.turnKey === turnKey && binding.connected && (!binding.error || stopIntent.ownerError === binding.error);
  const disabled = !binding.connected || binding.metadataPending || !!pending || (!working && (!binding.draft.trim() || !!invalid));
  const status = error || invalid || (!binding.connected ? "Reconnecting… Your draft is kept." : stopping ? "Stopping response…"
    : pending === "send" || binding.pendingAcceptance ? "Sending…" : binding.error);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useLayoutEffect(() => {
    if (!stopIntent) return;
    if (stopping) {
      // The adapter dismisses the old owner error on retry. Observe that clear
      // so a later failure with the same message is still a new failure.
      if (stopIntent.ownerError && !binding.error) setStopIntent({ ...stopIntent, ownerError: null });
      return;
    }
    // Dispatch completion is not a terminal event. Retire only this turn's intent
    // on owner state/error or disconnection; ignore any late dispatch callback.
    actionEpoch.current++; lock.current = false;
    setPending(null); setStopIntent(null);
  }, [stopIntent, stopping, binding.error]);
  useLayoutEffect(() => {
    const element = input.current!;
    const measure = () => {
      const scroll = element.scrollTop;
      element.style.height = "0px";
      const next = Math.min(92, Math.max(44, element.scrollHeight));
      // CSS follows the animated surface, keeping the text viewport inside it
      // on every frame. Only measurement temporarily overrides that height.
      element.style.height = "";
      element.scrollTop = scroll;
      setInputHeight(next);
    };
    measure();
    // Width changes can wrap the same draft. Ignore height-only observations.
    let width = element.clientWidth;
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => {
      if (element.clientWidth !== width) { width = element.clientWidth; measure(); }
    });
    observer?.observe(element);
    return () => observer?.disconnect();
  }, [binding.draft]);

  function edit(text: string) {
    try { binding.actions.setDraft(text); setError(null); }
    catch { setError("Your draft could not be saved. Try again."); }
  }
  async function act(kind: "send" | "cancel") {
    if (lock.current || disabled || (kind === "send" && (working || composing.current || performance.now() - compositionEnded.current < 32))) return;
    if (kind === "cancel" && !working) return;
    const epoch = ++actionEpoch.current;
    lock.current = true; setPending(kind); setError(null);
    if (kind === "cancel") setStopIntent({ turnKey: turnKey!, ownerError: binding.error });
    try {
      if (kind === "send") await binding.actions.send(binding.draft);
      else await binding.actions.cancel();
      // Only the owner clears an accepted matching draft. Never clear it on dispatch.
    } catch {
      if (mounted.current && actionEpoch.current === epoch) {
        if (kind === "cancel") setStopIntent(null);
        setError(kind === "send" ? "Could not send. Your draft is still here." : "Could not stop the response. Try again.");
      }
    } finally {
      if (mounted.current && actionEpoch.current === epoch) { lock.current = false; setPending(null); }
    }
  }
  function suggest(text: string) {
    if (composing.current || binding.metadataPending) return;
    edit(prefillSuggestion(binding.draft, text));
    input.current?.focus({ preventScroll: true });
    requestAnimationFrame(() => {
      const element = input.current;
      if (element) { element.setSelectionRange(element.value.length, element.value.length); element.scrollTop = element.scrollHeight; }
    });
  }
  return <div className="brief-composer" data-composer-mode="ready" data-reduced-motion={reduced} data-conversation-id={binding.conversationId}>
    <div className="brief-composer-status" id={`${id}-status`} role="status">{status || ""}</div>
    {!!suggestions.length && <div className="brief-composer-suggestions" aria-label="Message suggestions">
      {suggestions.map(suggestion => <button type="button" key={suggestion.id} aria-disabled={binding.metadataPending}
        onPointerDown={event => event.preventDefault()} onClick={() => suggest(suggestion.text)}>{suggestion.label}</button>)}
    </div>}
    <div ref={surface} className="brief-composer-surface" data-invalid={!!invalid}>
      <div className="brief-composer-attachment">{attachmentControl ?? <BriefTooltip label="Attachments unavailable">
        <button type="button" aria-label="Add attachment" aria-disabled="true"><Plus size={18} aria-hidden="true" /></button>
      </BriefTooltip>}</div>
      <textarea ref={input} id={id} aria-label={label} placeholder={placeholder} value={binding.draft} rows={1}
        aria-describedby={`${id}-status`} aria-invalid={!!invalid} data-pebble-focus
        onChange={event => edit(event.target.value)}
        onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; compositionEnded.current = performance.now(); }}
        onKeyDown={event => {
          if (event.key !== "Enter" || event.shiftKey || event.altKey || composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || performance.now() - compositionEnded.current < 32) return;
          event.preventDefault(); if (!event.repeat) void act("send");
        }} />
      <div className="brief-composer-send-target"><SendPebble disabled={disabled} stopping={stopping} working={working}
        reducedMotion={reduced} onClick={() => void act(working ? "cancel" : "send")} /></div>
    </div>
  </div>;
}
