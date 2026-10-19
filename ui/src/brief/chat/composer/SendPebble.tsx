import React, { useState } from "react";
import { Square } from "lucide-react";
import { BriefTooltip } from "../../components/controls";
import { useBriefMotion } from "../../motion";
import { BriefBrand } from "../../styles/BriefBrand";

export function SendPebble({ disabled, stopping, working, reducedMotion, onClick }: {
  disabled: boolean; stopping: boolean; working: boolean; reducedMotion?: boolean; onClick: () => void;
}) {
  const [hovered, setHovered] = useState(false), [focused, setFocused] = useState(false);
  const active = !disabled && !working && (hovered || focused);
  const ref = useBriefMotion<HTMLSpanElement>({ transform: `rotate(${active ? -45 : 0}deg)` },
    { kind: "settle", active, reduced: reducedMotion, immediate: disabled || working });
  // A dispatched stop can be retried until the owner confirms the turn ended.
  const label = stopping ? (disabled ? "Stopping response" : "Retry stop") : working ? "Stop response" : "Send";
  return <BriefTooltip label={label} delay={350}>
    <button type="button" className="brief-composer-send" aria-label={label} aria-disabled={disabled}
      aria-busy={stopping || undefined} data-working={working} data-intent={active}
      onPointerEnter={event => { if (event.pointerType !== "touch") setHovered(true); }} onPointerLeave={() => setHovered(false)}
      onFocus={event => setFocused(event.currentTarget.matches(":focus-visible"))} onBlur={() => setFocused(false)}
      onKeyDown={() => setFocused(true)} onClick={() => { if (!disabled) onClick(); }}>
      <span ref={ref} className="brief-composer-send-mark" aria-hidden="true" hidden={working}><BriefBrand /></span>
      {working && <Square className="brief-composer-stop" size={15} fill="currentColor" aria-hidden="true" />}
    </button>
  </BriefTooltip>;
}
