import React from "react";
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from "react";
import { ArrowLeft, ArrowRight, Check, CircleAlert, LoaderCircle } from "lucide-react";
import { BriefTooltip } from "./Floating";

export type ControlSize = "sm" | "md";
export type ActionState = "idle" | "pending" | "success" | "error";
export interface BriefButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  ref?: React.Ref<HTMLButtonElement>;
  variant?: "primary" | "secondary" | "ghost" | "text" | "danger";
  size?: ControlSize;
  state?: ActionState;
  /** All possible labels reserve their width before a request starts. */
  stateLabels?: Partial<Record<Exclude<ActionState, "idle">, string>>;
  icon?: ReactNode;
}

export function BriefButton({ variant = "ghost", size = "md", state = "idle", stateLabels,
  icon, disabled, className = "", children, onClick, type = "button", ...props }: BriefButtonProps) {
  const busy = state === "pending";
  const StateIcon = busy ? LoaderCircle : state === "success" ? Check : state === "error" ? CircleAlert : null;
  const label = state !== "idle" ? stateLabels?.[state] ?? children : children;
  const hasIcon = Boolean(icon || stateLabels);
  return <button {...props} type={type} disabled={disabled}
    aria-busy={busy || undefined} aria-disabled={busy || props["aria-disabled"]}
    className={`brief-button brief-button--${variant} brief-control--${size} ${className}`}
    data-state={state} onClick={event => {
      if (disabled || busy || props["aria-disabled"] === true || props["aria-disabled"] === "true") {
        event.preventDefault(); return;
      }
      onClick?.(event);
    }}>
    {hasIcon && <span className="brief-button__icon" aria-hidden="true">
      {StateIcon ? <StateIcon size={16} className={busy ? "brief-control__busy" : undefined} /> : icon}
    </span>}
    <span className="brief-button__labels">
      <span className="brief-button__reserve" aria-hidden="true">{children}</span>
      {Object.entries(stateLabels ?? {}).map(([key, text]) => <span key={key} className="brief-button__reserve" aria-hidden="true">{text}</span>)}
      <span className="brief-button__label" aria-live={stateLabels ? "polite" : undefined}>{label}</span>
    </span>
  </button>;
}

export interface BriefIconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "aria-label"> {
  label: string;
  icon: ReactNode;
  size?: ControlSize;
  intent?: "neutral" | "destructive";
  tooltip?: boolean;
}
export function BriefIconButton({ label, icon, size = "md", intent = "neutral", tooltip = true,
  className = "", type = "button", ...props }: BriefIconButtonProps) {
  const button = <button {...props} type={type} aria-label={label}
    className={`brief-icon-button brief-control--${size} ${className}`} data-intent={intent}>
    <span aria-hidden="true">{icon}</span>
  </button>;
  return tooltip ? <BriefTooltip label={label}>{button}</BriefTooltip> : button;
}

export function BriefLink({ children, direction = "forward", className = "", ...props }:
  AnchorHTMLAttributes<HTMLAnchorElement> & { direction?: "forward" | "back" }) {
  const Arrow = direction === "back" ? ArrowLeft : ArrowRight;
  return <a {...props} className={`brief-link ${className}`} data-direction={direction}>
    {direction === "back" && <Arrow size={16} aria-hidden="true" />}
    <span>{children}</span>
    {direction === "forward" && <Arrow size={16} aria-hidden="true" />}
  </a>;
}
