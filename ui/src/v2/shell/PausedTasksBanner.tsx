import React, { useState } from "react";
import { HelpCircle, ChevronDown, ChevronUp } from "lucide-react";
import { Icon } from "../ui";
import { useLiveData } from "./LiveDataContext";
import { usePausedTasks } from "./usePausedTasks";
import "./PausedTasksBanner.css";

/**
 * Banner mounted at the top of the AppShell that lists conv-tier tasks
 * paused awaiting user clarification.
 *
 * The user-visible payoff of task durability: tasks that paused before a
 * daemon restart land back here on reconnect, so the user knows there's a
 * pending question rather than a silent dropped thread. Empty state renders
 * nothing - the banner only takes space when it has something to say.
 *
 * The user answers by typing in the regular chat input; the conv LLM picks
 * up the paused task from its registry context and calls resume_task.
 */
export function PausedTasksBanner() {
  const { taskEvents } = useLiveData();
  const { tasks } = usePausedTasks(taskEvents);
  const [collapsed, setCollapsed] = useState(false);

  if (tasks.length === 0) return null;

  const headline = tasks.length === 1
    ? "1 pending question"
    : `${tasks.length} pending questions`;

  return (
    <div className="v2-paused" role="status" aria-live="polite">
      <button
        type="button"
        className="v2-paused__head"
        onClick={() => setCollapsed((c) => !c)}
        aria-expanded={!collapsed}
        title={collapsed ? "Expand pending questions" : "Collapse"}
      >
        <Icon icon={HelpCircle} size="sm" />
        <span className="v2-paused__headline">{headline}</span>
        <span className="v2-paused__sub">awaiting your reply in chat</span>
        <Icon icon={collapsed ? ChevronDown : ChevronUp} size="sm" />
      </button>
      {!collapsed && (
        <ul className="v2-paused__list">
          {tasks.map((t) => (
            <li key={t.id} className="v2-paused__item">
              <div className="v2-paused__q">{t.question || "(no question text)"}</div>
              <div className="v2-paused__meta">
                <span className="v2-paused__tag">{t.template}</span>
                <span className="v2-paused__intent" title={t.intent}>{t.intent}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
