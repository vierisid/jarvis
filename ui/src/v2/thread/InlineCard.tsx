import React from "react";
import {
  ArrowUpRight,
  BarChart3,
  BookMarked,
  Calendar,
  CheckSquare,
  Code2,
  Eye,
  FileText,
  Settings,
  Shield,
  Target,
  Terminal,
  UserCircle2,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { Button, Chip, Icon } from "../ui";
import type { ObjectType } from "./types";
import "./InlineCard.css";

const TYPE_ICON: Record<ObjectType, LucideIcon> = {
  workflow: Workflow,
  memory: BookMarked,
  tool: Terminal,
  agent: UserCircle2,
  authority: Shield,
  log: Eye,
  calendar: Calendar,
  goals: Target,
  tasks: CheckSquare,
  content: FileText,
  workspaces: Code2,
  usage: BarChart3,
  settings: Settings,
};

const TYPE_LABEL: Record<ObjectType, string> = {
  workflow: "Workflow",
  memory: "Memory",
  tool: "Tool",
  agent: "Agent",
  authority: "Authority",
  log: "Log",
  calendar: "Calendar",
  goals: "Goals",
  tasks: "Tasks",
  content: "Content",
  workspaces: "Workspaces",
  usage: "Usage",
  settings: "Settings",
};

export interface InlineCardProps {
  objectType: ObjectType;
  title: string;
  summary?: string;
  meta?: string;
  status?: { label: string; tone: "ok" | "warn" | "neutral" | "accent" };
  onFocus?: () => void;
}

/**
 * InlineCard — object preview rendered in the thread.
 * Focus → expands into a fullscreen Room (Phase 6).
 */
export function InlineCard({
  objectType,
  title,
  summary,
  meta,
  status,
  onFocus,
}: InlineCardProps) {
  const IconForType = TYPE_ICON[objectType];
  return (
    <article className="v2-card" aria-label={`${TYPE_LABEL[objectType]}: ${title}`}>
      <div className="v2-card__icon">
        <Icon icon={IconForType} size="md" />
      </div>

      <div className="v2-card__body">
        <div className="v2-card__head">
          <span className="v2-card__type">{TYPE_LABEL[objectType]}</span>
          <h3 className="v2-card__title">{title}</h3>
          {status && (
            <Chip tone={status.tone}>{status.label}</Chip>
          )}
        </div>
        {summary && <p className="v2-card__summary">{summary}</p>}
        {meta && (
          <div className="v2-card__meta">
            <span className="v2-card__meta-text">{meta}</span>
          </div>
        )}
      </div>

      <div className="v2-card__actions">
        <Button variant="ghost" size="sm" onClick={onFocus} aria-label="Focus — open in room">
          Focus
          <Icon icon={ArrowUpRight} size="sm" />
        </Button>
      </div>
    </article>
  );
}
