import React, { useId, useRef } from "react";
import type { ReactNode } from "react";

export function BriefSwitch({ label, checked, onCheckedChange, disabled = false, onLabel = "On", offLabel = "Off" }:
  { label: string; checked: boolean; onCheckedChange: (checked: boolean) => void; disabled?: boolean; onLabel?: string; offLabel?: string }) {
  return <span className="brief-switch-row" data-disabled={disabled}>
    <button type="button" role="switch" aria-label={label} aria-checked={checked} disabled={disabled}
      className="brief-switch" onClick={() => onCheckedChange(!checked)}>
      <span className="brief-switch__track" aria-hidden="true"><span className="brief-switch__thumb" /></span>
    </button>
    <span className="brief-switch__value" aria-hidden="true">
      <span className="brief-button__reserve">{onLabel}</span><span className="brief-button__reserve">{offLabel}</span>
      <span>{checked ? onLabel : offLabel}</span>
    </span>
  </span>;
}

export interface BriefChoice { value: string; label: string; disabled?: boolean }
export function BriefSegments({ label, options, value, onValueChange }:
  { label: string; options: readonly BriefChoice[]; value: string; onValueChange: (value: string) => void }) {
  const name = useId();
  return <fieldset className="brief-segments">
    <legend className="brief-sr-only">{label}</legend>
    {options.map(option => <label className="brief-segment" key={option.value}>
      <input type="radio" name={name} value={option.value} checked={value === option.value} disabled={option.disabled}
        onChange={() => onValueChange(option.value)} />
      <span data-label={option.label}>{option.label}</span>
    </label>)}
  </fieldset>;
}

/** Manual activation: arrows move focus; Enter/Space select. Panels stay mounted. */
export function BriefTabs({ label, items, value, onValueChange }:
  { label: string; items: readonly (BriefChoice & { content: ReactNode })[]; value: string; onValueChange: (value: string) => void }) {
  const id = useId();
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const enabled = items.filter(item => !item.disabled);
  const panelId = (key: string) => `${id}-panel-${encodeURIComponent(key)}`;
  const tabId = (key: string) => `${id}-tab-${encodeURIComponent(key)}`;
  return <div className="brief-tabs">
    <div role="tablist" aria-label={label} className="brief-tabs__list">
      {items.map(item => <button type="button" role="tab" key={item.value} id={tabId(item.value)}
        ref={node => { if (node) buttons.current.set(item.value, node); else buttons.current.delete(item.value); }}
        aria-selected={value === item.value} aria-controls={panelId(item.value)} disabled={item.disabled}
        tabIndex={value === item.value || !enabled.some(option => option.value === value) && item === enabled[0] ? 0 : -1}
        onClick={() => onValueChange(item.value)}
        onKeyDown={event => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          const index = enabled.findIndex(option => option.value === item.value);
          const next = event.key === "Home" ? 0 : event.key === "End" ? enabled.length - 1
            : (index + (event.key === "ArrowRight" ? 1 : -1) + enabled.length) % enabled.length;
          const target = enabled[next];
          if (target) buttons.current.get(target.value)?.focus();
        }}><span data-label={item.label}>{item.label}</span></button>)}
    </div>
    {items.map(item => <div key={item.value} role="tabpanel" id={panelId(item.value)} aria-labelledby={tabId(item.value)}
      tabIndex={0} hidden={value !== item.value} className="brief-tabs__panel">{item.content}</div>)}
  </div>;
}
