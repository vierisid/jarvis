/**
 * Shared keyboard-navigation hook for popover-style list pickers.
 *
 * Each picker (piece library, flow_ref picker) used to roll its own
 * Arrow / Enter / Escape handlers. The behaviour was nearly identical
 * but drifted -- one had stopPropagation, the other didn't; one
 * clamped the active index on filter changes, the other didn't.
 * Centralising the contract here removes the drift and makes future
 * pickers (we'll get more) consistent for free.
 *
 * Returns:
 *   - `activeIdx`         -- current keyboard cursor in the filtered list
 *   - `setActiveIdx`      -- direct setter (used by `onMouseEnter` to sync
 *                            the cursor when the mouse moves)
 *   - `onKeyDown(event)`  -- attach to the popover's root via
 *                            `onKeyDown={onKeyDown}` so the editor's
 *                            outer Escape handler doesn't fire alongside
 *                            it (we stopPropagation on Escape).
 *
 * Out of scope for this hook:
 *   - Outside-click handling (each popover has its own portal ref logic).
 *   - List-row rendering. The hook is data-shape agnostic; the caller
 *     decides how to draw each row.
 *   - Disabled entries that arrow keys should SKIP rather than just
 *     suppress Enter on. The canvas right-click menu has true skip
 *     semantics (its disabled items aren't reachable at all) and is
 *     deliberately NOT migrated to this hook -- the wrapping
 *     `if (!installingId)` pattern used by the piece-library popover
 *     is the right shape for "Enter is a no-op while busy," but the
 *     canvas menu needs arrow-skip + cursor wrap-around that the
 *     simple cursor here doesn't model. If you generalise, add an
 *     optional `skip(idx) => boolean` predicate AND a wrap-around
 *     option, then migrate the canvas menu.
 */

import { useCallback, useEffect, useState, type KeyboardEvent } from "react";

export interface UseListNavOptions<T> {
  /** Items the active cursor walks through. */
  items: ReadonlyArray<T>;
  /** Called when the user presses Enter on the active row. */
  onSelect: (item: T, idx: number) => void;
  /** Called when the user presses Escape inside the popover. */
  onClose: () => void;
}

export interface UseListNavResult {
  activeIdx: number;
  setActiveIdx: (i: number) => void;
  onKeyDown: (e: KeyboardEvent<HTMLElement>) => void;
}

export function useListNav<T>(opts: UseListNavOptions<T>): UseListNavResult {
  const { items, onSelect, onClose } = opts;
  const [activeIdx, setActiveIdx] = useState(0);

  // Clamp the cursor when the items array shrinks past it (e.g. user
  // types a filter that narrows the list). Without this, Enter would
  // briefly target an out-of-range index between renders.
  useEffect(() => {
    if (activeIdx > items.length - 1) {
      setActiveIdx(Math.max(0, items.length - 1));
    }
  }, [items.length, activeIdx]);

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLElement>): void => {
      if (e.key === "Escape") {
        // stopPropagation so the editor's outer Escape handler doesn't
        // also fire (it would otherwise prompt about unsaved changes).
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIdx((i) => Math.min(items.length - 1, i + 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIdx((i) => Math.max(0, i - 1));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const item = items[activeIdx];
        if (item !== undefined) onSelect(item, activeIdx);
      }
    },
    [items, activeIdx, onSelect, onClose],
  );

  return { activeIdx, setActiveIdx, onKeyDown };
}
