import React, { useRef, useState } from "react";
import { ArrowRight, Square } from "lucide-react";
import { Icon } from "../ui";
import "./Composer.css";

export interface ComposerProps {
  onSubmit?: (text: string) => void;
  onSlash?: () => void;
  placeholder?: string;
  disabled?: boolean;
  responding?: boolean;
  onStop?: () => void;
}

export function Composer({
  onSubmit,
  onSlash,
  placeholder = "Ask Jarvis, or press / to summon a tool…",
  disabled,
  responding = false,
  onStop,
}: ComposerProps) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Global `/` opens the command palette directly. Suppressed inside any
  // editable element so it doesn't hijack normal typing — typing `/` in
  // the composer input itself is handled by the input's own onKeyDown
  // (palette opens only when the input is empty; otherwise lets the
  // slash through so users can type "/api/something" or similar).
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      e.preventDefault();
      onSlash?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onSlash]);

  const resetHeight = () => {
    const el = inputRef.current;
    if (el) el.style.height = "auto";
  };

  const submit = () => {
    const text = value.trim();
    if (!text || disabled) return;
    onSubmit?.(text);
    setValue("");
    resetHeight();
  };

  const autoGrow = () => {
    const el = inputRef.current;
    if (!el) return;
    // Set to scrollHeight and let CSS max-height clamp the visible size;
    // overflow-y: auto then handles scrolling past the cap.
    el.style.height = "auto";
    el.style.height = el.scrollHeight + "px";
  };

  return (
    <form
      className="v2-composer"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="v2-composer__wrap">
        <textarea
          ref={inputRef}
          rows={1}
          className="v2-composer__input"
          placeholder={placeholder}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onInput={autoGrow}
          onKeyDown={(e) => {
            // Empty input + slash → open palette (same as the pill button
            // and the global hotkey). Mid-text slash types normally so
            // users can write "/api/foo" or quote slashes.
            if (e.key === "/" && value.length === 0 && !e.metaKey && !e.ctrlKey && !e.altKey) {
              e.preventDefault();
              onSlash?.();
              return;
            }
            // Enter submits; Shift+Enter inserts a newline. Textareas don't
            // submit forms on Enter natively, so handle it here. Skip while
            // an IME composition is active so confirming a CJK candidate
            // doesn't accidentally send.
            if (
              e.key === "Enter" &&
              !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey &&
              !e.nativeEvent.isComposing
            ) {
              e.preventDefault();
              submit();
            }
          }}
          disabled={disabled}
          aria-label="Message Jarvis"
        />
        <button
          type="button"
          className="v2-composer__slash"
          onClick={onSlash}
          aria-label="Open command palette"
        >
          /
        </button>
        <button
          type={responding ? "button" : "submit"}
          className={`v2-composer__send${responding ? " v2-composer__send--stop" : ""}`}
          disabled={disabled || (!responding && value.trim().length === 0)}
          aria-label={responding ? "Stop response" : "Send"}
          title={responding ? "Stop response" : "Send"}
          onClick={responding ? onStop : undefined}
        >
          <Icon icon={responding ? Square : ArrowRight} size={12} strokeWidth={2.5} />
        </button>
      </div>
    </form>
  );
}
