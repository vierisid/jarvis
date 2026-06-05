import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Filter, Search, X } from "lucide-react";
import { Icon } from "../../ui";

/**
 * Multi-select dropdown for long filter lists (models, subsystems, providers
 * in the Usage room). A button shows the count of active selections; clicking
 * opens a popover with a search box + checkable list. Outside-click and ESC
 * close it. When the option list is empty the button is hidden entirely.
 *
 * The clear-X is a sibling of the toggle button (not nested inside it) so the
 * markup stays valid HTML and screen readers see two distinct controls. Both
 * share a single `data-active` flag on the root for joined-button styling.
 *
 * We deliberately keep this co-located with the Usage room rather than the
 * shared ui/ index: it's tuned to the Usage filter shape (string[] options,
 * string[] selection, toggle semantics) and pulling it general too early
 * would force a wider API that doesn't have other callers yet.
 */
export function MultiSelectDropdown({
  label,
  options,
  selected,
  onToggle,
  onClear,
  renderLabel,
  searchableThreshold = 8,
}: {
  label: string;
  options: string[];
  selected: string[];
  onToggle: (v: string) => void;
  onClear: () => void;
  renderLabel?: (v: string) => string;
  /** Show the search box once the option count exceeds this. */
  searchableThreshold?: number;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  // Outside-click + ESC close.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current) return;
      if (e.target instanceof Node && !rootRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Focus the search input when the popover opens (only if it's rendered).
  useEffect(() => {
    if (open && searchRef.current) searchRef.current.focus();
  }, [open]);

  const filtered = useMemo(() => {
    if (!query) return options;
    const q = query.toLowerCase();
    return options.filter((o) => o.toLowerCase().includes(q));
  }, [options, query]);

  if (options.length === 0) return null;

  const count = selected.length;
  const showSearch = options.length > searchableThreshold;
  const clearable = count > 0;

  return (
    <div className="v2-usage__msdd" ref={rootRef} data-active={clearable}>
      <button
        type="button"
        className="v2-usage__msdd-btn"
        data-active={clearable}
        data-clearable={clearable}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon icon={Filter} size="sm" />
        <span className="v2-usage__msdd-label">{label}</span>
        {clearable && (
          <span className="v2-usage__msdd-count" aria-label={`${count} selected`}>
            {count}
          </span>
        )}
        <Icon icon={ChevronDown} size="sm" />
      </button>
      {clearable && (
        <button
          type="button"
          className="v2-usage__msdd-clear"
          aria-label={`Clear ${label} filter`}
          onClick={onClear}
        >
          <Icon icon={X} size="sm" />
        </button>
      )}
      {open && (
        <div className="v2-usage__msdd-pop" role="listbox" aria-multiselectable="true">
          {showSearch && (
            <div className="v2-usage__msdd-search">
              <Icon icon={Search} size="sm" />
              <input
                ref={searchRef}
                type="text"
                value={query}
                placeholder={`Filter ${label.toLowerCase()}...`}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
          )}
          <ul className="v2-usage__msdd-list">
            {filtered.length === 0 && (
              <li className="v2-usage__msdd-empty">No matches.</li>
            )}
            {filtered.map((v) => {
              const active = selected.includes(v);
              return (
                <li key={v}>
                  <button
                    type="button"
                    className="v2-usage__msdd-item"
                    role="option"
                    aria-selected={active}
                    data-active={active}
                    onClick={() => onToggle(v)}
                  >
                    <span className="v2-usage__msdd-check" aria-hidden="true">
                      {active && <Icon icon={Check} size="sm" />}
                    </span>
                    <span className="v2-usage__msdd-text">{renderLabel?.(v) ?? v}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
