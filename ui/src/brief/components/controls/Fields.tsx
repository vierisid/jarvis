import React, { useId } from "react";
import type { InputHTMLAttributes, TextareaHTMLAttributes, SelectHTMLAttributes, ReactNode } from "react";
import { Check, ChevronDown, CircleAlert, Search } from "lucide-react";
import type { ControlSize } from "./Buttons";

interface FieldProps {
  label: string;
  hint?: string;
  error?: string;
  saved?: string;
  /** Reserve the longest authored validation message before it is shown. */
  reserveMessage?: string;
  density?: ControlSize;
}
type NativeField = InputHTMLAttributes<HTMLInputElement> | TextareaHTMLAttributes<HTMLTextAreaElement> | SelectHTMLAttributes<HTMLSelectElement>;

function Field({ label, hint, error, saved, reserveMessage, density = "md", id, describedBy, disabled, search, select, children }:
  FieldProps & { id: string; describedBy?: string; disabled?: boolean; search?: boolean; select?: boolean;
    children: (shared: { id: string; "aria-describedby": string; "aria-invalid": boolean | undefined }) => ReactNode }) {
  const messageId = `${id}-feedback`;
  // All authored messages occupy one grid cell, including while hidden. A
  // known long error therefore reserves space before validation occurs.
  const message = error || saved || hint || "";
  return <div className={`brief-field brief-control--${density}`} data-invalid={Boolean(error)} data-disabled={Boolean(disabled)}>
    <label htmlFor={id} className="brief-field__label">{label}</label>
    <div className="brief-field__surface" data-search={Boolean(search)} data-select={Boolean(select)}>
      {search && <Search size={16} className="brief-field__leading" aria-hidden="true" />}
      {children({ id, "aria-describedby": [describedBy, messageId].filter(Boolean).join(" "), "aria-invalid": error ? true : undefined })}
      <span className="brief-field__adornment" aria-hidden="true">
        {error ? <CircleAlert size={16} /> : saved ? <Check size={16} className="brief-control__saved" /> : null}
      </span>
      {select && <ChevronDown size={16} className="brief-field__chevron" aria-hidden="true" />}
    </div>
    <div className="brief-field__feedback" data-error={Boolean(error)} data-saved={Boolean(saved) && !error}>
      {[hint, error, saved, reserveMessage].filter(Boolean).map((text, index) => <span key={index} aria-hidden="true" className="brief-field__reserve">{text}</span>)}
      <span id={messageId} aria-live="polite">{message}</span>
    </div>
  </div>;
}

function useField({ id, "aria-describedby": describedBy, label, hint, error, saved, reserveMessage, density, disabled, ...native }:
  NativeField & FieldProps) {
  const generated = useId();
  return { frame: { id: id ?? generated, describedBy, label, hint, error, saved, reserveMessage, density, disabled }, native };
}

export function BriefInput(props: Omit<InputHTMLAttributes<HTMLInputElement>, "size"> & FieldProps) {
  const { frame, native } = useField(props);
  return <Field {...frame} search={props.type === "search"}>{shared =>
    <input {...native as InputHTMLAttributes<HTMLInputElement>} {...shared} disabled={props.disabled} />
  }</Field>;
}
export function BriefTextarea(props: TextareaHTMLAttributes<HTMLTextAreaElement> & FieldProps) {
  const { frame, native } = useField(props);
  return <Field {...frame}>{shared =>
    <textarea {...native as TextareaHTMLAttributes<HTMLTextAreaElement>} {...shared} disabled={props.disabled} />
  }</Field>;
}
export function BriefSelect(props: Omit<SelectHTMLAttributes<HTMLSelectElement>, "size" | "multiple"> & FieldProps) {
  const { frame, native } = useField(props);
  return <Field {...frame} select>{shared =>
    <select {...native as SelectHTMLAttributes<HTMLSelectElement>} {...shared} disabled={props.disabled} />
  }</Field>;
}
