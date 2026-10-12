import React, { useId, useRef, useState } from "react";
import { BriefInput, BriefSelect } from "../../components/controls";

/** Native dropdown plus exact entry: suggestions never limit the server query. */
export function FilterField({
  label,
  anyLabel,
  placeholder,
  value,
  options,
  maxLength,
  onChange,
}: {
  label: string;
  anyLabel: string;
  placeholder: string;
  value: string;
  options: readonly { value: string; label: string }[];
  maxLength: number;
  onChange(value: string): void;
}) {
  const [editing, setEditing] = useState(false),
    [draft, setDraft] = useState("");
  const finished = useRef(false);
  const fieldId = useId();
  const returnFocus = useRef(false);
  React.useLayoutEffect(() => {
    if (!editing && returnFocus.current) {
      document.getElementById(fieldId)?.focus();
      returnFocus.current = false;
    }
  }, [editing, fieldId]);
  const finish = (apply: boolean, keyboard = false) => {
    if (finished.current) return;
    finished.current = true;
    returnFocus.current = keyboard;
    if (apply) onChange(draft);
    setEditing(false);
  };
  if (editing)
    return (
      <BriefInput
        label={label}
        placeholder={placeholder}
        autoFocus
        maxLength={maxLength}
        value={draft}
        title="Enter to apply; Escape to cancel"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => finish(true)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            finish(event.key === "Enter", true);
          }
        }}
      />
    );
  const values = [
    ...new Map(
      options
        .filter((option) => option.value !== "")
        .map((option) => [option.value, option]),
    ).values(),
  ];
  if (value && !values.some((option) => option.value === value))
    values.push({ value, label: value });
  // Prefix option values so a stored label can never collide with our commands.
  return (
    <BriefSelect
      id={fieldId}
      label={label}
      value={value ? `value:${value}` : "any"}
      onChange={(event) => {
        if (event.target.value === "exact") {
          finished.current = false;
          setDraft(value);
          setEditing(true);
        } else
          onChange(
            event.target.value === "any" ? "" : event.target.value.slice(6),
          );
      }}
    >
      <option value="any">{anyLabel}</option>
      {values.map((option) => (
        <option key={option.value} value={`value:${option.value}`}>
          {option.label}
        </option>
      ))}
      <option value="exact">
        Enter exact {label === "Source" ? "source" : "reference"}…
      </option>
    </BriefSelect>
  );
}
