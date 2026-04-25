import React, { useCallback, useEffect, useRef, useState } from "react";
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

export function Thread({
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
}: ThreadProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const prevLengthRef = useRef(items.length);

  const [stickToBottom, setStickToBottom] = useState(true);
  const [unseen, setUnseen] = useState(0);

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

      <div className="v2-thread__scroll" ref={scrollRef} onScroll={onScroll}>
        <div className="v2-thread__inner">
          {items.length === 0 ? (
            <EmptyState />
          ) : (
            items.map((item) => (
              <ItemRenderer
                key={item.id}
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
