import React from "react";
import { Construction } from "lucide-react";
import { Icon } from "../ui";
import { RoomShell } from "./RoomShell";
import type { RoomKey } from "../router";
import "./RoomPlaceholder.css";

export interface RoomPlaceholderProps {
  roomKey: RoomKey;
  title: string;
  /** Pretty subtitle for the empty state. */
  subtitle?: string;
  /** Phase tag for the placeholder body, e.g. "Phase 6.4 — Workflows Room". */
  phaseTag: string;
  /** Short description of what will live here. */
  description: string;
}

/**
 * Empty placeholder rendered for any Room whose real implementation hasn't
 * landed yet. Mounts the `<RoomShell>` so the slide-up + Esc + breadcrumb
 * behavior is testable from the moment Phase 6.0 ships.
 *
 * Each placeholder is replaced by its real Room component as the
 * corresponding Phase 6.x sub-phase lands.
 */
export function RoomPlaceholder({
  roomKey,
  title,
  subtitle,
  phaseTag,
  description,
}: RoomPlaceholderProps) {
  return (
    <RoomShell title={title} subtitle={subtitle} breadcrumb={[title]}>
      <div className="v2-room-placeholder">
        <div className="v2-room-placeholder__icon">
          <Icon icon={Construction} size="lg" />
        </div>
        <div className="v2-room-placeholder__phase">{phaseTag}</div>
        <h2 className="v2-room-placeholder__title">
          The <em>{title}</em> room is coming soon.
        </h2>
        <p className="v2-room-placeholder__body">{description}</p>
        <div className="v2-room-placeholder__meta">
          <span className="v2-room-placeholder__meta-key">key</span>
          <code>{roomKey}</code>
        </div>
      </div>
    </RoomShell>
  );
}
