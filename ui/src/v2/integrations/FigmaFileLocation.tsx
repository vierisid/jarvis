import React, { useId } from "react";
import "./clickup.css";
import { figmaFileKey } from "../../../../src/workflows/runtime/managed-figma";
export function FigmaFileLocation({
  input,
  onChange,
}: {
  input: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
}) {
  const id = useId(),
    value = typeof input.file_key === "string" ? input.file_key : "";
  let key = "",
    error = "";
  if (value.trim() && !value.includes("{{")) {
    try {
      key = figmaFileKey(value);
    } catch {
      error = "Use a Figma file link or file key.";
    }
  }
  return (
    <section className="clickup-location" aria-label="Figma file">
      <label htmlFor={id}>
        <span>
          Figma file <span aria-hidden="true">*</span>
        </span>
        <input
          id={id}
          value={value}
          onChange={(e) => onChange("file_key", e.target.value)}
          required
          placeholder="Paste a Figma link, file key or workflow variable"
          aria-invalid={!!error}
          aria-describedby={id + "-help"}
        />
      </label>
      <p
        id={id + "-help"}
        style={{ margin: 0, fontSize: 13, color: "var(--ink2)" }}
      >
        {error ||
          (key
            ? "File key: " + key
            : "Choose a file the connected account can access. File links and workflow variables are supported.")}
      </p>
    </section>
  );
}
