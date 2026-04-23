import React, { useRef, useState } from "react";
import { Send } from "lucide-react";
import { Icon, KBD } from "../ui";
import "./Composer.css";

export interface ComposerProps {
  onSubmit?: (text: string) => void;
  placeholder?: string;
  disabled?: boolean;
}

export function Composer({
  onSubmit,
  placeholder = "Ask Jarvis, or press / to summon a tool…",
  disabled,
}: ComposerProps) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/") return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      e.preventDefault();
      inputRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const submit = () => {
    const text = value.trim();
    if (!text || disabled) return;
    onSubmit?.(text);
    setValue("");
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
        <input
          ref={inputRef}
          type="text"
          className="v2-composer__input"
          placeholder={placeholder}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={disabled}
          aria-label="Message Jarvis"
        />
        <span className="v2-composer__slash" aria-hidden="true">
          <KBD>/</KBD>
        </span>
        <button
          type="submit"
          className="v2-composer__send"
          disabled={disabled || value.trim().length === 0}
          aria-label="Send"
        >
          <Icon icon={Send} size="sm" />
        </button>
      </div>
    </form>
  );
}
