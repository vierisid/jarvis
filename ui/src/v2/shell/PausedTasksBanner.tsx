import React, { useCallback, useState } from "react";
import { ChevronDown, ChevronUp, HelpCircle, MessageSquare } from "lucide-react";
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
 * Each item has a "Reply in chat" button that focuses the composer; the
 * conv LLM picks up the paused task from its registry context and calls
 * resume_task once the user sends their answer.
 */
export function PausedTasksBanner() {
  const { taskEvents } = useLiveData();
  const { tasks } = usePausedTasks(taskEvents);
  const [collapsed, setCollapsed] = useState(false);

  // Focus the chat composer. We use a DOM selector rather than threading a
  // ref through the shell because the composer class is a stable contract
  // of the v2 shell layout; lifting state for one button isn't worth it.
  const focusComposer = useCallback(() => {
    const el = document.querySelector<HTMLTextAreaElement>(".v2-composer__input");
    if (el) {
      el.focus();
      el.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, []);

  if (tasks.length === 0) return null;

  const headline = tasks.length === 1
    ? "1 pending question"
    : `${tasks.length} pending questions`;

  return (
    <div className="v2-paused">
      <button
        type="button"
        className="v2-paused__head"
        onClick={() => setCollapsed((c) => !c)}
        aria-expanded={!collapsed}
        title={collapsed ? "Expand pending questions" : "Collapse"}
      >
        <span className="v2-paused__head-icon">
          <Icon icon={HelpCircle} size="sm" />
        </span>
        {/* Scope aria-live to the headline - announces when the count
            changes (a new task pauses) without firing on every collapse. */}
        <span className="v2-paused__headline" role="status" aria-live="polite">
          {headline}
        </span>
        <span className="v2-paused__sub">awaiting your reply in chat</span>
        <Icon icon={collapsed ? ChevronDown : ChevronUp} size="sm" />
      </button>
      {!collapsed && (
        <ul className="v2-paused__list">
          {tasks.map((t) => (
            <li key={t.id} className="v2-paused__item">
              <div className="v2-paused__item-body">
                <div className="v2-paused__q">{t.question || "(no question text)"}</div>
                <div className="v2-paused__meta">
                  <span className="v2-paused__tag">{t.template}</span>
                  <span className="v2-paused__intent" title={t.intent}>{t.intent}</span>
                </div>
              </div>
              <button
                type="button"
                className="v2-paused__reply"
                onClick={focusComposer}
                title="Focus the chat composer to reply"
              >
                <Icon icon={MessageSquare} size="sm" />
                Reply in chat
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
