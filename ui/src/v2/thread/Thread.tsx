import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { ArrowDown } from "lucide-react";
import { Icon } from "../ui";
import { ApprovalCard } from "./ApprovalCard";
import { ClarifierCard } from "./ClarifierCard";
import { RepeatBackCard } from "./RepeatBackCard";
import { InlineCard } from "./InlineCard";
import { RoomWindow } from "../rooms/RoomWindow";
import {
  JarvisSpeechItem,
  JarvisThoughtItem,
  ResultItem,
  UserTextItem,
  UserVoiceItem,
} from "./items";
import type { ThreadItem } from "./types";
import "./Thread.css";

const NEAR_BOTTOM_PX = 80;

export interface ThreadProps {
  items: ThreadItem[];
  onApprove?: (id: string) => void;
  onCancel?: (id: string) => void;
  onFocusCard?: (id: string) => void;
  onClarifier?: (id: string, decision: "confirm" | "cancel") => void;
  onRepeatBack?: (id: string, decision: "confirm" | "cancel") => void;
  // Phase 6.1.5 — Room window controls
  onRoomClose?: (id: string) => void;
  onRoomMinimize?: (id: string) => void;
  onRoomRestore?: (id: string) => void;
  onRoomExpand?: (id: string) => void;
  onRoomLayoutChange?: (id: string, next: { mode: "inline" } | { mode: "floating"; rect: { x: number; y: number; w: number; h: number } }) => void;
  /**
   * When true, shows a dev-mode "append mock item" button to exercise
   * scroll behavior during Phase 3A. Phase 3B swaps items for live events
   * and this flag is dropped.
   */
  dev?: { onAppend: () => void };
}

/**
 * Imperative handle exposed to parents (e.g. NotificationDrawer's "jump
 * to in thread" action). The instance methods are intentionally narrow
 * — anything else should use props.
 */
export type ThreadHandle = {
  /**
   * Scroll the thread item with this id into view and briefly highlight
   * it. No-op if the id isn't currently rendered. Returns true if the
   * item was found and scrolled.
   */
  scrollToItem: (id: string) => boolean;
};

export const Thread = forwardRef<ThreadHandle, ThreadProps>(function Thread({
  items,
  onApprove,
  onCancel,
  onFocusCard,
  onClarifier,
  onRepeatBack,
  onRoomClose,
  onRoomMinimize,
  onRoomRestore,
  onRoomExpand,
  onRoomLayoutChange,
  dev,
}, ref) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const prevLengthRef = useRef(items.length);

  const [stickToBottom, setStickToBottom] = useState(true);
  const [unseen, setUnseen] = useState(0);
  // Phase 7 Pass B — roving tabindex anchor for keyboard navigation.
  // Null = use the most-recent item as the entry point.
  const [activeItemId, setActiveItemId] = useState<string | null>(null);

  const focusItemById = useCallback((id: string) => {
    const root = scrollRef.current;
    if (!root) return;
    const target = root.querySelector<HTMLElement>(
      `[data-thread-item-id="${cssEscape(id)}"]`,
    );
    target?.focus();
  }, []);

  const handleItemKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>, idx: number) => {
      // Don't hijack typing inside any focusable child (input, textarea,
      // editable card actions). Only act when the wrapper itself is the
      // event target — i.e. arrow keys at the row level.
      if (e.target !== e.currentTarget) return;

      if (e.key === "ArrowDown" && idx < items.length - 1) {
        e.preventDefault();
        const next = items[idx + 1]!;
        setActiveItemId(next.id);
        requestAnimationFrame(() => focusItemById(next.id));
      } else if (e.key === "ArrowUp" && idx > 0) {
        e.preventDefault();
        const prev = items[idx - 1]!;
        setActiveItemId(prev.id);
        requestAnimationFrame(() => focusItemById(prev.id));
      } else if (e.key === "Home" && items.length > 0) {
        e.preventDefault();
        const first = items[0]!;
        setActiveItemId(first.id);
        requestAnimationFrame(() => focusItemById(first.id));
      } else if (e.key === "End" && items.length > 0) {
        e.preventDefault();
        const last = items[items.length - 1]!;
        setActiveItemId(last.id);
        requestAnimationFrame(() => focusItemById(last.id));
      } else if (e.key === "Enter" || e.key === " ") {
        // Activate the row's primary action — for object cards this
        // opens the InlineCard's "Focus" target (room window); for
        // room-windows themselves, expand to the fullscreen overlay.
        const item = items[idx];
        if (!item) return;
        if (item.kind === "card") {
          e.preventDefault();
          onFocusCard?.(item.id);
        } else if (item.kind === "room-window") {
          e.preventDefault();
          onRoomExpand?.(item.id);
        }
      }
    },
    [items, focusItemById, onFocusCard, onRoomExpand],
  );

  const scrollToBottom = useCallback((smooth = true) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({
      top: el.scrollHeight,
      behavior: smooth ? "smooth" : "auto",
    });
  }, []);

  // Initial scroll to bottom on mount
  useEffect(() => {
    scrollToBottom(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // React to new items
  useEffect(() => {
    const added = items.length - prevLengthRef.current;
    if (added > 0) {
      if (stickToBottom) {
        scrollToBottom(true);
      } else {
        setUnseen((n) => n + added);
      }
    }
    prevLengthRef.current = items.length;
  }, [items.length, stickToBottom, scrollToBottom]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - (el.scrollTop + el.clientHeight);
    const near = distFromBottom <= NEAR_BOTTOM_PX;
    setStickToBottom(near);
    if (near) setUnseen(0);
  }, []);

  const jump = useCallback(() => {
    scrollToBottom(true);
    setUnseen(0);
    setStickToBottom(true);
  }, [scrollToBottom]);

  // Imperative scroll-to-item with brief highlight. Used by the
  // notification drawer to bring an approval/clarifier card into view.
  // The highlight is a CSS class with its own animation; removing it
  // after 1.5s lets the user re-trigger it on subsequent jumps.
  useImperativeHandle(ref, () => ({
    scrollToItem(id: string): boolean {
      const root = scrollRef.current;
      if (!root) return false;
      const target = root.querySelector<HTMLElement>(
        `[data-thread-item-id="${cssEscape(id)}"]`,
      );
      if (!target) return false;
      target.scrollIntoView({ behavior: "smooth", block: "center" });
      target.classList.remove("v2-thread__item--flash");
      // Force reflow so the animation restarts on a re-trigger.
      void target.offsetWidth;
      target.classList.add("v2-thread__item--flash");
      window.setTimeout(() => {
        target.classList.remove("v2-thread__item--flash");
      }, 1600);
      return true;
    },
  }), []);

  return (
    <div className="v2-thread">
      {dev && (
        <div className="v2-thread__dev">
          <button
            type="button"
            className="v2-thread__dev-btn"
            onClick={dev.onAppend}
            aria-label="Append a mock thread item"
          >
            + mock item
          </button>
        </div>
      )}

      {/* Phase 7 Pass A — `role="log"` + `aria-live="polite"` so screen
          readers announce new thread items (replies, approvals, clarifiers)
          as they arrive, without interrupting the user. `aria-relevant`
          scoped to additions because items rarely change in place. */}
      <div
        className="v2-thread__scroll"
        ref={scrollRef}
        onScroll={onScroll}
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        aria-label="Conversation"
      >
        <div className="v2-thread__inner">
          {items.length === 0 ? (
            <EmptyState />
          ) : (
            items.map((item, idx) => (
              <div
                key={item.id}
                data-thread-item-id={item.id}
                className="v2-thread__item"
                // Phase 7 Pass B — roving tabindex for arrow-key
                // navigation through thread items. Most-recent item
                // gets tabIndex=0 (entry point from a Tab from above);
                // others are tabIndex=-1 until the user navigates to
                // them via ↑/↓.
                tabIndex={item.id === activeItemId || (activeItemId === null && idx === items.length - 1) ? 0 : -1}
                onFocus={() => setActiveItemId(item.id)}
                onKeyDown={(e) => handleItemKeyDown(e, idx)}
              >
                <ItemRenderer
                  item={item}
                  onApprove={onApprove}
                  onCancel={onCancel}
                  onFocusCard={onFocusCard}
                  onClarifier={onClarifier}
                  onRepeatBack={onRepeatBack}
                  onRoomClose={onRoomClose}
                  onRoomMinimize={onRoomMinimize}
                  onRoomRestore={onRoomRestore}
                  onRoomExpand={onRoomExpand}
                  onRoomLayoutChange={onRoomLayoutChange}
                />
              </div>
            ))
          )}
          <div ref={endRef} />
        </div>
      </div>

      {!stickToBottom && unseen > 0 && (
        <button type="button" className="v2-thread__jump" onClick={jump}>
          <span className="v2-thread__jump-dot" aria-hidden="true" />
          {unseen} new · jump to latest
          <Icon icon={ArrowDown} size="sm" />
        </button>
      )}
    </div>
  );
});

/** Tiny CSS.escape polyfill — only escapes the chars we'd actually see in
 *  a thread item id (alphanumerics, dashes, underscores are common; quotes
 *  and backslashes need escaping if they ever appear). */
function cssEscape(s: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(s);
  return s.replace(/["\\]/g, "\\$&");
}

function ItemRenderer({
  item,
  onApprove,
  onCancel,
  onFocusCard,
  onClarifier,
  onRepeatBack,
  onRoomClose,
  onRoomMinimize,
  onRoomRestore,
  onRoomExpand,
  onRoomLayoutChange,
}: {
  item: ThreadItem;
  onApprove?: (id: string) => void;
  onCancel?: (id: string) => void;
  onFocusCard?: (id: string) => void;
  onClarifier?: (id: string, decision: "confirm" | "cancel") => void;
  onRepeatBack?: (id: string, decision: "confirm" | "cancel") => void;
  onRoomClose?: (id: string) => void;
  onRoomMinimize?: (id: string) => void;
  onRoomRestore?: (id: string) => void;
  onRoomExpand?: (id: string) => void;
  onRoomLayoutChange?: (id: string, next: { mode: "inline" } | { mode: "floating"; rect: { x: number; y: number; w: number; h: number } }) => void;
}) {
  switch (item.kind) {
    case "user-voice":
      return <UserVoiceItem item={item} />;
    case "user-text":
      return <UserTextItem item={item} />;
    case "jarvis-speech":
      return <JarvisSpeechItem item={item} />;
    case "jarvis-thought":
      return <JarvisThoughtItem item={item} />;
    case "result":
      return <ResultItem item={item} />;
    case "approval":
      return (
        <ApprovalCard
          intent={item.intent}
          category={item.category}
          impact={item.impact}
          highlights={item.highlights}
          onApprove={() => onApprove?.(item.id)}
          onCancel={() => onCancel?.(item.id)}
        />
      );
    case "card":
      return (
        <InlineCard
          objectType={item.objectType}
          title={item.title}
          summary={item.summary}
          meta={item.meta}
          status={item.status}
          onFocus={() => onFocusCard?.(item.id)}
        />
      );
    case "clarifier":
      return (
        <ClarifierCard
          transcript={item.transcript}
          primary={item.primary}
          alternatives={item.alternatives}
          confidence={item.confidence}
          onConfirm={() => onClarifier?.(item.id, "confirm")}
          onCancel={() => onClarifier?.(item.id, "cancel")}
        />
      );
    case "repeat-back":
      return (
        <RepeatBackCard
          transcript={item.transcript}
          confidence={item.confidence}
          onConfirm={() => onRepeatBack?.(item.id, "confirm")}
          onCancel={() => onRepeatBack?.(item.id, "cancel")}
        />
      );
    case "room-window":
      // Phase 6.1.6: only render the inline-mode windows here. Floating
      // windows render in the FloatingWindowsLayer, mounted by AppShellV2.
      if (item.layout.mode !== "inline") return null;
      return (
        <RoomWindow
          roomKey={item.roomKey}
          state={item.state}
          layout={item.layout}
          onClose={() => onRoomClose?.(item.id)}
          onMinimize={() => onRoomMinimize?.(item.id)}
          onRestore={() => onRoomRestore?.(item.id)}
          onExpand={() => onRoomExpand?.(item.id)}
          onLayoutChange={(next) => onRoomLayoutChange?.(item.id, next)}
        />
      );
  }
}

function EmptyState() {
  return (
    <section className="v2-thread__empty">
      <span className="v2-thread__empty-eyebrow">Phase 3A · thread ready</span>
      <h1 className="v2-thread__empty-title">
        The thread is <em>the whole app.</em>
      </h1>
      <p className="v2-thread__empty-lede">
        Nothing yet. Tap the orb, press <kbd>/</kbd>, or wait for the morning brief — every
        message flows through this surface.
      </p>
    </section>
  );
}
